package webtarget

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"traceo/internal/config"
	"traceo/internal/jobs"
)

// BrowserUnavailable is the one failure that must never be silent: an empty
// result from a missing sidecar looks exactly like "the page has nothing on
// it", which is the difference between a broken install and a true finding.
const BrowserUnavailable = "browser_discovery_unavailable"

// unavailableMarkers mean the sidecar could not run at all, as opposed to
// running and failing on the page. Matched case-insensitively against stderr.
var unavailableMarkers = []string{
	"cannot find module 'playwright",
	`cannot find module "playwright`,
	"cannot find package 'playwright",
	"playwright is not installed",
	"executable doesn't exist",
	"please run the following command to download new browsers",
	"err_module_not_found",
}

var unavailableCodes = map[string]bool{
	BrowserUnavailable: true, "playwright_missing": true, "browser_missing": true,
	"node_missing": true, "sidecar_missing": true,
}

func installHint(reason string) string {
	return fmt.Sprintf("%s Browser discovery needs Node.js and Playwright: install Node 18+, "+
		"then run `npm install` in %s (or in e2e/, which already has Playwright) and "+
		"`npx playwright install chromium`. Point TRACEO_NODE_BIN / "+
		"TRACEO_WEB_DISCOVERY_SCRIPT at them if they live elsewhere.",
		reason, filepath.Dir(config.C.WebDiscoveryScript))
}

// SidecarCommand is the exact argv the discovery sidecar is invoked with. The
// password is NEVER in it — see CrawlPasswordEnv.
func SidecarCommand(url, viewport, outDir string, timeoutMS int, plan *CrawlPlan) []string {
	argv := []string{config.C.NodeBin, config.C.WebDiscoveryScript,
		"--url", url, "--out", outDir,
		"--viewport", viewport, "--timeout", fmt.Sprint(timeoutMS)}
	if plan != nil {
		argv = append(argv, "--max-pages", strconv.Itoa(plan.MaxPages),
			"--max-depth", strconv.Itoa(plan.MaxDepth))
		if plan.SignsIn() {
			argv = append(argv, "--username", plan.Username)
		}
	}
	return argv
}

// SidecarEnv is the child's environment, and the ONLY place a password is
// written. An inherited value is dropped first: a server process that happens to
// carry TRACEO_CRAWL_PASSWORD must not make an anonymous crawl sign in with
// somebody else's secret.
func SidecarEnv(plan *CrawlPlan) []string {
	out := make([]string, 0, len(os.Environ())+2)
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, CrawlPasswordEnv+"=") {
			continue
		}
		out = append(out, entry)
	}
	if config.C.AllowPrivateTargets {
		out = append(out, "TRACEO_ALLOW_PRIVATE_TARGETS=1")
	}
	if plan.SignsIn() {
		out = append(out, CrawlPasswordEnv+"="+plan.Password)
	}
	return out
}

