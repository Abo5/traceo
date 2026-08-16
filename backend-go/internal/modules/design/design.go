package design

import (
	"fmt"
	"image/png"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
)

// numberList renders a list of measurements the way the Python module does —
// "[7, 2, 65]" — so a spacing statement is the SAME string in both backends.
// Go's default %v prints "[7 2 65]", which would fork the requirement text and
// the case titles the two backends persist for one identical screenshot.
// Accepts the in-process []int and the []any a JSON round-trip produces.
func numberList(v any) string {
	var parts []string
	switch xs := v.(type) {
	case []int:
		parts = make([]string, len(xs))
		for i, x := range xs {
			parts[i] = strconv.Itoa(x)
		}
	case []any:
		parts = make([]string, len(xs))
		for i, x := range xs {
			if n, ok := x.(float64); ok && n == math.Trunc(n) {
				parts[i] = strconv.FormatInt(int64(n), 10)
			} else {
				parts[i] = fmt.Sprintf("%v", x)
			}
		}
	default:
		return fmt.Sprintf("%v", v)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// Image is an RGB raster; Pix is row-major, one colour per pixel.
type Image struct {
	Width  int
	Height int
	Pix    []RGB
}

func (im Image) At(x, y int) RGB { return im.Pix[y*im.Width+x] }

// DecodePNG reads a PNG into an RGB raster, compositing transparency over the
// stated background. A comparison needs a colour per pixel, not a colour and a
// maybe, and the choice of background changes every colour that follows it —
// so it is a parameter, never an assumption.
func DecodePNG(path string, background RGB) (Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return Image{}, err
	}
	defer f.Close()
	src, err := png.Decode(f)
	if err != nil {
		return Image{}, err
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return Image{}, fmt.Errorf("png has no pixels")
	}
	pix := make([]RGB, 0, w*h)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r16, g16, b16, a16 := src.At(x, y).RGBA() // alpha-premultiplied, 16-bit
			if a16 == 0 {
				pix = append(pix, background)
				continue
			}
			// undo premultiplication, then composite over the background
			r := float64(r16) / float64(a16) * 255.0
			g := float64(g16) / float64(a16) * 255.0
			bl := float64(b16) / float64(a16) * 255.0
			alpha := float64(a16) / 65535.0
			comp := func(c float64, bg int) int {
				v := int(math.Round(c*alpha + float64(bg)*(1.0-alpha)))
				if v < 0 {
					return 0
				}
				if v > 255 {
					return 255
				}
				return v
			}
			pix = append(pix, RGB{comp(r, background[0]), comp(g, background[1]),
				comp(bl, background[2])})
		}
	}
	return Image{Width: w, Height: h, Pix: pix}, nil
}

// --- palette and roles ------------------------------------------------------

// Role classifies one significant colour as a surface or an ink, and pairs ink
// with the surface it is actually read against.
type Role struct {
	Colour     RGB
	Pixels     int
	Share      float64
	SolidRatio float64 // fraction of this colour's pixels whose 4 neighbours match
	Kind       string  // "surface" | "ink"
	OnSurface  *RGB    // for ink: the surface underneath
	Contrast   *float64
}

// PassesAA reports WCAG 2.x AA: 4.5:1 for body text, 3:1 for large text.
func (r Role) PassesAA(large bool) (bool, bool) {
	if r.Contrast == nil {
		return false, false
	}
	target := 4.5
	if large {
		target = 3.0
	}
	return *r.Contrast >= target, true
}

