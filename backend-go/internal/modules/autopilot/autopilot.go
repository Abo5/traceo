// Package autopilot — v2 automation chain (contract items 3-4, parity with the
// Python backend).
//
// Language auto-detection is deterministic and offline (NO LLM): the ratio of
// Arabic-block chars (U+0600–U+06FF) over total alphabetic chars in the parsed
// text; ratio >= 0.25 => "ar", else "en". Detection runs after every successful
// document parse while project.language is still NULL, regardless of the
// automation mode.
//
// The rest of the chain runs ONLY while project.automation == "auto": confirm
// every requirement still in state "extracted", then try the generation
// trigger. The chain always stops at draft cases ready for review — approval
// and runs stay manual (BO-07). Every auto step writes an AuditEntry with an
// "auto."-prefixed action, attributed to the user whose upload/import initiated
// the chain.
package autopilot

import (
	"unicode"

	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/models"
	"traceo/internal/modules/generation"
)

// DetectLanguage — contract item 3. Counts Arabic-block runes (U+0600–U+06FF)
// against total alphabetic runes; ratio >= 0.25 => "ar" else "en". Text with no
// alphabetic characters detects as "en".
func DetectLanguage(text string) string {
	arabic, letters := 0, 0
	for _, r := range text {
		if r >= 0x0600 && r <= 0x06FF {
			arabic++
		}
		if unicode.IsLetter(r) {
			letters++
		}
	}
	if letters > 0 && float64(arabic)/float64(letters) >= 0.25 {
		return "ar"
	}
	return "en"
}

// AfterParse runs after a document parse job succeeds: detect + persist the
// project language when still null (item 3), then — automation "auto" only —
// confirm all extracted requirements and try the generation trigger (item 4a).
func AfterParse(projectID, orgID, actorID, parsedText string) {
	var project models.Project
	if err := db.DB.First(&project, "id = ? AND organisation_id = ?",
		projectID, orgID).Error; err != nil {
		return
	}
	if project.Language == nil {
		lang := DetectLanguage(parsedText)
		project.Language = &lang
		db.DB.Model(&models.Project{}).Where("id = ?", project.ID).Update("language", lang)
		httpx.Audit(orgID, &actorID, "auto.language.detect", "project", project.ID,
			models.JSONMap{"language": lang})
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

// AfterSpecImport runs after a successful api-spec import (item 4b) — the
// generation trigger only; no language detection here.
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
