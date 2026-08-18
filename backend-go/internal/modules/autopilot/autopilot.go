// Package autopilot — v2 automation chain (contract item 4, parity with the
// Python backend).
//
// The chain runs ONLY while project.automation == "auto": after a successful
// document parse, confirm every requirement still in state "extracted", then
// try the generation trigger. The chain always stops at draft cases ready for
// review — approval and runs stay manual (BO-07). Every auto step writes an
// AuditEntry with an "auto."-prefixed action, attributed to the user whose
// upload/import initiated the chain.
package autopilot

import (
	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/models"
	"traceo/internal/modules/generation"
)

// AfterParse runs after a document parse job succeeds: automation "auto" only —
// confirm all extracted requirements and try the generation trigger (item 4a).
func AfterParse(projectID, orgID, actorID string) {
	var project models.Project
	if err := db.DB.First(&project, "id = ? AND organisation_id = ?",
		projectID, orgID).Error; err != nil {
		return
	}
	if project.Automation != "auto" {
		return
	}
	res := db.DB.Model(&models.Requirement{}).
		Where("project_id = ? AND organisation_id = ? AND state = ?",
			projectID, orgID, "extracted").
		Update("state", "confirmed")
	if res.RowsAffected > 0 {
		httpx.Audit(orgID, &actorID, "auto.requirements.confirm_all", "project", projectID,
			models.JSONMap{"count": int(res.RowsAffected)})
	}
	maybeGenerate(projectID, orgID, actorID)
}

// AfterWebTarget runs after a browser discovery succeeds. A crawl leaves its
// requirements in "extracted", so without this the model-assisted generator
// never sees them and the URL path stops at whatever the deterministic builders
// produced. Same chain as AfterParse; the audit entry names the source, because
// "which upload confirmed these?" is the first question asked of a project whose
// requirements appeared on their own.
func AfterWebTarget(projectID, orgID, actorID string) {
	var project models.Project
	if err := db.DB.First(&project, "id = ? AND organisation_id = ?",
		projectID, orgID).Error; err != nil {
		return
	}
	if project.Automation != "auto" {
		return
	}
	res := db.DB.Model(&models.Requirement{}).
		Where("project_id = ? AND organisation_id = ? AND state = ?",
			projectID, orgID, "extracted").
		Update("state", "confirmed")
	if res.RowsAffected > 0 {
		httpx.Audit(orgID, &actorID, "auto.requirements.confirm_all", "project", projectID,
			models.JSONMap{"count": int(res.RowsAffected), "source": "web_target"})
	}
	maybeGenerate(projectID, orgID, actorID)
}

// AfterSpecImport runs after a successful api-spec import (item 4b) — the
// generation trigger only.
func AfterSpecImport(projectID, orgID, actorID string) {
	var project models.Project
	if err := db.DB.First(&project, "id = ? AND organisation_id = ?",
		projectID, orgID).Error; err != nil {
		return
	}
	if project.Automation != "auto" {
		return
	}
	maybeGenerate(projectID, orgID, actorID)
}

// maybeGenerate — trigger conditions (item 4b): >= 1 included endpoint AND
// >= 1 confirmed requirement AND no generation job for this project currently
// queued/running => enqueue a standard-depth generation job over all confirmed
// requirements. The queued/running check + enqueue is atomic in the job
// manager, so concurrent parse/import completions cannot double-trigger.
func maybeGenerate(projectID, orgID, actorID string) {
	var endpoints int64
	db.DB.Model(&models.Endpoint{}).
		Where("project_id = ? AND organisation_id = ? AND excluded = ?",
			projectID, orgID, false).
		Count(&endpoints)
	if endpoints == 0 {
		return
	}
	var confirmed int64
	db.DB.Model(&models.Requirement{}).
		Where("project_id = ? AND organisation_id = ? AND state = ?",
			projectID, orgID, "confirmed").
		Count(&confirmed)
	if confirmed == 0 {
		return
	}
	job, ok := jobs.TrySubmitForProject("generate", projectID, func(j *jobs.Job) (any, error) {
		// requirementIDs nil => all confirmed requirements (generation.Run).
		return generation.Run(j, orgID, actorID, projectID, nil, "standard")
	})
	if !ok {
		return
	}
	httpx.Audit(orgID, &actorID, "auto.generate", "project", projectID,
		models.JSONMap{"job_id": job.ID, "depth": "standard"})
}
