// Ingestion parsing pipeline: text extraction (pdf/docx/md/txt), digit
// normalization, deterministic segmentation, per-segment LLM structuring.
// Port of backend/app/modules/ingestion.py (TRD §4.1, FR-REQ).
package ingestion

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"

	"traceo/internal/llm"
)

const (
	maxSegments     = 500
	minSegmentChars = 15
)

var requirementTypes = map[string]bool{
	"functional": true, "business_rule": true, "data": true,
	"interface": true, "non_functional": true,
}

// sortedTypesRepr mirrors Python's f"{sorted(REQUIREMENT_TYPES)}" in error messages.
const sortedTypesRepr = "['business_rule', 'data', 'functional', 'interface', 'non_functional']"

// extractPrompt/extractPromptSuffix frame the uploaded document segment as
// untrusted DATA (prompt-injection hardening): the segment text is sandwiched
// between llm.UntrustedOpen/Close after an explicit "data, not instructions"
// note. The "SEGMENT:\n" sentinel the deterministic mock splits on is unchanged
// and stays immediately before the text; the mock strips the closing delimiter,
// so mock output is byte-identical to the unframed prompt.
const extractPrompt = "Extract the software requirement from this segment. " +
	"Preserve the original language.\n" + llm.UntrustedNote + llm.UntrustedOpen +
	"\nSEGMENT:\n"

const extractPromptSuffix = "\n" + llm.UntrustedClose

var extractSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"external_id":         map[string]any{"type": "string"},
		"description":         map[string]any{"type": "string"},
		"acceptance_criteria": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"type":                map[string]any{"enum": []any{"business_rule", "data", "functional", "interface", "non_functional"}},
		"priority":            map[string]any{"type": "string"},
		"confidence":          map[string]any{"type": "number"},
	},
	"required": []any{"external_id", "description", "acceptance_criteria",
		"type", "priority", "confidence"},
}

// --- deterministic text utilities -------------------------------------------------

// normalizeDigits maps Arabic-Indic (U+0660-0669) and Extended Arabic-Indic
// (U+06F0-06F9) digits to ASCII.
func normalizeDigits(text string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 0x0660 && r <= 0x0669:
			return '0' + (r - 0x0660)
		case r >= 0x06F0 && r <= 0x06F9:
			return '0' + (r - 0x06F0)
		}
		return r
	}, text)
}

// Requirement-ID openers: REQ-1 / FR-01 / BR_2 / NFR 3 / numbered clauses "3.1.2"
var (
	reqIDLine = regexp.MustCompile(`(?i)^\s*(?:(?:REQ|FR|BR|NFR|UC|SRS|BUS)[-_ ]?\d+(?:[.-]\d+)*|\d+(?:\.\d+)+)\b[.:)\-–—]?`)
	headingRe = regexp.MustCompile(`^\s*#{1,6}\s+\S`)
	bulletRe  = regexp.MustCompile(`^\s*(?:[-*•▪◦]|\d+[.)]|[a-h][.)])\s+\S`)
)

func contentHash(description string, criteria []string) string {
	payload := description + "\n" + strings.Join(criteria, "\n")
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// --- text extraction ---------------------------------------------------------------

// pageText is one (page_number, text) tuple; Page==nil when the page is unknowable.
type pageText struct {
	Page *int
	Text string
}

func extractText(path, ext string) ([]pageText, error) {
	switch ext {
	case ".pdf":
		return extractPDF(path)
	case ".docx":
		return extractDOCX(path)
	case ".md", ".txt":
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return []pageText{{Page: nil, Text: string(raw)}}, nil
	}
	return nil, fmt.Errorf("Unsupported file extension '%s'", ext)
}

func extractPDF(path string) (pages []pageText, err error) {
	// The pdf library panics on some malformed files — degrade to a parse failure.
	defer func() {
		if r := recover(); r != nil {
			pages, err = nil, fmt.Errorf("PDF parsing failed: %v", r)
		}
	}()
	f, reader, err := pdf.Open(path)
	if err != nil {
		return nil, fmt.Errorf("PDF parsing failed: %v", err)
	}
	defer f.Close()
	for i := 1; i <= reader.NumPage(); i++ {
		n := i
		page := reader.Page(i)
		text := ""
		if !page.V.IsNull() {
			t, perr := page.GetPlainText(nil)
			if perr != nil {
				return nil, fmt.Errorf("PDF parsing failed on page %d: %v", i, perr)
			}
			text = t
		}
		pages = append(pages, pageText{Page: &n, Text: text})
	}
	return pages, nil
}

// docx paragraph/run XML shapes (word/document.xml, w: namespace).
func extractDOCX(path string) ([]pageText, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("DOCX parsing failed: %v", err)
	}
	defer zr.Close()
	var docXML io.ReadCloser
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			docXML, err = f.Open()
			if err != nil {
				return nil, fmt.Errorf("DOCX parsing failed: %v", err)
			}
			break
		}
	}
	if docXML == nil {
		return nil, fmt.Errorf("DOCX parsing failed: word/document.xml not found")
	}
	defer docXML.Close()

	dec := xml.NewDecoder(docXML)
	var parts []string
	var cur strings.Builder
	inPara, inText := false, false
	for {
		tok, terr := dec.Token()
		if terr == io.EOF {
			break
		}
		if terr != nil {
			return nil, fmt.Errorf("DOCX parsing failed: %v", terr)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				inPara = true
				cur.Reset()
			case "t":
				inText = true
			case "tab":
				if inPara {
					cur.WriteString("\t")
				}
			case "br", "cr":
				if inPara {
					cur.WriteString("\n")
				}
			}
		case xml.CharData:
			if inText {
				cur.Write([]byte(t))
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "p":
				if inPara {
					parts = append(parts, cur.String())
					cur.Reset()
				}
				inPara = false
			}
		}
	}
	return []pageText{{Page: nil, Text: strings.Join(parts, "\n")}}, nil
}

