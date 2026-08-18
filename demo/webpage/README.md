# Demo web page

A static page for exercising the web-target flow end to end (docs/WEB_TARGETS.md §6–7).

```bash
python3 -m http.server 8777 --directory demo/webpage
```

Then, with the backend running with `TRACEO_ALLOW_PRIVATE_TARGETS=1`:

1. Target → `http://localhost:8777/`, test types **functional** + **performance** → *Start discovery*
2. *View* the discovered target → **Run checks**

Expected: **7 checks, 5 passed, 2 need fixing** — the two bugs planted in `index.html`
(a required field nobody enforces, and a field that ignores its own `maxlength`). Each failure
carries a fix prompt naming the requirement it violated.

The other three checks (required-field enforcement on `username`, the `phone` pattern, the page-load
budget) are correct on this page: a run that fails them is a bug in the runner, not in the page.
