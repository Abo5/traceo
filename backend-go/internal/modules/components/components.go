// Package components — the project's declared software inventory
// (SECURITY_TESTING_PLAN §2, phase S2.1). Port of
// backend/app/modules/components.py.
//
//	POST   /v1/projects/{id}/components   capability "import_spec" — 202 {job_id}
//	GET    /v1/projects/{id}/components   capability "view"
//	DELETE /v1/components/{id}            capability "import_spec"
//
// Why this exists before any CVE feed: a CVE feed is a firehose about OTHER
// people's software. Without an inventory to match against, generating cases
// from CVE text would produce hundreds of confident, ungrounded cases about
// software the target does not run — the same fabrication BO-07 forbids,
// arriving through a new door.
package components

import (
	"fmt"
	"io"
	"net/http"
	"path"
	"sort"
	"time"

	"github.com/gin-gonic/gin"

	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/models"
)

const maxComponentBytes = 10 * 1024 * 1024

func Register(r *gin.RouterGroup) {
	g := r.Group("", httpx.Auth())
	g.POST("/projects/:project_id/components", httpx.Require("import_spec"), importComponents)
	g.GET("/projects/:project_id/components", httpx.Require("view"), listComponents)
	g.DELETE("/components/:component_id", httpx.Require("import_spec"), deleteComponent)
}

// errWith writes the error envelope carrying an extra "errors" list (the shape
// discovery already uses for invalid_spec).
func errWith(c *gin.Context, status int, code, message string, errs []string) {
	c.AbortWithStatusJSON(status, gin.H{"detail": gin.H{
		"code": code, "message": message, "errors": errs}})
}

// ---------------------------------------------------------------------------
// POST /v1/projects/{id}/components
// ---------------------------------------------------------------------------

func importComponents(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	fh, err := c.FormFile("file")
	if err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "missing_file",
			"Multipart request must include a 'file' part.")
		return
	}
	src, err := fh.Open()
	if err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "missing_file",
			"Multipart request must include a 'file' part.")
		return
	}
	defer src.Close()
	raw, err := io.ReadAll(io.LimitReader(src, maxComponentBytes+1))
	if err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "empty_file", "Uploaded file is empty.")
		return
	}
	if len(raw) == 0 {
		httpx.Err(c, http.StatusUnprocessableEntity, "empty_file", "Uploaded file is empty.")
		return
	}
	if len(raw) > maxComponentBytes {
		httpx.Err(c, http.StatusRequestEntityTooLarge, "file_too_large",
			fmt.Sprintf("File exceeds the %dMB limit.", maxComponentBytes/(1024*1024)))
		return
	}

	filename := fh.Filename
	if filename == "" {
		filename = "components"
	}

	// Detection and parsing are pure and fast, so they run in the request: a file
	// nothing recognises must fail LOUDLY here, not silently inside a job.
	format, entries, perr := Parse(raw, filename)
	if perr != nil {
		// Same sentence as the Python backend (modules/components.py), naming the
		// file the caller actually sent — a client must not be able to tell the
		// two backends apart from the error body.
		errWith(c, http.StatusUnprocessableEntity, "unsupported_component_format",
			fmt.Sprintf("'%s' matches no supported component format.", path.Base(filename)),
			SupportedFormats)
		return
	}

	orgID, userID := u.OrganisationID, u.ID
	// Job kind "ingest" — the same kind the Python backend submits, so a client
	// polling /v1/jobs/{id} sees the identical payload from either backend.
	job := jobs.SubmitForProject("ingest", projectID, func(j *jobs.Job) (any, error) {
		return persistEntries(j, orgID, userID, projectID, format, filename, entries)
	})
	c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID})
}

