// Package db: singleton GORM connection (pure-Go sqlite) + migrate + demo seed.
package db

import (
	"log"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"traceo/internal/config"
	"traceo/internal/models"
	"traceo/internal/security"
)

var DB *gorm.DB

func Open() *gorm.DB {
	if DB != nil {
		return DB
	}
	g, err := gorm.Open(sqlite.Open(config.C.DatabaseURL+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	if err := g.AutoMigrate(models.All()...); err != nil {
		log.Fatalf("db migrate: %v", err)
	}
	sqlDB, _ := g.DB()
	sqlDB.SetMaxOpenConns(1) // sqlite: single writer, avoids SQLITE_BUSY under goroutines
	DB = g
	return DB
}

// SeedDemo creates the demo org + users when absent (parity with the Python backend).
func SeedDemo() {
	var n int64
	DB.Model(&models.User{}).Where("email = ?", "demo@traceo.sa").Count(&n)
	if n > 0 {
		return
	}
	org := models.Organisation{Name: "Traceo Demo Org", Plan: "team", Settings: models.JSONMap{}}
	DB.Create(&org)
	h1, _ := security.HashPassword("Demo1234!")
	DB.Create(&models.User{OrganisationID: org.ID, Email: "demo@traceo.sa", Name: "Nawaf Al-Qahtani", PasswordHash: h1, Role: "qa_lead", Locale: "en"})
	h2, _ := security.HashPassword("Demo1234!")
	DB.Create(&models.User{OrganisationID: org.ID, Email: "admin@traceo.sa", Name: "Reem Al-Otaibi", PasswordHash: h2, Role: "admin", Locale: "en"})
}
