package ingestion

import "traceo/internal/jobs"

// RunIngest exposes the document-parse job body to the pipeline, which composes
// the stages rather than duplicating them: there must be exactly one
// implementation of parsing, and the pipeline must call it, not a copy.
func RunIngest(job *jobs.Job, documentID, projectID, orgID, actorID string) (any, error) {
	return runIngest(job, documentID, projectID, orgID, actorID)
}
