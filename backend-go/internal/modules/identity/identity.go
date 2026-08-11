// Package identity — auth, profile, org members, audit log (FR-USR).
// 1:1 port of backend/app/modules/identity.py.
//
// Endpoints (mounted under /v1):
//   - POST   /auth/register   create Organisation + admin User, return token immediately
//   - POST   /auth/login      audited ('auth.login'); failures are generic 401s
//   - POST   /auth/dev-session  development-only credential-free session; 404 unless
//     TRACEO_DEV_AUTOLOGIN=1 (audited 'auth.dev_session')
//   - GET    /me / PATCH /me  own profile
//   - GET    /members         (view)
//   - POST   /members/invite  (manage_members)
//   - PATCH  /members/{id}    (manage_members) — cannot demote the last admin
//   - DELETE /members/{id}    (manage_members) — cannot delete yourself
//   - GET    /audit           (view_audit_log) — newest first, cursor pagination
package identity

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/models"
	"traceo/internal/security"
)

var (
	emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	roles   = []string{"admin", "qa_lead", "qa_engineer", "viewer"}
	locales = []string{"en", "ar"}
)

// --- helpers -----------------------------------------------------------------

func iso(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func userPayload(u *models.User) gin.H {
	return gin.H{
		"id":              u.ID,
		"name":            u.Name,
		"email":           u.Email,
		"role":            u.Role,
		"locale":          u.Locale,
		"organisation_id": u.OrganisationID,
		"created_at":      iso(u.CreatedAt),
	}
}

func userPayloadWithOrg(u *models.User, orgName string) gin.H {
	p := userPayload(u)
	p["org_name"] = orgName
	return p
}

func orgName(orgID string) string {
	var org models.Organisation
	if err := db.DB.First(&org, "id = ?", orgID).Error; err != nil {
		return ""
	}
	return org.Name
}

// validateEmail normalises and checks the address; writes 422 + returns ok=false on failure.
func validateEmail(c *gin.Context, email string) (string, bool) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !emailRe.MatchString(email) {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_email", "Invalid email address")
		return "", false
	}
	return email, true
}

func validateRole(c *gin.Context, role string) bool {
	for _, r := range roles {
		if r == role {
			return true
		}
	}
	httpx.Err(c, http.StatusUnprocessableEntity, "invalid_role",
		"Role must be one of: "+strings.Join(roles, ", "))
	return false
}

func validLocale(l string) bool { return l == "en" || l == "ar" }

// getMember does the org-isolated member lookup (FR-USR-04); writes 404 on failure.
func getMember(c *gin.Context, memberID string, u *models.User) (*models.User, bool) {
	var member models.User
	if err := db.DB.First(&member, "id = ?", memberID).Error; err != nil ||
		member.OrganisationID != u.OrganisationID {
		httpx.Err(c, http.StatusNotFound, "not_found", "Member not found")
		return nil, false
	}
	return &member, true
}

func adminCount(orgID string) int64 {
	var n int64
	db.DB.Model(&models.User{}).Where("organisation_id = ? AND role = ?", orgID, "admin").Count(&n)
	return n
}

func emailTaken(email string) bool {
	var n int64
	db.DB.Model(&models.User{}).Where("email = ?", email).Count(&n)
	return n > 0
}

// --- routes ------------------------------------------------------------------

func Register(r *gin.RouterGroup) {
	r.POST("/auth/register", register)
	r.POST("/auth/login", login)
	r.POST("/auth/dev-session", devSession)

	r.GET("/me", httpx.Auth(), getMe)
	r.PATCH("/me", httpx.Auth(), updateMe)

	r.GET("/members", httpx.Auth(), httpx.Require("view"), listMembers)
	r.POST("/members/invite", httpx.Auth(), httpx.Require("manage_members"), inviteMember)
	r.PATCH("/members/:member_id", httpx.Auth(), httpx.Require("manage_members"), updateMember)
	r.DELETE("/members/:member_id", httpx.Auth(), httpx.Require("manage_members"), deleteMember)

	r.GET("/audit", httpx.Auth(), httpx.Require("view_audit_log"), auditLog)
}

// --- auth --------------------------------------------------------------------