// Roles classifies each significant colour and pairs every ink with its surface.
//
// A surface is a colour whose pixels are mostly interior — its four neighbours
// are the same colour. Glyph strokes and icon lines are thin, so most of their
// pixels touch something else; that single ratio separates the two without any
// model, and it is a property of the raster, so it is reproducible exactly.
func Roles(img Image, minShare, solidCut float64) []Role {
	total := img.Width * img.Height
	if total == 0 {
		return nil
	}
	counts := map[RGB]int{}
	for _, c := range img.Pix {
		counts[c]++
	}
	significant := map[RGB]bool{}
	for c, n := range counts {
		if float64(n)/float64(total) >= minShare {
			significant[c] = true
		}
	}
	solid := map[RGB]int{}
	neighbours := map[RGB]map[RGB]int{}
	for c := range significant {
		neighbours[c] = map[RGB]int{}
	}
	w, h := img.Width, img.Height
	for y := 0; y < h; y++ {
		row := y * w
		for x := 0; x < w; x++ {
			c := img.Pix[row+x]
			if !significant[c] {
				continue
			}
			same := true
			for _, d := range [4][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}} {
				nx, ny := x+d[0], y+d[1]
				if nx >= 0 && nx < w && ny >= 0 && ny < h {
					n := img.Pix[ny*w+nx]
					if n != c {
						same = false
						neighbours[c][n]++
					}
				} else {
					same = false
				}
			}
			if same {
				solid[c]++
			}
		}
	}
	ratios := map[RGB]float64{}
	surfaces := map[RGB]bool{}
	for c := range significant {
		ratios[c] = float64(solid[c]) / float64(counts[c])
		if ratios[c] >= solidCut {
			surfaces[c] = true
		}
	}
	ordered := make([]RGB, 0, len(significant))
	for c := range significant {
		ordered = append(ordered, c)
	}
	// Most frequent first; ties broken by colour so the output is stable.
	sort.Slice(ordered, func(i, j int) bool {
		if counts[ordered[i]] != counts[ordered[j]] {
			return counts[ordered[i]] > counts[ordered[j]]
		}
		return less(ordered[i], ordered[j])
	})

	out := make([]Role, 0, len(ordered))
	for _, c := range ordered {
		share := float64(counts[c]) / float64(total)
		if surfaces[c] {
			out = append(out, Role{c, counts[c], share, ratios[c], "surface", nil, nil})
			continue
		}
		// the surface underneath is the most frequent surface colour adjacent to
		// this colour's pixels — the background it is actually read against
		var under *RGB
		bestCount := -1
		for cand, n := range neighbours[c] {
			if !surfaces[cand] {
				continue
			}
			if n > bestCount || (n == bestCount && under != nil && less(cand, *under)) {
				cc := cand
				under = &cc
				bestCount = n
			}
		}
		role := Role{c, counts[c], share, ratios[c], "ink", under, nil}
		if under != nil {
			ratio := ContrastRatio(c, *under)
			role.Contrast = &ratio
		}
		out = append(out, role)
	}
	return out
}

func less(a, b RGB) bool {
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// TextInks returns the ink colours that are a colour in their own right rather
// than a rendering artefact: every entry is a colour somebody chose, paired with
// the surface it is read on and its exact WCAG ratio.
func TextInks(img Image, minShare, blendTolerance float64) []Role {
	all := Roles(img, minShare, 0.6)
	var surfaces []RGB
	var inks []Role
	for _, r := range all {
		if r.Kind == "surface" {
			surfaces = append(surfaces, r.Colour)
		} else if r.OnSurface != nil {
			inks = append(inks, r)
		}
	}
	standalone := make([]RGB, 0, len(inks))
	for _, r := range inks {
		standalone = append(standalone, r.Colour)
	}
	out := make([]Role, 0, len(inks))
	for _, r := range inks {
		others := make([]RGB, 0, len(standalone)+len(surfaces))
		for _, c := range append(append([]RGB{}, standalone...), surfaces...) {
			if c != r.Colour {
				others = append(others, c)
			}
		}
		if _, blended := IsBlend(r.Colour, *r.OnSurface, others, blendTolerance, 32); !blended {
			out = append(out, r)
		}
	}
	return out
}

// --- structure --------------------------------------------------------------

// Region is a maximal connected run of one exact colour — a fill, a bar, a card.
type Region struct {
	Colour RGB
	X, Y   int
	Width  int
	Height int
	Pixels int
}

func (r Region) FillRatio() float64 {
	area := r.Width * r.Height
	if area == 0 {
		return 0
	}
	return float64(r.Pixels) / float64(area)
}

// Regions returns the connected components of identical colour, largest first.
// This is the part of a design rasterisation cannot smear: a flat fill is the
// same bytes in Figma and in Chrome. Antialiased borders form their own thin
// components and fall below minPixels, which is why these boxes are stable
// across renderers.
func Regions(img Image, minPixels int) []Region {
	w, h := img.Width, img.Height
	seen := make([]bool, w*h)
	var out []Region
	stack := make([]int, 0, 64)
	for start := 0; start < w*h; start++ {
		if seen[start] {
			continue
		}
		colour := img.Pix[start]
		stack = stack[:0]
		stack = append(stack, start)
		seen[start] = true
		minx, maxx := start%w, start%w
		miny, maxy := start/w, start/w
		count := 0
		for len(stack) > 0 {
			idx := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			count++
			x, y := idx%w, idx/w
			if x < minx {
				minx = x
			}
			if x > maxx {
				maxx = x
			}
			if y < miny {
				miny = y
			}
			if y > maxy {
				maxy = y
			}
			for _, d := range [4][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}} {
				nx, ny := x+d[0], y+d[1]
				if nx >= 0 && nx < w && ny >= 0 && ny < h {
					n := ny*w + nx
					if !seen[n] && img.Pix[n] == colour {
						seen[n] = true
						stack = append(stack, n)
					}
				}
			}
		}
		if count >= minPixels {
			out = append(out, Region{colour, minx, miny, maxx - minx + 1, maxy - miny + 1, count})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Pixels != out[j].Pixels {
			return out[i].Pixels > out[j].Pixels
		}
		if out[i].Y != out[j].Y {
			return out[i].Y < out[j].Y
		}
		return out[i].X < out[j].X
	})
	return out
}

