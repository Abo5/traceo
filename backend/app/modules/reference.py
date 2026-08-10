"""Feature reference catalog (v2 addendum) — GET /reference/features.

Static catalog hardcoded from Traceov2/docs/02-Feature-Reference.md: 37 features
across 8 capability groups. `status` reflects THIS codebase honestly (v1 modules
plus the v2 integrations addendum), not the design document's claims:
built = the capability exists and is exercised by the running backend today,
planned = referenced by the design but not implemented here yet.

The catalog used to ship every entry twice, Arabic and English (`name_ar`,
`description_ar`). Traceo is English-only now, so only the English side survives:
each group carries `name_en`, each feature `name_en` + `description_en`.
"""
from fastapi import APIRouter, Depends

from ..deps import require
from ..models import User

router = APIRouter()

GROUPS = [
    {"key": "parser", "name_en": "Layer 1 — Parser"},
    {"key": "discovery", "name_en": "Layer 2 — Discovery"},
    {"key": "generator", "name_en": "Layer 3 — Generator"},
    {"key": "execution", "name_en": "Layer 4 — Execution"},
    {"key": "reporting", "name_en": "Layer 5 — Reporting"},
    {"key": "automation", "name_en": "Automation"},
    {"key": "integrations", "name_en": "Integrations"},
    {"key": "platform", "name_en": "Platform"},
]


def _f(fid, group, name_en, priority, status, description_en):
    return {"id": fid, "group": group, "name_en": name_en,
            "priority": priority, "status": status, "description_en": description_en}


