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
	LLMProvider string // auto | mock | anthropic
	LLMModel    string
	PromptVer   string
	ReqTimeoutS float64
	RunTimeoutS float64
	RunConc     int
	EvidenceMax int
	CORSOrigins []string
	SeedDemo    bool
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
		PromptVer:   "v1.0",
		ReqTimeoutS: envF("TRACEO_REQUEST_TIMEOUT_S", 30),
		RunTimeoutS: envF("TRACEO_RUN_TIMEOUT_S", 600),
		RunConc:     envInt("TRACEO_RUN_CONCURRENCY", 8),
		EvidenceMax: envInt("TRACEO_EVIDENCE_MAX_BYTES", 16384),
		CORSOrigins: []string{"http://localhost:3000", "http://127.0.0.1:3000"},
		SeedDemo:    env("TRACEO_SEED_DEMO", "1") == "1",
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
	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("refusing to start with TRACEO_ENV=production:\n  - %s",
		strings.Join(problems, "\n  - "))
}
