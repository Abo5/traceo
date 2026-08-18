// Package ingestion — Requirements Parser (TRD §4.1, FR-REQ).
//
// Pipeline: upload -> async job -> text extraction (pdf/docx/md/txt) -> deterministic
// segmentation -> per-segment `extract_requirement` LLM call -> persist
// Requirements with provenance.
//
// Re-upload of an existing filename bumps the document version and diffs the
// extraction against the previous inventory by external_id, then content_hash
// (FR-REQ-06, FR-TRC-04). Port of backend/app/modules/ingestion.py.
package ingestion

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/llm"
	"traceo/internal/models"
	"traceo/internal/modules/autopilot"
	"traceo/internal/modules/traceability"
)

var allowedExtensions = map[string]bool{".pdf": true, ".docx": true, ".md": true, ".txt": true}

// unsafeName strips everything outside unicode letters/digits plus "_", "." and
// "-" (unicode \w ≈ [\p{L}\p{N}_]), matching the Python backend.
var unsafeName = regexp.MustCompile(`[^\p{L}\p{N}_.\-]`)

func Register(r *gin.RouterGroup) {
	r.POST("/projects/:project_id/documents", httpx.Auth(), httpx.Require("upload_documents"), uploadDocument)
	r.GET("/projects/:project_id/documents", httpx.Auth(), httpx.Require("view"), listDocuments)
	r.GET("/projects/:project_id/requirements", httpx.Auth(), httpx.Require("view"), listRequirements)
	r.POST("/projects/:project_id/requirements/confirm_all", httpx.Auth(), httpx.Require("edit_requirements"), confirmAllRequirements)
	r.PATCH("/requirements/:requirement_id", httpx.Auth(), httpx.Require("edit_requirements"), updateRequirement)
	r.POST("/requirements", httpx.Auth(), httpx.Require("edit_requirements"), createRequirement)
	r.DELETE("/requirements/:requirement_id", httpx.Auth(), httpx.Require("edit_requirements"), deleteRequirement)
}

// --- serializers ---------------------------------------------------------------------

