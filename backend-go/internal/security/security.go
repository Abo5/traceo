// Package security: Argon2id passwords, JWT sessions, permission matrix (SRS §4.10),
// AES-GCM secret box, redaction-at-capture (NFR-SEC-03).
package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/golang-jwt/jwt/v5"

	"traceo/internal/config"
)

func HashPassword(pw string) (string, error) {
	return argon2id.CreateHash(pw, argon2id.DefaultParams)
}

func VerifyPassword(pw, hash string) bool {
	ok, err := argon2id.ComparePasswordAndHash(pw, hash)
	return err == nil && ok
}

type Claims struct {
	Sub  string `json:"sub"`
	Org  string `json:"org"`
	Role string `json:"role"`
	jwt.RegisteredClaims
}

func CreateToken(userID, orgID, role string) (string, error) {
	c := Claims{
		Sub: userID, Org: orgID, Role: role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Duration(config.C.TokenTTLH) * time.Hour)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(config.C.SecretKey))
}

func DecodeToken(tok string) (*Claims, error) {
	var c Claims
	t, err := jwt.ParseWithClaims(tok, &c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(config.C.SecretKey), nil
	})
	if err != nil || !t.Valid {
		return nil, errors.New("invalid token")
	}
	return &c, nil
}

// ---- Permission matrix (SRS §4.10) — identical to the Python backend ----

var permissions = map[string][]string{
	"manage_members":      {"admin"},
	"manage_projects":     {"admin", "qa_lead"},
	"manage_environments": {"admin", "qa_lead"},
	"upload_documents":    {"admin", "qa_lead", "qa_engineer"},
	"edit_requirements":   {"admin", "qa_lead", "qa_engineer"},
	"import_spec":         {"admin", "qa_lead", "qa_engineer"},
	"generate":            {"admin", "qa_lead", "qa_engineer"},
	"edit_test_case":      {"admin", "qa_lead", "qa_engineer"},
	"approve_reject":      {"admin", "qa_lead"},
	"trigger_run":         {"admin", "qa_lead", "qa_engineer"},
	"view":                {"admin", "qa_lead", "qa_engineer", "viewer"},
	"export":              {"admin", "qa_lead", "qa_engineer", "viewer"},
	"view_audit_log":      {"admin", "qa_lead"},
}

func Has(role, capability string) bool {
	for _, r := range permissions[capability] {
		if r == role {
			return true
		}
	}
	return false
}

// ---- Secret box (environment auth configs) — AES-256-GCM, key derived from SecretKey ----

func boxKey() []byte {
	k := sha256.Sum256([]byte("traceo-secrets:" + config.C.SecretKey))
	return k[:]
}

func Encrypt(data map[string]any) []byte {
	raw, _ := json.Marshal(data)
	block, _ := aes.NewCipher(boxKey())
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	_, _ = rand.Read(nonce)
	return append(append([]byte("AGCM"), nonce...), gcm.Seal(nil, nonce, raw, nil)...)
}

func Decrypt(blob []byte) map[string]any {
	out := map[string]any{}
	if len(blob) < 4+12 || string(blob[:4]) != "AGCM" {
		return out
	}
	block, err := aes.NewCipher(boxKey())
	if err != nil {
		return out
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return out
	}
	ns := gcm.NonceSize()
	raw, err := gcm.Open(nil, blob[4:4+ns], blob[4+ns:], nil)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}

const SecretMask = "••••••••"

// Redact replaces secret values in text at capture point — never store unredacted.
func Redact(text string, secrets []string) string {
	for _, s := range secrets {
		if len(s) > 3 {
			text = strings.ReplaceAll(text, s, SecretMask)
		}
	}
	return text
}