// Profile holds per-row and per-column edge strength — the layout rhythm as
// numbers. columns[x] counts the rows in which column x differs from x-1.
type Profile struct {
	Rows    []int
	Columns []int
}

// Gridlines returns the indices whose change count exceeds threshold x the
// maximum: a boundary between two flat areas shows up as a spike. A 1px divider
// produces an edge on each side, so adjacent hits are merged and the boundary is
// reported once — otherwise every measured gap alternates between the rule and
// its width.
func (p Profile) Gridlines(axis string, threshold float64) []int {
	series := p.Columns
	if axis == "row" {
		series = p.Rows
	}
	if len(series) == 0 {
		return nil
	}
	peak := 0
	for _, v := range series {
		if v > peak {
			peak = v
		}
	}
	if peak == 0 {
		return nil
	}
	cut := float64(peak) * threshold
	var merged []int
	for i, v := range series {
		if float64(v) < cut {
			continue
		}
		if len(merged) == 0 || i-merged[len(merged)-1] > 1 {
			merged = append(merged, i)
		}
	}
	return merged
}

// ProjectionProfile measures edge strength per column and per row. Counting
// changes ALONG a line instead would score a solid divider at zero — the line is
// uniform; the edge is beside it, not within it.
func ProjectionProfile(img Image) Profile {
	w, h := img.Width, img.Height
	cols := make([]int, w)
	for x := 1; x < w; x++ {
		n := 0
		for y := 0; y < h; y++ {
			if img.At(x, y) != img.At(x-1, y) {
				n++
			}
		}
		cols[x] = n
	}
	rows := make([]int, h)
	for y := 1; y < h; y++ {
		n := 0
		for x := 0; x < w; x++ {
			if img.At(x, y) != img.At(x, y-1) {
				n++
			}
		}
		rows[y] = n
	}
	return Profile{Rows: rows, Columns: cols}
}

// Spacing returns the gaps between consecutive gridlines — the spacing scale.
func Spacing(gridlines []int) []int {
	if len(gridlines) < 2 {
		return nil
	}
	out := make([]int, 0, len(gridlines)-1)
	for i := 1; i < len(gridlines); i++ {
		out = append(out, gridlines[i]-gridlines[i-1])
	}
	return out
}

// --- design facts -----------------------------------------------------------

// Fact is one checkable statement derived from a design, with its evidence.
type Fact struct {
	Kind      string // palette | surface | element | alignment | spacing | contrast
	Subject   string // a stable identifier: "#F0903F", "480,916"
	Statement string // human-readable, for the requirement text
	Value     map[string]any
	Evidence  []int // box in the design, or nil
}