func ts(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

func docDict(d *models.SourceDocument) gin.H {
	var parseErr any
	if d.ParseError != "" {
		parseErr = d.ParseError
	}
	return gin.H{
		"id": d.ID, "project_id": d.ProjectID, "filename": d.Filename,
		"mime_type": d.MimeType, "size": d.Size, "language": d.Language,
		"version": d.Version, "parse_status": d.ParseStatus, "parse_error": parseErr,
		"created_at": ts(d.CreatedAt),
	}
}

func reqDict(r *models.Requirement) gin.H {
	criteria := r.AcceptanceCriteria
	if criteria == nil {
		criteria = models.JSONList{}
	}
	location := r.SourceLocation
	if location == nil {
		location = models.JSONMap{}
	}
	return gin.H{
		"id": r.ID, "project_id": r.ProjectID, "source_document_id": r.SourceDocumentID,
		"external_id": r.ExternalID, "description": r.Description,
		"acceptance_criteria": criteria, "type": r.Type,
		"priority": r.Priority, "state": r.State, "version": r.Version,
		"source_location": location, "source_text": r.SourceText,
		"confidence": r.Confidence, "content_hash": r.ContentHash,
		"created_at": ts(r.CreatedAt), "updated_at": ts(r.UpdatedAt),
	}
}

func getRequirement(c *gin.Context, requirementID string) (*models.Requirement, bool) {
	u := httpx.User(c)
	var req models.Requirement
	if err := db.DB.First(&req, "id = ? AND organisation_id = ?", requirementID, u.OrganisationID).Error; err != nil {
		httpx.Err(c, http.StatusNotFound, "not_found", "Requirement not found")
		return nil, false
	}
	return &req, true
}

// --- persistence with re-upload diffing ---------------------------------------------

type extractionItem struct {
	Data    extraction
	Segment string
	Page    *int
	Index   int
}

// persistRequirements inserts/diffs extracted requirements.
//
// First upload: everything inserted state='extracted'. Re-upload (same filename):
// match to existing project requirements by external_id first, then by content_hash.
// Unchanged -> keep; changed -> update in place, version += 1, state='changed', mark
// linked approved cases stale; unmatched rows from the previous document version ->
// state='removed'; new -> insert.
func persistRequirements(doc *models.SourceDocument, extractions []extractionItem) map[string]int {
	counts := map[string]int{"added": 0, "changed": 0, "unchanged": 0, "removed": 0}

	var priorDocIDs []string
	db.DB.Model(&models.SourceDocument{}).
		Where("project_id = ? AND organisation_id = ? AND filename = ? AND id <> ?",
			doc.ProjectID, doc.OrganisationID, doc.Filename, doc.ID).
		Pluck("id", &priorDocIDs)

	var existing []*models.Requirement
	if len(priorDocIDs) > 0 {
		db.DB.Where("project_id = ? AND organisation_id = ? AND source_document_id IN ? AND state <> ?",
			doc.ProjectID, doc.OrganisationID, priorDocIDs, "removed").Find(&existing)
	}

	byExternalID := map[string]*models.Requirement{}
	byHash := map[string]*models.Requirement{}
	for _, r := range existing {
		if r.ExternalID != "" {
			byExternalID[r.ExternalID] = r
		}
	}
	for _, r := range existing {
		if r.ContentHash != "" {
			byHash[r.ContentHash] = r
		}
	}
	matchedIDs := map[string]bool{}

	for _, item := range extractions {
		data := item.Data
		newHash := contentHash(data.Description, data.AcceptanceCriteria)
		location := models.JSONMap{"page": pageVal(item.Page), "index": item.Index}
		criteria := toJSONList(data.AcceptanceCriteria)

		var match *models.Requirement
		if data.ExternalID != "" {
			if candidate, ok := byExternalID[data.ExternalID]; ok && !matchedIDs[candidate.ID] {
				match = candidate
			}
		}
		if match == nil {
			if candidate, ok := byHash[newHash]; ok && !matchedIDs[candidate.ID] {
				match = candidate
			}
		}

		if match != nil {
			matchedIDs[match.ID] = true
			docID := doc.ID
			match.SourceDocumentID = &docID
			match.SourceText = item.Segment
			match.SourceLocation = location
			if match.ContentHash == newHash {
				counts["unchanged"]++
			} else {
				if data.ExternalID != "" {
					match.ExternalID = data.ExternalID
				}
				match.Description = data.Description
				match.AcceptanceCriteria = criteria
				match.Type = data.Type
				match.Priority = data.Priority
				match.Confidence = data.Confidence
				match.ContentHash = newHash
				match.Version++
				match.State = "changed"
				traceability.MarkStale(match.ID)
				counts["changed"]++
			}
			db.DB.Save(match)
		} else {
			docID := doc.ID
			db.DB.Create(&models.Requirement{
				OrganisationID:     doc.OrganisationID,
				ProjectID:          doc.ProjectID,
				SourceDocumentID:   &docID,
				ExternalID:         data.ExternalID,
				Description:        data.Description,
				AcceptanceCriteria: criteria,
				Type:               data.Type,
				Priority:           data.Priority,
				State:              "extracted",
				Version:            1,
				SourceLocation:     location,
				SourceText:         item.Segment,
				Confidence:         data.Confidence,
				ContentHash:        newHash,
			})
			counts["added"]++
		}
	}

	for _, req := range existing {
		if !matchedIDs[req.ID] {
			req.State = "removed"
			db.DB.Save(req)
			counts["removed"]++
		}
	}
	return counts
}

func pageVal(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func toJSONList(items []string) models.JSONList {
	out := models.JSONList{}
	for _, s := range items {
		out = append(out, s)
	}
	return out
}

// --- ingest job -----------------------------------------------------------------------

func runIngest(job *jobs.Job, documentID, projectID, orgID, actorID string) (any, error) {
	var doc models.SourceDocument
	if err := db.DB.First(&doc, "id = ?", documentID).Error; err != nil {
		return nil, fmt.Errorf("Source document disappeared before parsing")
	}
	doc.ParseStatus = "parsing"
	db.DB.Save(&doc)

	path := filepath.Join(config.C.StorageDir, doc.StorageKey)
	ext := strings.ToLower(filepath.Ext(doc.Filename))
	pages, err := extractText(path, ext)
	if err != nil {
		doc.ParseStatus = "failed"
		doc.ParseError = err.Error()
		db.DB.Save(&doc)
		return nil, err
	}

	for i := range pages {
		pages[i].Text = normalizeDigits(pages[i].Text)
	}
	segments := segmentPages(pages)
	job.Set(-1, fmt.Sprintf("Segmented document into %d candidate requirements", len(segments)))

	provider := llm.Get()
	total := len(segments)
	extractions := make([]extractionItem, 0, total)
	for i, seg := range segments {
		progress := 1.0
		if total > 0 {
			progress = float64(i) / float64(total)
		}
		job.Set(progress, fmt.Sprintf("Extracting requirement %d/%d", i+1, total))
		data := structureSegment(provider, seg.Text)
		extractions = append(extractions, extractionItem{Data: data, Segment: seg.Text, Page: seg.Page, Index: i})
	}

	job.Set(-1, "Persisting requirements")
	counts := persistRequirements(&doc, extractions)

	doc.ParseStatus = "parsed"
	doc.ParseError = ""
	db.DB.Save(&doc)
	detail := models.JSONMap{"filename": doc.Filename, "version": doc.Version, "segments": total}
	result := map[string]any{"document_id": doc.ID, "segments": total}
	for k, v := range counts {
		detail[k] = v
		result[k] = v
	}
	httpx.Audit(orgID, &actorID, "document.parsed", "source_document", doc.ID, detail)

	// Autopilot chain (automation contract 4a): auto mode only — confirm the
	// extracted requirements and try the generation trigger. Runs synchronously
	// so the parse job only reports completed once the chain has fired.
	autopilot.AfterParse(projectID, orgID, actorID)
	return result, nil
}

// --- routes ---------------------------------------------------------------------------

func uploadDocument(c *gin.Context) {
	projectID := c.Param("project_id")
	_, ok := httpx.ProjectScoped(c, projectID)
	if !ok {
		return
	}
	u := httpx.User(c)

	fh, err := c.FormFile("file")
	if err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "missing_file",
			"Multipart request must include a 'file' part.")
		return
	}
	filename := fh.Filename
	if filename == "" {
		filename = "document.txt"
	}
	ext := strings.ToLower(filepath.Ext(filename))
	if !allowedExtensions[ext] {
		httpx.Err(c, http.StatusUnprocessableEntity, "unsupported_file_type",
			fmt.Sprintf("Unsupported file type '%s'. Allowed: pdf, docx, md, txt.", ext))
		return
	}

	src, err := fh.Open()
	if err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "empty_file", "Uploaded file is empty.")
		return
	}
	defer src.Close()
	content, err := io.ReadAll(io.LimitReader(src, config.C.MaxUploadMB*1024*1024+1))
	if err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "empty_file", "Uploaded file is empty.")
		return
	}
	if int64(len(content)) > config.C.MaxUploadMB*1024*1024 {
		httpx.Err(c, http.StatusRequestEntityTooLarge, "file_too_large",
			fmt.Sprintf("File exceeds the %dMB upload limit.", config.C.MaxUploadMB))
		return
	}
	if len(content) == 0 {
		httpx.Err(c, http.StatusUnprocessableEntity, "empty_file", "Uploaded file is empty.")
		return
	}

	safename := truncRunes(unsafeName.ReplaceAllString(filename, "_"), 120)
	storageKey := uuid.NewString() + "_" + safename
	if err := writeFile(filepath.Join(config.C.StorageDir, storageKey), content); err != nil {
		httpx.Err(c, http.StatusInternalServerError, "storage_error", "Could not store the uploaded file.")
		return
	}

	var priorMax int
	db.DB.Model(&models.SourceDocument{}).
		Where("project_id = ? AND organisation_id = ? AND filename = ?",
			projectID, u.OrganisationID, filename).
		Select("COALESCE(MAX(version), 0)").Scan(&priorMax)

	doc := models.SourceDocument{
		OrganisationID: u.OrganisationID, ProjectID: projectID,
		Filename: filename, MimeType: fh.Header.Get("Content-Type"), Size: int64(len(content)),
		StorageKey: storageKey, Language: "en",
		Version: priorMax + 1, ParseStatus: "pending",
	}
	if err := db.DB.Create(&doc).Error; err != nil {
		httpx.Err(c, http.StatusInternalServerError, "storage_error", "Could not save the document.")
		return
	}

	docID, orgID, actorID := doc.ID, u.OrganisationID, u.ID
	job := jobs.Submit("ingest", func(j *jobs.Job) (any, error) {
		return runIngest(j, docID, projectID, orgID, actorID)
	})
	c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID, "document_id": docID})
}