// --- deterministic segmentation ----------------------------------------------------

type segment struct {
	Text string
	Page *int
}

// segmentPages splits extracted text into candidate requirement segments.
// Boundaries: requirement-ID lines, markdown headings, blank-line paragraph breaks.
// A requirement line keeps its following bullet lines attached, even across single
// blank lines. Segments < minSegmentChars are skipped; capped at maxSegments.
func segmentPages(pages []pageText) []segment {
	var segments []segment
	var curLines []string
	var curPage *int

	flush := func() {
		text := strings.TrimSpace(strings.Join(curLines, "\n"))
		if utf8.RuneCountInString(text) >= minSegmentChars {
			segments = append(segments, segment{Text: text, Page: curPage})
		}
		curLines = nil
	}

	pendingBlank := false
	for _, pt := range pages {
		pageNo := pt.Page
		text := strings.ReplaceAll(strings.ReplaceAll(pt.Text, "\r\n", "\n"), "\r", "\n")
		for _, raw := range strings.Split(text, "\n") {
			line := strings.TrimRightFunc(raw, unicode.IsSpace)
			if strings.TrimSpace(line) == "" {
				pendingBlank = true
				continue
			}
			isReq := reqIDLine.MatchString(line)
			isHeading := headingRe.MatchString(line)
			isBullet := !isReq && bulletRe.MatchString(line)
			switch {
			case isReq || isHeading:
				flush()
				curPage = pageNo
				curLines = []string{line}
			case isBullet && len(curLines) > 0:
				// acceptance-criteria bullets stay grouped with their requirement line
				curLines = append(curLines, line)
			case pendingBlank && len(curLines) > 0:
				flush()
				curPage = pageNo
				curLines = []string{line}
			default:
				if len(curLines) == 0 {
					curPage = pageNo
				}
				curLines = append(curLines, line)
			}
			pendingBlank = false
		}
	}
	flush()
	if len(segments) > maxSegments {
		segments = segments[:maxSegments]
	}
	return segments
}

// --- LLM structuring (per-segment, failure-isolated) --------------------------------

type extraction struct {
	ExternalID         string
	Description        string
	AcceptanceCriteria []string
	Type               string
	Priority           string
	Confidence         float64
}

// structureSegment makes one LLM call per segment. A failing segment degrades to a
// raw-text requirement with confidence 0.3 — it is never silently dropped.
func structureSegment(provider llm.Provider, segmentText string) extraction {
	result, err := provider.CompleteJSON("extract_requirement",
		extractPrompt+segmentText+extractPromptSuffix, extractSchema)
	if err != nil {
		return extraction{
			ExternalID:         "",
			Description:        truncRunes(segmentText, 2000),
			AcceptanceCriteria: []string{},
			Type:               "functional",
			Priority:           "medium",
			Confidence:         0.3,
		}
	}
	data := result.Data
	out := extraction{}
	out.ExternalID = strings.TrimSpace(anyToStr(data["external_id"]))
	out.Description = strings.TrimSpace(anyToStr(data["description"]))
	if out.Description == "" {
		out.Description = truncRunes(segmentText, 2000)
	}
	out.AcceptanceCriteria = toStrList(data["acceptance_criteria"])
	if t, _ := data["type"].(string); requirementTypes[t] {
		out.Type = t
	} else {
		out.Type = "functional"
	}
	out.Priority = anyToStr(data["priority"])
	if out.Priority == "" {
		out.Priority = "medium"
	}
	out.Confidence = clamp01(toFloat(data["confidence"], 0.5))
	return out
}

func anyToStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'g', -1, 64)
	default:
		return fmt.Sprint(t)
	}
}

func toStrList(v any) []string {
	out := []string{}
	if list, ok := v.([]any); ok {
		for _, c := range list {
			out = append(out, anyToStr(c))
		}
	}
	return out
}

func toFloat(v any, def float64) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case string:
		if f, err := strconv.ParseFloat(t, 64); err == nil {
			return f
		}
	}
	return def
}

func clamp01(f float64) float64 {
	if f < 0 {
		return 0
	}
	if f > 1 {
		return 1
	}
	return f
}
