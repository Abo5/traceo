// Package httpx: error envelope, auth middleware, org scoping, audit — the conventions
// every module handler uses (see GO_CONTRACT.md).
package httpx

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"traceo/internal/db"
	"traceo/internal/models"
	"traceo/internal/security"
)

// Err writes the FastAPI-compatible error envelope: {"detail":{"code","message"}}.
func Err(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"detail": gin.H{"code": code, "message": message}})
}

// Auth resolves the Bearer JWT into c["user"] (*models.User).
func Auth() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			Err(c, http.StatusUnauthorized, "unauthenticated", "Missing bearer token")
			return
		}
		claims, err := security.DecodeToken(strings.TrimSpace(strings.TrimPrefix(h, "Bearer ")))
		if err != nil {
			Err(c, http.StatusUnauthorized, "invalid_token", "Invalid or expired token")
			return
		}
		var user models.User
		if e := db.DB.First(&user, "id = ?", claims.Sub).Error; e != nil {
			Err(c, http.StatusUnauthorized, "unknown_user", "User not found")
			return
		}
		c.Set("user", &user)
		c.Next()
	}
}

// APIKeyResolver resolves an `X-API-Key` header into a synthetic org-scoped actor.
// The integrations module installs it at Register() time; it stays nil when that
// module is not mounted, in which case AuthOrAPIKey degrades to plain Auth().
var APIKeyResolver func(key string) (*models.User, bool)

// AuthOrAPIKey is Auth() plus `X-API-Key` as an alternative credential. Per
// API_CONTRACT_V2_ADDENDUM.md the key is honoured ONLY on the public CI surface
// (gate, traceability read, run read, run launch) — every other route keeps Auth().
func AuthOrAPIKey() gin.HandlerFunc {
	return func(c *gin.Context) {
		key := c.GetHeader("X-API-Key")
		if key == "" || APIKeyResolver == nil {
			Auth()(c)
			return
		}
		actor, ok := APIKeyResolver(key)
		if !ok {
			Err(c, http.StatusUnauthorized, "invalid_api_key", "Unknown or revoked API key")
			return
		}
		c.Set("user", actor)
		c.Next()
	}
}

// Require checks a capability from the permission matrix. Use after Auth().
func Require(capability string) gin.HandlerFunc {
	return func(c *gin.Context) {
		u := User(c)
		if u == nil {
			Err(c, http.StatusUnauthorized, "unauthenticated", "Missing user")
			return
		}
		if !security.Has(u.Role, capability) {
			Err(c, http.StatusForbidden, "forbidden", "Role '"+u.Role+"' lacks '"+capability+"'")
			return
		}
		c.Next()
	}
}

func User(c *gin.Context) *models.User {
	if v, ok := c.Get("user"); ok {
		if u, ok2 := v.(*models.User); ok2 {
			return u
		}
	}
	return nil
}

// ProjectScoped loads the project ONLY if it belongs to the caller's organisation
// (FR-USR-04 / NFR-SEC-04). On failure it writes 404 and returns ok=false.
func ProjectScoped(c *gin.Context, projectID string) (*models.Project, bool) {
	u := User(c)
	var p models.Project
	if err := db.DB.First(&p, "id = ? AND organisation_id = ?", projectID, u.OrganisationID).Error; err != nil {
		Err(c, http.StatusNotFound, "not_found", "Project not found")
		return nil, false
	}
	return &p, true
}

// Audit appends an immutable audit entry (FR-USR-06).
func Audit(orgID string, actorID *string, action, objType, objID string, detail models.JSONMap) {
	if detail == nil {
		detail = models.JSONMap{}
	}
	db.DB.Create(&models.AuditEntry{
		OrganisationID: orgID, ActorID: actorID, Action: action,
		ObjectType: objType, ObjectID: objID, Detail: detail,
	})
}