// ID is the fact's stable reference — the id a UI case must cite.
func (f Fact) ID() string { return f.Kind + ":" + f.Subject }

// DesignFacts extracts everything this rendering states that a test can check:
// the palette and its roles, the elements as boxes, their shared edges, the
// spacing rhythm, and the contrast of every real ink. What it cannot state from
// pixels alone is MEANING — that the orange box is the submit button — which is
// why nothing here claims it (docs/DESIGN_AS_REQUIREMENT_SOURCE.md).
func DesignFacts(img Image) []Fact {
	const (
		minShare        = 0.002
		minElementPix   = 400
		alignThreshold  = 0.35
		blendTolerance  = 1.5
		solidCut        = 0.6
		inkShareDivisor = 10.0
	)
	var facts []Fact
	if img.Width == 0 || img.Height == 0 {
		return facts
	}

	roleList := Roles(img, minShare, solidCut)
	var surfaces []Role
	for _, r := range roleList {
		if r.Kind == "surface" {
			surfaces = append(surfaces, r)
		}
	}
	facts = append(facts, Fact{
		Kind: "palette", Subject: "count",
		Statement: fmt.Sprintf("the design uses %d surface colours above %.1f%% of the canvas",
			len(surfaces), minShare*100),
		Value: map[string]any{"count": len(surfaces)},
	})
	for _, r := range surfaces {
		facts = append(facts, Fact{
			Kind: "surface", Subject: r.Colour.Hex(),
			Statement: fmt.Sprintf("%s covers %.2f%% of the screen", r.Colour.Hex(), r.Share*100),
			Value:     map[string]any{"colour": []int{r.Colour[0], r.Colour[1], r.Colour[2]}, "share": r.Share},
		})
	}
	for _, ink := range TextInks(img, minShare/inkShareDivisor, blendTolerance) {
		if ink.Contrast == nil || ink.OnSurface == nil {
			continue
		}
		passAA, _ := ink.PassesAA(false)
		passLarge, _ := ink.PassesAA(true)
		facts = append(facts, Fact{
			Kind:    "contrast",
			Subject: ink.Colour.Hex() + "_on_" + ink.OnSurface.Hex(),
			Statement: fmt.Sprintf("%s on %s has a contrast ratio of %.2f:1",
				ink.Colour.Hex(), ink.OnSurface.Hex(), *ink.Contrast),
			Value: map[string]any{"ratio": *ink.Contrast, "passes_aa": passAA,
				"passes_aa_large": passLarge},
		})
	}

	var page *RGB
	if len(surfaces) > 0 {
		c := surfaces[0].Colour
		page = &c
	}
	var elements []Region
	for _, r := range Regions(img, minElementPix) {
		if page != nil && r.Colour == *page {
			continue
		}
		elements = append(elements, r)
	}
	for _, el := range elements {
		facts = append(facts, Fact{
			Kind: "element", Subject: fmt.Sprintf("%d,%d", el.X, el.Y),
			Statement: fmt.Sprintf("an element of %s occupies %dx%d at (%d,%d)",
				el.Colour.Hex(), el.Width, el.Height, el.X, el.Y),
			Value: map[string]any{
				"colour":     []int{el.Colour[0], el.Colour[1], el.Colour[2]},
				"box":        []int{el.X, el.Y, el.Width, el.Height},
				"fill_ratio": el.FillRatio()},
			Evidence: []int{el.X, el.Y, el.Width, el.Height},
		})
	}

	// Shared edges are the design's alignment decisions, stated as integers.
	for _, axis := range []string{"left", "top"} {
		shared := map[int]int{}
		for _, el := range elements {
			if axis == "left" {
				shared[el.X]++
			} else {
				shared[el.Y]++
			}
		}
		coords := make([]int, 0, len(shared))
		for c := range shared {
			coords = append(coords, c)
		}
		sort.Ints(coords)
		for _, coord := range coords {
			if shared[coord] < 2 {
				continue
			}
			facts = append(facts, Fact{
				Kind: "alignment", Subject: fmt.Sprintf("%s@%d", axis, coord),
				Statement: fmt.Sprintf("%d elements share a %s edge at %dpx",
					shared[coord], axis, coord),
				Value: map[string]any{"axis": axis, "coordinate": coord,
					"elements": shared[coord]},
			})
		}
	}

	prof := ProjectionProfile(img)
	for _, axis := range []string{"row", "column"} {
		gaps := Spacing(prof.Gridlines(axis, alignThreshold))
		if len(gaps) == 0 {
			continue
		}
		facts = append(facts, Fact{
			Kind: "spacing", Subject: axis,
			Statement: fmt.Sprintf("the %s rhythm is %spx", axis, numberList(gaps)),
			Value:     map[string]any{"axis": axis, "gaps": gaps},
		})
	}
	return facts
}