FEATURES = [
    # --- Layer 1 — Parser ---------------------------------------------------
    _f("FR-010", "parser", "Requirements ingestion", "P0", "built",
       "Upload a PDF, DOCX, Markdown or plain-text requirements document and Traceo "
       "extracts every requirement with an id, description, type and priority, all "
       "correctable before generation."),
    _f("FR-011", "parser", "Confluence import", "P1", "planned",
       "Pull requirement pages straight from a Confluence space instead of uploading a "
       "file, detecting which pages changed on re-import."),
    _f("FR-012", "parser", "Unicode-safe parsing", "P0", "built",
       "Parse RFP and BRD documents whatever characters they contain — accented Latin, "
       "CJK, emoji and combining marks all survive extraction unchanged."),
    _f("FR-013", "parser", "Acceptance-criteria extraction", "P0", "built",
       "Break every requirement into atomic, testable acceptance criteria that the test "
       "cases are built from and the matrix is measured against."),
    _f("FR-014", "parser", "Source traceback", "P1", "built",
       "Every requirement keeps a link to its source document and the original text, and "
       "the trace stays valid after an updated version of the document is re-parsed."),

    # --- Layer 2 — Discovery ------------------------------------------------
    _f("FR-020", "discovery", "OpenAPI discovery", "P0", "built",
       "Read endpoints, parameters and schemas directly from an OpenAPI 3.x or Swagger 2.0 "
       "spec, by upload or URL, resolving internal references safely."),
    _f("FR-021", "discovery", "Traffic-capture discovery", "P0", "planned",
       "A headless browser drives the application and builds the endpoint map from observed "
       "network traffic, redacting credentials before anything is stored."),
    _f("FR-022", "discovery", "DOM crawl", "P1", "planned",
       "Collect forms, fields and client-side validation rules from the rendered DOM to feed "
       "boundary and equivalence inputs."),
    _f("FR-023", "discovery", "Postman import", "P2", "planned",
       "Import an existing Postman v2.1 collection and treat it as a discovered surface, "
       "marking its origin in the coverage map."),
    _f("FR-024", "discovery", "Endpoint coverage map", "P1", "built",
       "Every discovered endpoint shows how many tests hit it, what share of its parameters "
       "are covered and its latest execution result."),

    # --- Layer 3 — Generator ------------------------------------------------
    _f("FR-030", "generator", "Boundary value analysis", "P0", "built",
       "Generate cases for the minimum, the maximum and just past each edge of every field "
       "constrained by value or length, derived from the spec schema."),
    _f("FR-031", "generator", "Equivalence partitioning", "P0", "built",
       "One representative case per valid and invalid class, derived from the declared enums, "
       "formats and rules."),
    _f("FR-032", "generator", "Decision tables", "P1", "built",
       "Enumerate rule and condition combinations for business-rule requirements where two or "
       "more constraints interact (exhaustive depth)."),
    _f("FR-033", "generator", "Negative & auth cases", "P0", "built",
       "Missing parameter, wrong type, malformed body, unauthenticated request against a "
       "secured operation, and injection-shaped strings tested safely."),
    _f("FR-034", "generator", "Unicode round-trip checks", "P1", "built",
       "Non-ASCII payloads and an encoding round-trip on free-text fields, generated by "
       "default as part of every generation run."),
    _f("FR-035", "generator", "Grounded generation", "P0", "built",
       "Generation is confined to discovered endpoints; a strict grounding gate checks every "
       "step and discards any case referencing an endpoint or field that does not exist — it "
       "is never repaired."),
    _f("FR-036", "generator", "Test case library", "P1", "built",
       "Every generated case is browsable, filterable and editable; manual edits are flagged "
       "and hand-written cases count in the matrix exactly like generated ones."),

    # --- Layer 4 — Execution ------------------------------------------------
    _f("FR-040", "execution", "HTTP execution engine", "P0", "built",
       "Run approved cases against a project environment with configurable concurrency, one "
       "authentication per run, and mid-run cancellation that keeps partial results."),
    _f("FR-041", "execution", "Schema assertions", "P0", "built",
       "Validate the response body against the response schema declared in the spec; a "
       "violation fails the case even when the status code is correct."),
    _f("FR-042", "execution", "Business-rule assertions", "P0", "built",
       "Assertions derived from acceptance criteria, not from status codes alone, with a "
       "failure message that shows expected and actual side by side."),
    _f("FR-043", "execution", "Test data lifecycle", "P1", "planned",
       "Set test data up before a suite and tear it down afterwards for every run, reporting "
       "anything that could not be removed."),
    _f("FR-044", "execution", "Performance capture", "P2", "built",
       "Record response time per case and report p50/p95/max per endpoint, with a "
       "response_time_ms assertion able to fail a case that exceeds its budget."),

    # --- Layer 5 — Reporting ------------------------------------------------
    _f("FR-050", "reporting", "Traceability matrix", "P0", "built",
       "Requirement -> test cases -> verdict, always current after every run and every "
       "requirement change, exportable as XLSX."),
    _f("FR-051", "reporting", "Coverage gap detection", "P0", "built",
       "Every requirement without an approved case appears as a gap with a clear reason and a "
       "suggested next action."),
    _f("FR-052", "reporting", "Reproducible bug reports", "P0", "built",
       "Numbered steps, the redacted request/response log and the failing assertion with "
       "expected and actual, plus a severity derived from requirement priority and failure class."),
    _f("FR-053", "reporting", "Run comparison", "P1", "built",
       "Compare any two runs of the same project: new failures, fixes, and the coverage "
       "difference."),
    _f("FR-054", "reporting", "Coverage trend", "P1", "built",
       "Plot the last 14 completed runs with their coverage value and per-run results on the "
       "project dashboard."),

    # --- Automation ---------------------------------------------------------
    _f("FR-060", "automation", "Scheduled runs", "P1", "built",
       "A schedule per project and environment with a minimum 15-minute interval; a scheduler "
       "thread launches the same path as a manual run and the run shows up in the log with "
       "source 'schedule'."),
    _f("FR-061", "automation", "CI/CD gate", "P0", "built",
       "A gate endpoint behind public API keys: minimum coverage, maximum critical defects and "
       "failures; ?exit=1 returns 412 to fail the pipeline and names the offending requirements."),
    _f("FR-062", "automation", "Regression watch", "P1", "built",
       "Surface any requirement that used to pass and has started failing on the project "
       "dashboard, with its state and severity."),

    # --- Integrations -------------------------------------------------------
    _f("FR-070", "integrations", "Jira / Xray export", "P0", "built",
       "Export run results in Xray import format (xray.json) and failures as a Jira-ready CSV "
       "with steps, severity and requirement ids."),
    _f("FR-071", "integrations", "PDF / XLSX report export", "P1", "built",
       "The traceability matrix as an XLSX workbook, and a printable HTML run report that "
       "doubles as the PDF deliverable through the browser's print dialog."),
    _f("FR-072", "integrations", "Slack notifications", "P2", "built",
       "Webhooks on run completion signed with HMAC, plus a special case for Slack incoming "
       "webhook URLs that sends a plain summary line with the result counts."),

    # --- Platform -----------------------------------------------------------
    _f("FR-080", "platform", "Role-based access", "P1", "built",
       "Four roles (admin, QA lead, QA engineer, viewer) enforced on the server through a "
       "per-endpoint capability matrix."),
    # planned, not built: the stack runs offline (local SQLite, offline mock LLM
    # provider), but there is no deployment artefact yet — no container image, no
    # compose file, no upgrade path. Claiming "built" would misrepresent the
    # product in the UI, since this catalog is shown to customers.
    _f("FR-081", "platform", "On-premise deployment", "P0", "planned",
       "The components run with no internet access (local SQLite and a mock LLM provider), but "
       "there is no deployment package yet: no container image, no compose file, no upgrade path."),
    _f("FR-082", "platform", "Audit log", "P1", "built",
       "Every configuration change and every run is written to an append-only, immutable log, "
       "with a full organisation data export."),
    _f("FR-083", "platform", "Secrets vault", "P0", "built",
       "System-under-test credentials are encrypted at rest and are never written to logs, "
       "reports or captured evidence."),
]

assert len(FEATURES) == 37, "feature catalog must stay at 37 entries"


@router.get("/reference/features")
def list_features(user: User = Depends(require("view"))):
    return {"groups": GROUPS, "features": FEATURES,
            "counts": {"total": len(FEATURES),
                       "built": sum(1 for f in FEATURES if f["status"] == "built"),
                       "planned": sum(1 for f in FEATURES if f["status"] == "planned")}}