// persistEntries upserts the parsed inventory. Re-importing the same document is
// a no-op beyond `updated`, so an import is idempotent.
func persistEntries(job *jobs.Job, orgID, userID, projectID, format, filename string,
	entries []Entry) (any, error) {
	source := SourceForFormat(format)
	added, updated, unpinned := 0, 0, 0
	total := len(entries)
	if total < 1 {
		total = 1
	}
	for i, e := range entries {
		job.Set(float64(i)/float64(total)*0.95, "Recording "+e.Name)
		if e.Version == nil {
			unpinned++
		}
		var existing models.Component
		q := db.DB.Where("project_id = ? AND organisation_id = ? AND name = ? AND ecosystem = ?",
			projectID, orgID, e.Name, e.Ecosystem)
		if e.Version == nil {
			q = q.Where("version IS NULL")
		} else {
			q = q.Where("version = ?", *e.Version)
		}
		if err := q.First(&existing).Error; err == nil {
			db.DB.Model(&models.Component{}).Where("id = ?", existing.ID).
				Updates(map[string]any{
					"purl": e.Purl, "cpe23": e.CPE23, "source": source,
					"unpinned_reason": e.UnpinnedReason, "status": "active",
					"updated_at": time.Now().UTC(),
				})
			updated++
			continue
		}
		row := models.Component{OrganisationID: orgID, ProjectID: projectID,
			Name: e.Name, Version: e.Version, Ecosystem: e.Ecosystem,
			Purl: e.Purl, CPE23: e.CPE23, Source: source,
			UnpinnedReason: e.UnpinnedReason, Status: "active"}
		if err := db.DB.Create(&row).Error; err != nil {
			continue
		}
		added++
	}

	job.Set(0.98, fmt.Sprintf("%d added, %d updated, %d unpinned", added, updated, unpinned))
	// total is the size of the DOCUMENT that was imported, not of the project's
	// inventory: it answers "how much of this file landed?".
	result := map[string]any{"format": format, "added": added, "updated": updated,
		"unpinned": unpinned, "total": len(entries)}
	uid := userID
	detail := models.JSONMap{"filename": filename}
	for k, v := range result {
		detail[k] = v
	}
	httpx.Audit(orgID, &uid, "components.import", "project", projectID, detail)
	return result, nil
}

// ---------------------------------------------------------------------------
// GET /v1/projects/{id}/components
// ---------------------------------------------------------------------------

func componentDict(comp *models.Component) gin.H {
	return gin.H{
		"id": comp.ID, "project_id": comp.ProjectID, "name": comp.Name,
		"version": comp.Version, "ecosystem": comp.Ecosystem, "purl": comp.Purl,
		"cpe23": comp.CPE23, "source": comp.Source,
		"unpinned_reason": comp.UnpinnedReason, "status": comp.Status,
		"created_at": comp.CreatedAt.UTC().Format(time.RFC3339),
		"updated_at": comp.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func listComponents(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	var comps []models.Component
	db.DB.Where("project_id = ? AND organisation_id = ?", projectID, u.OrganisationID).
		Find(&comps)
	sort.SliceStable(comps, func(i, j int) bool {
		if comps[i].Ecosystem != comps[j].Ecosystem {
			return comps[i].Ecosystem < comps[j].Ecosystem
		}
		if comps[i].Name != comps[j].Name {
			return comps[i].Name < comps[j].Name
		}
		return versionOf(&comps[i]) < versionOf(&comps[j])
	})
	out := make([]gin.H, 0, len(comps))
	for i := range comps {
		out = append(out, componentDict(&comps[i]))
	}
	c.JSON(http.StatusOK, gin.H{"components": out})
}

func versionOf(comp *models.Component) string {
	if comp.Version == nil {
		return ""
	}
	return *comp.Version
}

// ---------------------------------------------------------------------------
// DELETE /v1/components/{id}
// ---------------------------------------------------------------------------

func deleteComponent(c *gin.Context) {
	u := httpx.User(c)
	id := c.Param("component_id")
	var comp models.Component
	if err := db.DB.First(&comp, "id = ? AND organisation_id = ?",
		id, u.OrganisationID).Error; err != nil {
		httpx.Err(c, http.StatusNotFound, "not_found", "Component not found")
		return
	}
	db.DB.Delete(&models.Component{}, "id = ?", comp.ID)
	c.JSON(http.StatusOK, gin.H{"deleted": true, "id": comp.ID})
}