func listDocuments(c *gin.Context) {
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	u := httpx.User(c)
	var docs []models.SourceDocument
	db.DB.Where("project_id = ? AND organisation_id = ?", projectID, u.OrganisationID).
		Order("created_at DESC").Find(&docs)
	out := make([]gin.H, 0, len(docs))
	for i := range docs {
		out = append(out, docDict(&docs[i]))
	}
	c.JSON(http.StatusOK, out)
}

func listRequirements(c *gin.Context) {
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	u := httpx.User(c)
	query := db.DB.Where("project_id = ? AND organisation_id = ?", projectID, u.OrganisationID)
	state := c.Query("state")
	if state != "" {
		query = query.Where("state = ?", state)
	}
	if t := c.Query("type"); t != "" {
		query = query.Where("type = ?", t)
	}
	if p := c.Query("priority"); p != "" {
		query = query.Where("priority = ?", p)
	}
	if q := c.Query("q"); q != "" {
		needle := "%" + strings.ToLower(q) + "%"
		query = query.Where(
			"LOWER(description) LIKE ? OR LOWER(external_id) LIKE ? OR LOWER(source_text) LIKE ?",
			needle, needle, needle)
	}
	if state == "extracted" {
		// review queue: lowest-confidence extractions surface first (FR-REQ-08)
		query = query.Order("confidence ASC, created_at ASC")
	} else {
		query = query.Order("created_at ASC")
	}
	var reqs []models.Requirement
	query.Find(&reqs)
	out := make([]gin.H, 0, len(reqs))
	for i := range reqs {
		out = append(out, reqDict(&reqs[i]))
	}
	c.JSON(http.StatusOK, out)
}

