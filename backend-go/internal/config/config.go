// Package config: everything overridable via environment variables (NFR-POR-03).
// Same TRACEO_* variable names as the Python reference backend.
package config

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DevSecretKey is published in source, so it is a valid signing key for anyone
// reading this repo. Production must override it.
const DevSecretKey = "dev-secret-change-in-production-0000"

type Settings struct {
	AppName     string
	APIPrefix   string
	Env         string // development | production
	Port        string
	DatabaseURL string // path to sqlite file
	SecretKey   string
	TokenTTLH   int
	StorageDir  string
	MaxUploadMB int64
	LLMProvider string // auto | mock | anthropic | gemini
	LLMModel    string
	// Its own field rather than a shared one: LLMModel carries a Claude model id,
	// and a deployment that configures both providers must never hand one
	// provider's model name to the other.
	GeminiModel string
	GeminiKey   string
	// --- self-hosted model (air-gapped deployments, NFR-D1) ----------------
	// Any server speaking the OpenAI chat-completions shape: Ollama, llama.cpp,
	// vLLM, TGI. A base URL is what makes the provider available at all — there
	// is no default endpoint, because guessing localhost would turn "no model
	// configured" into a connection error nobody asked for.
	LocalLLMBaseURL string
	LocalLLMModel   string
	LocalLLMKey     string
	LLMTimeoutS     int
	LLMMaxTokens    int
	PromptVer       string
	ReqTimeoutS     float64
	RunTimeoutS     float64
	RunConc         int
	EvidenceMax     int
	CORSOrigins     []string
	SeedDemo        bool

	// --- Web target discovery (browser sidecar) ---------------------------
	// The target page is rendered by a Node/Playwright sidecar shared with the
	// Python backend; a plain HTTP GET of a SPA returns a shell with zero forms,
	// so server-side HTML parsing would discover nothing at all.
	WebDiscoveryScript string
	// WebCheckScript is the companion that EXECUTES what discovery generated. A
	// separate script rather than a mode of the first because the two do opposite
	// things: one reads a page without touching it, the other types into it.
	WebCheckScript      string
	NodeBin             string
	WebDiscoveryTimeout float64
	// A page of 40+ cases, each re-rendered for isolation, legitimately takes
	// minutes. The ceiling is a runaway guard, not a performance target.
	WebCheckTimeout float64
	// AllowPrivateTargets relaxes the SSRF rule so the stack can be pointed at a
	// local application under test.
	AllowPrivateTargets bool
	// PageLoadBudgetMS is the stated budget the performance track asserts; the
	// observed elapsed_ms is recorded beside it as the baseline.
	PageLoadBudgetMS int
	// DesignMaxPixels caps the raster the design engine analyses. Above it the
	// screenshot is subsampled by an integer step (nearest neighbour, never
	// averaged — averaging would invent colours the page never painted).
	DesignMaxPixels int

	// Development convenience: hand out a session for the seeded demo user
	// without a login form. Off by default and refused in production (see
	// ProductionSafetyError).
	DevAutologin      bool
	DevAutologinEmail string
}

var C Settings

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}

func envF(k string, d float64) float64 {
	if v := os.Getenv(k); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return d
}

