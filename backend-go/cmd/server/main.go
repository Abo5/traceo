// Traceo Go backend — entrypoint. Mounts every module under /v1 and serves :8000.
package main

import (
	"log"
	"net/http"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/modules/discovery"
	"traceo/internal/modules/execution"
	"traceo/internal/modules/generation"
	"traceo/internal/modules/identity"
	"traceo/internal/modules/ingestion"
	"traceo/internal/modules/integrations"
	"traceo/internal/modules/projects"
	"traceo/internal/modules/reference"
	"traceo/internal/modules/reporting"
	"traceo/internal/modules/review"
	"traceo/internal/modules/traceability"
)

func buildEngine() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(cors.New(cors.Config{
		AllowOrigins:     config.C.CORSOrigins,
		AllowMethods:     []string{"GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Authorization", "Content-Type", "X-API-Key"},
		AllowCredentials: true,
	}))

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "app": config.C.AppName, "engine": "go"})
	})

	v1 := r.Group(config.C.APIPrefix)

	// jobs endpoint (authenticated)
	v1.GET("/jobs/:id", httpx.Auth(), func(c *gin.Context) {
		j := jobs.Get(c.Param("id"))
		if j == nil {
			httpx.Err(c, http.StatusNotFound, "not_found", "Job not found")
			return
		}
		c.JSON(http.StatusOK, j.Snapshot())
	})

	for _, reg := range []func(*gin.RouterGroup){
		identity.Register, projects.Register, ingestion.Register, discovery.Register,
		generation.Register, review.Register, execution.Register, traceability.Register,
		reporting.Register, integrations.Register, reference.Register,
	} {
		reg(v1)
	}
	return r
}

func main() {
	config.Load()
	db.Open()
	if config.C.SeedDemo {
		db.SeedDemo()
	}
	// Scheduler → execution wiring. integrations must not import execution (that
	// would cycle: execution imports integrations to fire webhooks), so the
	// scheduled-launch entrypoint is injected here instead.
	integrations.LaunchRunForSchedule = execution.LaunchRunForSchedule
	integrations.StartScheduler()
	engine := buildEngine()
	log.Printf("Traceo Go backend on :%s", config.C.Port)
	if err := engine.Run(":" + config.C.Port); err != nil {
		log.Fatal(err)
	}
}