func updateRequirement(c *gin.Context) {
	req, ok := getRequirement(c, c.Param("requirement_id"))
	if !ok {
		return
	}
	u := httpx.User(c)
	var body map[string]any
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_request", "Request body must be a JSON object.")
		return
	}
	changes := map[string]bool{}

	if v, present := body["state"]; present && v != nil && v != "confirmed" {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_state",
			"Only state='confirmed' may be set via this endpoint.")
		return
	}
	if v, present := body["type"]; present && v != nil {
		if s, isStr := v.(string); !isStr || !requirementTypes[s] {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_type",
				"type must be one of "+sortedTypesRepr)
			return
		}
	}
	var bodyCriteria []string
	hasCriteria := false
	if v, present := body["acceptance_criteria"]; present && v != nil {
		list, isList := v.([]any)
		if !isList {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_criteria",
				"acceptance_criteria must be a list.")
			return
		}
		hasCriteria = true
		bodyCriteria = toStrList(list)
	}

	contentChanged := false
	if v, present := body["description"]; present && v != nil && anyToStr(v) != req.Description {
		changes["description"] = true
		req.Description = anyToStr(v)
		contentChanged = true
	}
	if hasCriteria && !reflect.DeepEqual(toJSONList(bodyCriteria), req.AcceptanceCriteria) {
		changes["acceptance_criteria"] = true
		req.AcceptanceCriteria = toJSONList(bodyCriteria)
		contentChanged = true
	}
	if v, present := body["external_id"]; present && v != nil && anyToStr(v) != req.ExternalID {
		changes["external_id"] = true
		req.ExternalID = strings.TrimSpace(anyToStr(v))
	}
	if v, present := body["type"]; present && v != nil && v.(string) != req.Type {
		changes["type"] = true
		req.Type = v.(string)
	}
	if v, present := body["priority"]; present && v != nil && anyToStr(v) != req.Priority {
		changes["priority"] = true
		req.Priority = anyToStr(v)
	}

	if contentChanged {
		req.ContentHash = contentHash(req.Description, criteriaStrings(req.AcceptanceCriteria))
		if req.State == "confirmed" {
			// editing a confirmed requirement invalidates its approved cases (FR-TRC-04)
			req.Version++
			traceability.MarkStale(req.ID)
		}
	}

	if v, present := body["state"]; present && v == "confirmed" && req.State != "confirmed" {
		changes["state"] = true
		req.State = "confirmed"
	}

	if len(changes) > 0 {
		keys := make([]string, 0, len(changes))
		for k := range changes {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		detail := models.JSONMap{"changes": keys}
		httpx.Audit(u.OrganisationID, &u.ID, "requirement.updated", "requirement", req.ID, detail)
		db.DB.Save(req)
	}
	c.JSON(http.StatusOK, reqDict(req))
}