func Load() {
	base, _ := os.Getwd()
	C = Settings{
		AppName:     "Traceo (TADQEEQ)",
		APIPrefix:   "/v1",
		Env:         env("TRACEO_ENV", "development"),
		Port:        env("TRACEO_PORT", "8000"),
		DatabaseURL: env("TRACEO_DATABASE_URL", filepath.Join(base, "traceo.db")),
		SecretKey:   env("TRACEO_SECRET_KEY", DevSecretKey),
		TokenTTLH:   envInt("TRACEO_TOKEN_TTL_HOURS", 12),
		StorageDir:  env("TRACEO_STORAGE_DIR", filepath.Join(base, "storage")),
		MaxUploadMB: int64(envInt("TRACEO_MAX_UPLOAD_MB", 50)),
		LLMProvider: env("TRACEO_LLM_PROVIDER", "auto"),
		LLMModel:    env("TRACEO_LLM_MODEL", "claude-opus-5"),
		GeminiModel: env("TRACEO_GEMINI_MODEL", "gemini-3.5-flash"),
		// GOOGLE_API_KEY is accepted as an alias: it is what the Google SDKs and
		// Cloud Shell already export.
		GeminiKey: env("GEMINI_API_KEY", os.Getenv("GOOGLE_API_KEY")),
		// Trailing slashes are stripped so both forms of the setting work:
		// "http://ollama:11434/v1" and "http://ollama:11434/v1/".
		LocalLLMBaseURL: strings.TrimRight(env("TRACEO_LOCAL_LLM_BASE_URL", ""), "/"),
		LocalLLMModel:   env("TRACEO_LOCAL_LLM_MODEL", "qwen2.5-coder:7b"),
		LocalLLMKey:     env("TRACEO_LOCAL_LLM_API_KEY", ""),
		// A model call is not a call to the system under test: a reasoning model
		// answering a long document legitimately outlives the SUT timeout.
		LLMTimeoutS: envInt("TRACEO_LLM_TIMEOUT_S", 120),
		// Thinking models spend this budget on reasoning before the answer, so it
		// must clear the answer by a wide margin or every call truncates.
		LLMMaxTokens: envInt("TRACEO_LLM_MAX_TOKENS", 8192),
		PromptVer:    "v1.0",
		ReqTimeoutS:  envF("TRACEO_REQUEST_TIMEOUT_S", 30),
		RunTimeoutS:  envF("TRACEO_RUN_TIMEOUT_S", 600),
		RunConc:      envInt("TRACEO_RUN_CONCURRENCY", 8),
		EvidenceMax:  envInt("TRACEO_EVIDENCE_MAX_BYTES", 16384),
		CORSOrigins:  []string{"http://localhost:3000", "http://127.0.0.1:3000"},
		SeedDemo:     env("TRACEO_SEED_DEMO", "1") == "1",

		DevAutologin:      os.Getenv("TRACEO_DEV_AUTOLOGIN") == "1",
		DevAutologinEmail: env("TRACEO_DEV_AUTOLOGIN_EMAIL", "demo@traceo.sa"),

		WebDiscoveryScript: env("TRACEO_WEB_DISCOVERY_SCRIPT",
			filepath.Join(filepath.Dir(base), "tools", "web-discovery", "discover.mjs")),
		WebCheckScript: env("TRACEO_WEB_CHECK_SCRIPT",
			filepath.Join(filepath.Dir(base), "tools", "web-discovery", "check.mjs")),
		NodeBin:             env("TRACEO_NODE_BIN", "node"),
		WebDiscoveryTimeout: envF("TRACEO_WEB_DISCOVERY_TIMEOUT_S", 30),
		WebCheckTimeout:     envF("TRACEO_WEB_CHECK_TIMEOUT_S", 900),
		AllowPrivateTargets: os.Getenv("TRACEO_ALLOW_PRIVATE_TARGETS") == "1",
		PageLoadBudgetMS:    envInt("TRACEO_PAGE_LOAD_BUDGET_MS", 3000),
		DesignMaxPixels:     envInt("TRACEO_DESIGN_MAX_PIXELS", 1200000),
	}
	_ = os.MkdirAll(C.StorageDir, 0o755)
	if err := ProductionSafetyError(C); err != nil {
		log.Fatal(err)
	}
}

// ProductionSafetyError reports why the given settings are unsafe to serve
// production traffic, or nil when they are fine. Load() turns a non-nil result
// into an immediate exit.
//
// Both defaults it checks are safe in development and catastrophic in
// production: the dev signing key is published in this package, so anyone could
// mint a valid JWT for any user in any organisation — collapsing the tenant
// isolation that AC-11 guards — and the demo accounts ship with a password
// printed in the docs. Neither is detectable at runtime, so the only safe
// failure is loud and immediate (NFR-S3).
func ProductionSafetyError(s Settings) error {
	if s.Env != "production" {
		return nil
	}
	var problems []string
	if s.SecretKey == DevSecretKey {
		problems = append(problems, "TRACEO_SECRET_KEY is unset or still the built-in dev key "+
			"— set a unique random value (e.g. `openssl rand -hex 32`)")
	}
	if s.SeedDemo {
		problems = append(problems, "TRACEO_SEED_DEMO must be 0 in production "+
			"— the seeded demo accounts use a password published in the documentation")
	}
	if s.DevAutologin {
		problems = append(problems, "TRACEO_DEV_AUTOLOGIN must be 0 in production "+
			"— it hands a full session to any caller without credentials")
	}
	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("refusing to start with TRACEO_ENV=production:\n  - %s",
		strings.Join(problems, "\n  - "))
}