func register(c *gin.Context) {
	var body struct {
		OrgName  string  `json:"org_name"`
		Name     string  `json:"name"`
		Email    string  `json:"email"`
		Password string  `json:"password"`
		Locale   *string `json:"locale"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	if len(body.OrgName) < 1 || len(body.OrgName) > 200 ||
		len(body.Name) < 1 || len(body.Name) > 200 ||
		len(body.Password) < 8 || len(body.Password) > 200 {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid field length")
		return
	}
	email, ok := validateEmail(c, body.Email)
	if !ok {
		return
	}
	locale := "en"
	if body.Locale != nil {
		locale = *body.Locale
	}
	if !validLocale(locale) {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_locale", "Locale must be 'en' or 'ar'")
		return
	}
	if emailTaken(email) {
		httpx.Err(c, http.StatusConflict, "email_taken", "Email is already registered")
		return
	}

	hash, err := security.HashPassword(body.Password)
	if err != nil {
		httpx.Err(c, http.StatusInternalServerError, "internal_error", "Could not hash password")
		return
	}
	org := models.Organisation{Name: strings.TrimSpace(body.OrgName)}
	if err := db.DB.Create(&org).Error; err != nil {
		httpx.Err(c, http.StatusInternalServerError, "internal_error", "Could not create organisation")
		return
	}
	user := models.User{
		OrganisationID: org.ID, Email: email, Name: strings.TrimSpace(body.Name),
		PasswordHash: hash, Role: "admin", Locale: locale,
	}
	if err := db.DB.Create(&user).Error; err != nil {
		httpx.Err(c, http.StatusInternalServerError, "internal_error", "Could not create user")
		return
	}
	httpx.Audit(org.ID, &user.ID, "auth.register", "user", user.ID,
		models.JSONMap{"email": email, "org_name": org.Name})
	token, _ := security.CreateToken(user.ID, org.ID, user.Role)
	c.JSON(http.StatusCreated, gin.H{"token": token, "user": userPayloadWithOrg(&user, org.Name)})
}

func login(c *gin.Context) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	var user models.User
	found := db.DB.First(&user, "email = ?", email).Error == nil
	if !found || !security.VerifyPassword(body.Password, user.PasswordHash) {
		// Never reveal which field was wrong (NFR-SEC).
		if found {
			httpx.Audit(user.OrganisationID, &user.ID, "auth.login_failed", "user", user.ID,
				models.JSONMap{"email": email})
		}
		httpx.Err(c, http.StatusUnauthorized, "invalid_credentials", "Invalid email or password")
		return
	}
	httpx.Audit(user.OrganisationID, &user.ID, "auth.login", "user", user.ID,
		models.JSONMap{"email": email})
	token, _ := security.CreateToken(user.ID, user.OrganisationID, user.Role)
	c.JSON(http.StatusOK, gin.H{"token": token,
		"user": userPayloadWithOrg(&user, orgName(user.OrganisationID))})
}

// devSession hands out a session without credentials — development only.
//
// Enabled by TRACEO_DEV_AUTOLOGIN=1; the production guard in config refuses to
// boot with it set, so this can never be reachable on a production node. While
// the flag is off the route is indistinguishable from a missing one (404), so a
// misconfigured deployment leaks nothing about the feature's existence.
func devSession(c *gin.Context) {
	if !config.C.DevAutologin {
		httpx.Err(c, http.StatusNotFound, "not_found", "Not found")
		return
	}
	email := strings.ToLower(strings.TrimSpace(config.C.DevAutologinEmail))
	var user models.User
	if err := db.DB.First(&user, "email = ?", email).Error; err != nil {
		httpx.Err(c, http.StatusServiceUnavailable, "dev_session_unavailable",
			"TRACEO_DEV_AUTOLOGIN is on but no user matches "+email)
		return
	}
	httpx.Audit(user.OrganisationID, &user.ID, "auth.dev_session", "user", user.ID,
		models.JSONMap{"email": email})
	token, _ := security.CreateToken(user.ID, user.OrganisationID, user.Role)
	c.JSON(http.StatusOK, gin.H{"token": token,
		"user": userPayloadWithOrg(&user, orgName(user.OrganisationID))})
}

// --- own profile -------------------------------------------------------------

func getMe(c *gin.Context) {
	u := httpx.User(c)
	c.JSON(http.StatusOK, userPayloadWithOrg(u, orgName(u.OrganisationID)))
}

func updateMe(c *gin.Context) {
	u := httpx.User(c)
	var body struct {
		Name   *string `json:"name"`
		Locale *string `json:"locale"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	if body.Name != nil {
		if len(*body.Name) < 1 || len(*body.Name) > 200 {
			httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid field length")
			return
		}
		u.Name = strings.TrimSpace(*body.Name)
	}
	if body.Locale != nil {
		if !validLocale(*body.Locale) {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_locale", "Locale must be 'en' or 'ar'")
			return
		}
		u.Locale = *body.Locale
	}
	db.DB.Save(u)
	c.JSON(http.StatusOK, userPayloadWithOrg(u, orgName(u.OrganisationID)))
}

// --- members -----------------------------------------------------------------

func listMembers(c *gin.Context) {
	u := httpx.User(c)
	var members []models.User
	db.DB.Where("organisation_id = ?", u.OrganisationID).
		Order("created_at asc").Find(&members)
	out := make([]gin.H, 0, len(members))
	for i := range members {
		out = append(out, userPayload(&members[i]))
	}
	c.JSON(http.StatusOK, out)
}

func inviteMember(c *gin.Context) {
	u := httpx.User(c)
	var body struct {
		Email    string  `json:"email"`
		Name     string  `json:"name"`
		Role     *string `json:"role"`
		Password string  `json:"password"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	if len(body.Name) < 1 || len(body.Name) > 200 ||
		len(body.Password) < 8 || len(body.Password) > 200 {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid field length")
		return
	}
	email, ok := validateEmail(c, body.Email)
	if !ok {
		return
	}
	role := "qa_engineer"
	if body.Role != nil {
		role = *body.Role
	}
	if !validateRole(c, role) {
		return
	}
	if emailTaken(email) {
		httpx.Err(c, http.StatusConflict, "email_taken", "Email is already registered")
		return
	}
	hash, err := security.HashPassword(body.Password)
	if err != nil {
		httpx.Err(c, http.StatusInternalServerError, "internal_error", "Could not hash password")
		return
	}
	member := models.User{
		OrganisationID: u.OrganisationID, Email: email, Name: strings.TrimSpace(body.Name),
		PasswordHash: hash, Role: role,
	}
	if err := db.DB.Create(&member).Error; err != nil {
		httpx.Err(c, http.StatusInternalServerError, "internal_error", "Could not create user")
		return
	}
	httpx.Audit(u.OrganisationID, &u.ID, "member.invite", "user", member.ID,
		models.JSONMap{"email": email, "role": role})
	c.JSON(http.StatusCreated, userPayload(&member))
}

func updateMember(c *gin.Context) {
	u := httpx.User(c)
	var body struct {
		Role string `json:"role"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	if !validateRole(c, body.Role) {
		return
	}
	member, ok := getMember(c, c.Param("member_id"), u)
	if !ok {
		return
	}
	if member.Role == "admin" && body.Role != "admin" && adminCount(u.OrganisationID) <= 1 {
		httpx.Err(c, http.StatusBadRequest, "last_admin",
			"Cannot demote the last admin of the organisation")
		return
	}
	oldRole := member.Role
	member.Role = body.Role
	db.DB.Save(member)
	httpx.Audit(u.OrganisationID, &u.ID, "member.role_change", "user", member.ID,
		models.JSONMap{"from": oldRole, "to": body.Role})
	c.JSON(http.StatusOK, userPayload(member))
}

func deleteMember(c *gin.Context) {
	u := httpx.User(c)
	member, ok := getMember(c, c.Param("member_id"), u)
	if !ok {
		return
	}
	if member.ID == u.ID {
		httpx.Err(c, http.StatusBadRequest, "cannot_delete_self",
			"You cannot delete your own account")
		return
	}
	if member.Role == "admin" && adminCount(u.OrganisationID) <= 1 {
		httpx.Err(c, http.StatusBadRequest, "last_admin",
			"Cannot delete the last admin of the organisation")
		return
	}
	httpx.Audit(u.OrganisationID, &u.ID, "member.delete", "user", member.ID,
		models.JSONMap{"email": member.Email})
	db.DB.Delete(&models.User{}, "id = ?", member.ID)
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

// --- audit log ---------------------------------------------------------------

func auditLog(c *gin.Context) {
	u := httpx.User(c)
	limit, err := strconv.Atoi(c.DefaultQuery("limit", "50"))
	if err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "limit must be an integer")
		return
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}

	q := db.DB.Model(&models.AuditEntry{}).Where("organisation_id = ?", u.OrganisationID)
	if cursor := c.Query("cursor"); cursor != "" {
		var anchor models.AuditEntry
		if err := db.DB.First(&anchor, "id = ?", cursor).Error; err != nil ||
			anchor.OrganisationID != u.OrganisationID {
			httpx.Err(c, http.StatusBadRequest, "invalid_cursor", "Unknown cursor")
			return
		}
		q = q.Where("occurred_at < ? OR (occurred_at = ? AND id < ?)",
			anchor.OccurredAt, anchor.OccurredAt, anchor.ID)
	}
	var entries []models.AuditEntry
	q.Order("occurred_at desc, id desc").Limit(limit + 1).Find(&entries)

	hasMore := len(entries) > limit
	if hasMore {
		entries = entries[:limit]
	}
	items := make([]gin.H, 0, len(entries))
	for _, e := range entries {
		detail := e.Detail
		if detail == nil {
			detail = models.JSONMap{}
		}
		items = append(items, gin.H{
			"id":          e.ID,
			"actor_id":    e.ActorID,
			"action":      e.Action,
			"object_type": e.ObjectType,
			"object_id":   e.ObjectID,
			"detail":      detail,
			"occurred_at": iso(e.OccurredAt),
		})
	}
	var nextCursor any
	if hasMore && len(entries) > 0 {
		nextCursor = entries[len(entries)-1].ID
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "next_cursor": nextCursor})
}