func criteriaStrings(l models.JSONList) []string {
	out := make([]string, 0, len(l))
	for _, v := range l {
		out = append(out, anyToStr(v))
	}
	return out
}

func createRequirement(c *gin.Context) {
	u := httpx.User(c)
	var body map[string]any
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_request", "Request body must be a JSON object.")
		return
	}
	projectID := anyToStr(body["project_id"])
	description := strings.TrimSpace(anyToStr(body["description"]))
	if projectID == "" || description == "" {
		httpx.Err(c, http.StatusUnprocessableEntity, "missing_fields",
			"project_id and description are required.")
		return
	}
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	rtype := "functional"
	if v, present := body["type"]; present && v != nil && anyToStr(v) != "" {
		rtype = anyToStr(v)
	}
	if !requirementTypes[rtype] {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_type",
			"type must be one of "+sortedTypesRepr)
		return
	}
	criteria := []string{}
	if list, isList := body["acceptance_criteria"].([]any); isList {
		criteria = toStrList(list)
	}
	priority := "medium"
	if v, present := body["priority"]; present && v != nil && anyToStr(v) != "" {
		priority = anyToStr(v)
	}

	req := models.Requirement{
		OrganisationID: u.OrganisationID, ProjectID: projectID,
		SourceDocumentID: nil,
		ExternalID:       strings.TrimSpace(anyToStr(body["external_id"])),
		Description:      description, AcceptanceCriteria: toJSONList(criteria),
		Type: rtype, Priority: priority,
		State:   "confirmed", // human-authored — no extraction review needed
		Version: 1, SourceLocation: models.JSONMap{}, SourceText: description,
		Confidence: 1.0, ContentHash: contentHash(description, criteria),
	}
	if err := db.DB.Create(&req).Error; err != nil {
		httpx.Err(c, http.StatusInternalServerError, "storage_error", "Could not create the requirement.")
		return
	}
	httpx.Audit(u.OrganisationID, &u.ID, "requirement.created", "requirement", req.ID,
		models.JSONMap{"manual": true})
	c.JSON(http.StatusCreated, reqDict(&req))
}

func deleteRequirement(c *gin.Context) {
	requirementID := c.Param("requirement_id")
	req, ok := getRequirement(c, requirementID)
	if !ok {
		return
	}
	u := httpx.User(c)
	db.DB.Where("requirement_id = ?", req.ID).Delete(&models.RequirementTestCase{})
	httpx.Audit(u.OrganisationID, &u.ID, "requirement.deleted", "requirement", req.ID,
		models.JSONMap{"external_id": req.ExternalID})
	db.DB.Delete(req)
	c.JSON(http.StatusOK, gin.H{"deleted": true, "id": requirementID})
}

func confirmAllRequirements(c *gin.Context) {
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	u := httpx.User(c)
	res := db.DB.Model(&models.Requirement{}).
		Where("project_id = ? AND organisation_id = ? AND state = ?",
			projectID, u.OrganisationID, "extracted").
		Update("state", "confirmed")
	count := int(res.RowsAffected)
	httpx.Audit(u.OrganisationID, &u.ID, "requirement.confirm_all", "project", projectID,
		models.JSONMap{"count": count})
	c.JSON(http.StatusOK, gin.H{"confirmed": count})
}

func writeFile(path string, content []byte) error {
	return os.WriteFile(path, content, 0o644)
}