// --- UI cases ---------------------------------------------------------------

// UICase is a deterministic case derived from ONE design fact. Shape matches the
// API generator's cases so review, approval and traceability treat them alike;
// FactID is what makes the case auditable back to the design rather than to an
// opinion.
type UICase struct {
	Title         string
	Description   string
	Preconditions string
	Type          string // positive | negative
	Priority      string
	Technique     string // design | a11y
	Check         string
	FactID        string
	Screen        string
	Expected      map[string]any
	Evidence      []int
}

// UICases builds the cases a set of design facts can ground. A case whose fact
// is not in the inventory is not built — the grounding rule, applied to pixels
// instead of endpoints.
//
// A contrast fact that already FAILS becomes a case too. It will fail on the
// first run, and that is correct: the design itself is the defect, and a suite
// that quietly omitted it would be certifying an inaccessible screen.
func UICases(facts []Fact, screen string) []UICase {
	const (
		boxTolerance   = 2
		shareTolerance = 0.02
	)
	var cases []UICase
	mk := func(title, check, technique, ctype string, fact Fact, expected map[string]any,
		priority string) UICase {
		return UICase{
			Title:         truncate(title, 500),
			Description:   "Derived from the design: " + fact.Statement,
			Preconditions: "The " + screen + " is rendered at the design viewport",
			Type:          ctype, Priority: priority, Technique: technique,
			Check: check, FactID: fact.ID(), Screen: screen,
			Expected: expected, Evidence: fact.Evidence,
		}
	}

	var surfaces []Fact
	for _, f := range facts {
		if f.Kind == "surface" {
			surfaces = append(surfaces, f)
		}
	}
	for _, f := range surfaces {
		colour := f.Value["colour"]
		share, _ := f.Value["share"].(float64)
		cases = append(cases,
			mk("Design: surface "+f.Subject+" is present", "surface_present", "design",
				"positive", f, map[string]any{"colour": colour}, "medium"),
			mk(fmt.Sprintf("Design: surface %s covers ~%.1f%% of the screen", f.Subject, share*100),
				"surface_share", "design", "positive", f,
				map[string]any{"colour": colour, "share": share, "tolerance": shareTolerance},
				"medium"))
	}
	if len(surfaces) > 0 {
		for _, f := range facts {
			if f.Kind != "palette" {
				continue
			}
			allowed := make([]any, 0, len(surfaces))
			for _, s := range surfaces {
				allowed = append(allowed, s.Value["colour"])
			}
			cases = append(cases, mk("Design: no surface colour outside the design palette appears",
				"palette_closed", "design", "negative", f,
				map[string]any{"allowed": allowed}, "high"))
			break
		}
	}
	for _, f := range facts {
		if f.Kind != "element" {
			continue
		}
		box, _ := f.Value["box"].([]int)
		if len(box) != 4 {
			continue
		}
		colour := f.Value["colour"]
		hex := RGB{}
		if c, ok := f.Value["colour"].([]int); ok && len(c) == 3 {
			hex = RGB{c[0], c[1], c[2]}
		}
		cases = append(cases,
			mk(fmt.Sprintf("Design: element %s exists at (%d,%d)", hex.Hex(), box[0], box[1]),
				"element_present", "design", "positive", f,
				map[string]any{"colour": colour, "min_pixels": f.Value["fill_ratio"]}, "medium"),
			mk(fmt.Sprintf("Design: element at (%d,%d) measures %dx%d", box[0], box[1], box[2], box[3]),
				"element_box", "design", "positive", f,
				map[string]any{"box": box, "tolerance": boxTolerance}, "medium"))
	}
	for _, f := range facts {
		if f.Kind != "contrast" {
			continue
		}
		passes, _ := f.Value["passes_aa"].(bool)
		ctype, priority := "positive", "medium"
		if !passes {
			ctype, priority = "negative", "high"
		}
		cases = append(cases, mk(
			"Accessibility: "+replaceOn(f.Subject)+" meets WCAG AA",
			"contrast_aa", "a11y", ctype, f,
			map[string]any{"min_ratio": 4.5, "measured_in_design": f.Value["ratio"]}, priority))
	}
	for _, f := range facts {
		if f.Kind != "alignment" {
			continue
		}
		cases = append(cases, mk(
			fmt.Sprintf("Design: %v elements share a %v edge at %vpx",
				f.Value["elements"], f.Value["axis"], f.Value["coordinate"]),
			"alignment", "design", "positive", f,
			map[string]any{"axis": f.Value["axis"], "coordinate": f.Value["coordinate"],
				"elements": f.Value["elements"], "tolerance": boxTolerance}, "medium"))
	}
	for _, f := range facts {
		if f.Kind != "spacing" {
			continue
		}
		cases = append(cases, mk(
			fmt.Sprintf("Design: the %v rhythm is %spx", f.Value["axis"], numberList(f.Value["gaps"])),
			"spacing", "design", "positive", f,
			map[string]any{"axis": f.Value["axis"], "gaps": f.Value["gaps"],
				"tolerance": boxTolerance}, "medium"))
	}
	return cases
}

