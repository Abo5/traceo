// Guard test — a production node must never boot with the published dev signing
// key or the documented demo accounts. See ProductionSafetyError.
package config

import (
	"strings"
	"testing"
)

func base() Settings {
	return Settings{Env: "production", SecretKey: "a-real-unique-secret", SeedDemo: false}
}

func TestDevelopmentIsNeverBlocked(t *testing.T) {
	// The insecure defaults are exactly what development wants; only the
	// production switch turns them into errors.
	s := Settings{Env: "development", SecretKey: DevSecretKey, SeedDemo: true}
	if err := ProductionSafetyError(s); err != nil {
		t.Fatalf("development must boot with dev defaults, got: %v", err)
	}
}

func TestProperlyConfiguredProductionBoots(t *testing.T) {
	if err := ProductionSafetyError(base()); err != nil {
		t.Fatalf("safe production config was rejected: %v", err)
	}
}

func TestProductionRejectsDevSecret(t *testing.T) {
	s := base()
	s.SecretKey = DevSecretKey
	err := ProductionSafetyError(s)
	if err == nil {
		t.Fatal("production booted with the published dev signing key — tenant isolation is forgeable")
	}
	if !strings.Contains(err.Error(), "TRACEO_SECRET_KEY") {
		t.Errorf("error should name the variable to fix, got: %v", err)
	}
}

func TestProductionRejectsDemoSeed(t *testing.T) {
	s := base()
	s.SeedDemo = true
	err := ProductionSafetyError(s)
	if err == nil {
		t.Fatal("production booted while seeding demo accounts with a published password")
	}
	if !strings.Contains(err.Error(), "TRACEO_SEED_DEMO") {
		t.Errorf("error should name the variable to fix, got: %v", err)
	}
}

func TestBothProblemsAreReportedTogether(t *testing.T) {
	// An operator fixing one problem at a time would otherwise need two
	// failed deploys to learn about both.
	s := Settings{Env: "production", SecretKey: DevSecretKey, SeedDemo: true}
	err := ProductionSafetyError(s)
	if err == nil {
		t.Fatal("expected refusal")
	}
	if !strings.Contains(err.Error(), "TRACEO_SECRET_KEY") ||
		!strings.Contains(err.Error(), "TRACEO_SEED_DEMO") {
		t.Errorf("both problems must be listed, got: %v", err)
	}
}