// RunSidecar renders the target and returns the sidecar's JSON document, or a
// coded jobs.Error. With no plan it renders exactly one page, the way it always
// did; with one, the same sidecar signs in if the page asks to be signed into
// and follows links up to the plan's budget.
func RunSidecar(url, viewport, outDir string, timeoutS float64,
	plan *CrawlPlan) (map[string]any, error) {
	script := config.C.WebDiscoveryScript
	if info, err := os.Stat(script); err != nil || info.IsDir() {
		return nil, jobs.Fail(BrowserUnavailable,
			installHint("The discovery sidecar is missing at "+script+"."))
	}
	if timeoutS <= 0 {
		timeoutS = config.C.WebDiscoveryTimeout
	}
	// --timeout is the per-navigation ceiling; a crawl may legitimately spend
	// that long once per page, so the kill deadline scales with the budget.
	pages := 1
	if plan != nil && plan.MaxPages > 1 {
		pages = plan.MaxPages
	}
	ctx, cancel := context.WithTimeout(context.Background(),
		time.Duration((timeoutS*float64(pages)+30.0)*float64(time.Second)))
	defer cancel()

	argv := SidecarCommand(url, viewport, outDir, int(timeoutS*1000), plan)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = filepath.Dir(script)
	cmd.Env = SidecarEnv(plan)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	if ctx.Err() == context.DeadlineExceeded {
		return nil, jobs.Fail("discovery_timeout", fmt.Sprintf(
			"The browser did not finish within %.0fs — raise "+
				"TRACEO_WEB_DISCOVERY_TIMEOUT_S or check the URL.", timeoutS+30.0))
	}
	// The binary could not be started at all: exec.Error when it was looked up on
	// PATH, a bare *fs.PathError when an absolute path was given. Both mean the
	// same thing to the user, and neither is an exit status.
	var execErr *exec.Error
	if errors.As(runErr, &execErr) || errors.Is(runErr, exec.ErrNotFound) ||
		errors.Is(runErr, fs.ErrNotExist) || errors.Is(runErr, fs.ErrPermission) {
		return nil, jobs.Fail(BrowserUnavailable, installHint(
			fmt.Sprintf("Node.js was not found (tried '%s').", config.C.NodeBin)))
	}

	errText := strings.TrimSpace(stderr.String())
	lowered := strings.ToLower(errText)
	for _, marker := range unavailableMarkers {
		if strings.Contains(lowered, marker) {
			return nil, jobs.Fail(BrowserUnavailable,
				installHint("The discovery sidecar could not start Playwright."))
		}
	}

	doc := firstJSONObject(stdout.String())
	if doc == nil {
		if runErr != nil {
			detail := errText
			if detail == "" {
				detail = "no output"
			}
			return nil, jobs.Fail("discovery_failed",
				"The discovery sidecar failed: "+trunc(detail, 500))
		}
		return nil, jobs.Fail("discovery_failed",
			"The discovery sidecar produced no JSON document.")
	}
	if code, message, reported := payloadError(doc); reported {
		if unavailableCodes[code] {
			return nil, jobs.Fail(BrowserUnavailable, installHint(message))
		}
		// The sidecar's own login message is REPLACED, not forwarded: it is the
		// one message that could carry a credential, and no downstream reader can
		// tell a safe one from a leaky one.
		if code == LoginFailed {
			return nil, jobs.Fail(LoginFailed, LoginFailedMessage)
		}
		return nil, jobs.Fail(code, message)
	}
	return doc, nil
}

// firstJSONObject locates the sidecar's JSON document even when something
// printed noise first — Node writes warnings to stdout more often than anyone
// would like.
func firstJSONObject(text string) map[string]any {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(trimmed), &doc); err == nil {
		return doc
	}
	for start := strings.Index(trimmed, "{"); start != -1; {
		var candidate map[string]any
		dec := json.NewDecoder(strings.NewReader(trimmed[start:]))
		if err := dec.Decode(&candidate); err == nil {
			return candidate
		}
		next := strings.Index(trimmed[start+1:], "{")
		if next == -1 {
			break
		}
		start = start + 1 + next
	}
	return nil
}

// payloadError reports the error object the sidecar wrote, if any.
func payloadError(doc map[string]any) (string, string, bool) {
	if em := asMap(doc["error"]); em != nil {
		return firstNonEmpty(str(em["code"]), "discovery_failed"),
			firstNonEmpty(str(em["message"]), "The page could not be discovered."), true
	}
	if msg, isStr := doc["error"].(string); isStr && strings.TrimSpace(msg) != "" {
		return firstNonEmpty(str(doc["code"]), "discovery_failed"), strings.TrimSpace(msg), true
	}
	if ok, present := doc["ok"].(bool); present && !ok {
		return firstNonEmpty(str(doc["code"]), "discovery_failed"),
			firstNonEmpty(str(doc["message"]), "The page could not be discovered."), true
	}
	return "", "", false
}
