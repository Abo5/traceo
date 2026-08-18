// Dev auto-login gate — POST /v1/auth/dev-session hands out a session with no
// credentials so the login screen can be skipped during development. It is a
// full authentication bypass, so the surrounding guards (off by default, 404
// while off, refuses to boot in production) are the point of these tests.
package tests_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/models"
)

// withDevAutologin flips the flag for one test and always restores it.
func withDevAutologin(t *testing.T, on bool, email string) {
	t.Helper()
	prevOn, prevEmail := config.C.DevAutologin, config.C.DevAutologinEmail
	config.C.DevAutologin, config.C.DevAutologinEmail = on, email
	t.Cleanup(func() { config.C.DevAutologin, config.C.DevAutologinEmail = prevOn, prevEmail })
}

func seedUserWithEmail(t *testing.T, orgName, email string) (orgID, userID string) {
	t.Helper()
	org := models.Organisation{Name: orgName, Plan: "free", Settings: models.JSONMap{}}
	if err := db.DB.Create(&org).Error; err != nil {
		t.Fatalf("seed org: %v", err)
	}
	u := models.User{OrganisationID: org.ID, Email: email, Name: "Demo",
		PasswordHash: "x", Role: "admin", Locale: "en"}
	if err := db.DB.Create(&u).Error; err != nil {
		t.Fatalf("seed user: %v", err)
	}
	return org.ID, u.ID
}

func TestDevSessionIsInvisibleWhileTheFlagIsOff(t *testing.T) {
	withDevAutologin(t, false, "demo@traceo.sa")
	w := do(t, "POST", "/v1/auth/dev-session", nil, nil)
	if w.Code != 404 {
		t.Fatalf("credential-free session handed out with the flag off: %d %.300s",
			w.Code, w.Body.String())
	}
	// The envelope (rather than gin's empty 404 body) also proves the route is
	// registered at all — Python exposes it, so the Go backend must too.
	detail, _ := jsonMap(t, w)["detail"].(map[string]any)
	if detail == nil || detail["code"] != "not_found" {
		t.Errorf("expected the not_found envelope, got %.300s", w.Body.String())
	}
}

func TestDevSessionReturnsTokenAndUserWhenEnabled(t *testing.T) {
	email := "demo-" + uuid.NewString()[:8] + "@traceo.sa"
	orgID, userID := seedUserWithEmail(t, "Dev Autologin Co", email)
	withDevAutologin(t, true, strings.ToUpper(email)) // case/space tolerant, like login

	w := do(t, "POST", "/v1/auth/dev-session", nil, nil)
	if w.Code != 200 {
		t.Fatalf("dev-session failed: %d %.300s", w.Code, w.Body.String())
	}
	body := jsonMap(t, w)
	token, _ := body["token"].(string)
	if token == "" {
		t.Fatal("no token in the dev-session response")
	}
	user, _ := body["user"].(map[string]any)
	if user == nil || user["id"] != userID || user["email"] != email ||
		user["organisation_id"] != orgID {
		t.Fatalf("user payload must match /auth/login's shape, got %.300s", w.Body.String())
	}
	if user["org_name"] != "Dev Autologin Co" {
		t.Errorf("org_name missing from the dev-session user payload: %v", user["org_name"])
	}

	// The token must be a real session, not a decorative string.
	me := do(t, "GET", "/v1/me", nil, map[string]string{"Authorization": "Bearer " + token})
	if me.Code != 200 || jsonMap(t, me)["id"] != userID {
		t.Fatalf("dev-session token did not authenticate: %d %.300s", me.Code, me.Body.String())
	}

	// A credential-free login must leave a trail (FR-USR-06).
	var entries []models.AuditEntry
	db.DB.Where("organisation_id = ? AND action = ?", orgID, "auth.dev_session").Find(&entries)
	if len(entries) != 1 {
		t.Fatalf("expected exactly one auth.dev_session audit entry, got %d", len(entries))
	}
	if entries[0].ObjectID != userID || entries[0].ActorID == nil || *entries[0].ActorID != userID {
		t.Errorf("audit entry does not name the user it logged in: %+v", entries[0])
	}
	if entries[0].Detail["email"] != email {
		t.Errorf("audit detail should carry the configured email, got %v", entries[0].Detail)
	}
}

func TestDevSessionIsUnavailableWhenTheConfiguredUserIsMissing(t *testing.T) {
	missing := "nobody-" + uuid.NewString()[:8] + "@traceo.sa"
	withDevAutologin(t, true, missing)

	w := do(t, "POST", "/v1/auth/dev-session", nil, nil)
	if w.Code != 503 {
		t.Fatalf("expected 503 when the configured user does not exist, got %d %.300s",
			w.Code, w.Body.String())
	}
	detail, _ := jsonMap(t, w)["detail"].(map[string]any)
	if detail == nil || detail["code"] != "dev_session_unavailable" {
		t.Fatalf("expected code dev_session_unavailable, got %.300s", w.Body.String())
	}
	// The operator needs to know which address was looked up.
	if msg, _ := detail["message"].(string); !strings.Contains(msg, missing) {
		t.Errorf("message should name the configured email, got %q", msg)
	}
}

func TestProductionRefusesToBootWithDevAutologin(t *testing.T) {
	safe := config.Settings{Env: "production", SecretKey: "a-real-unique-secret", SeedDemo: false}
	if err := config.ProductionSafetyError(safe); err != nil {
		t.Fatalf("baseline production config was rejected: %v", err)
	}
	unsafe := safe
	unsafe.DevAutologin = true
	err := config.ProductionSafetyError(unsafe)
	if err == nil {
		t.Fatal("production booted with dev auto-login on — anyone could take a session")
	}
	if !strings.Contains(err.Error(), "TRACEO_DEV_AUTOLOGIN") {
		t.Errorf("error must name the variable to fix, got: %v", err)
	}
	// Development is exactly where the flag belongs.
	dev := config.Settings{Env: "development", DevAutologin: true}
	if err := config.ProductionSafetyError(dev); err != nil {
		t.Fatalf("development must boot with dev auto-login on, got: %v", err)
	}
}