func replaceOn(subject string) string {
	for i := 0; i+4 <= len(subject); i++ {
		if subject[i:i+4] == "_on_" {
			return subject[:i] + " on " + subject[i+4:]
		}
	}
	return subject
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// --- analysis raster --------------------------------------------------------

// RasterNote records how the analysed raster was derived from the screenshot.
type RasterNote struct {
	SourceWidth    int  `json:"source_width"`
	SourceHeight   int  `json:"source_height"`
	AnalysedWidth  int  `json:"analysed_width"`
	AnalysedHeight int  `json:"analysed_height"`
	Cropped        bool `json:"cropped"`
	SampleStep     int  `json:"sample_step"`
}

// FitForAnalysis returns the raster the engine analyses, and how it got there.
//
// Two reductions, both stated rather than hidden: the full-page screenshot is
// CROPPED to the viewport, because the facts are statements about the screen and
// a 6000px-tall page would otherwise report the footer's palette share as the
// screen's; and if that is still over the pixel budget it is SUBSAMPLED by an
// integer step with nearest neighbour, never averaged — averaging would invent
// colours the page never painted, and the palette would become a claim about the
// resampler.
func FitForAnalysis(img Image, viewportHeight, maxPixels int) (Image, RasterNote) {
	note := RasterNote{SourceWidth: img.Width, SourceHeight: img.Height, SampleStep: 1}
	width, height := img.Width, img.Height
	pix := img.Pix
	if viewportHeight > 0 && height > viewportHeight {
		height = viewportHeight
		note.Cropped = true
		pix = pix[:width*height]
	}
	step := 1
	for maxPixels > 0 && (width/step)*(height/step) > maxPixels {
		step++
	}
	if step > 1 {
		sw, sh := width/step, height/step
		out := make([]RGB, 0, sw*sh)
		for y := 0; y < sh; y++ {
			for x := 0; x < sw; x++ {
				out = append(out, pix[(y*step)*width+(x*step)])
			}
		}
		pix, width, height = out, sw, sh
		note.SampleStep = step
	} else if note.Cropped {
		pix = append([]RGB{}, pix...)
	}
	note.AnalysedWidth, note.AnalysedHeight = width, height
	return Image{Width: width, Height: height, Pix: pix}, note
}
