# Visual UI testing without AI — colour-analysis plan

> Design plan for a seventh Traceo engine: catching UI regressions by **decomposing screenshot colour**, deterministically, with no model in the loop.
>
> Status: proposal. Nothing here is implemented yet.

## Why colour, and why no AI

Traceo's guarantee is that a finding is *derivable*: the same input produces the same verdict, offline, and every identifier in a generated artefact came from a document the user supplied. A vision model breaks all three — it is non-deterministic, needs the network, and cannot cite why it flagged a pixel.

Colour comparison keeps the guarantee. A screenshot is a matrix of numbers; a regression is an arithmetic difference between two matrices. The verdict is reproducible on any machine, explainable down to the pixel, and the evidence (the diff image) *is* the argument.

The engine answers one question: **did this screen change in a way a human would notice, and where?** It does not answer "is this screen good", which is a design judgement no pixel comparison can make.

---

## 1. Where it fits

A seventh engine beside the existing six, reusing the run machinery rather than inventing a parallel one.

```mermaid
flowchart LR
    REQ[Requirement] --> SC[Screen<br/>route + viewport + state]
    SC --> BL[(Baseline<br/>approved image)]
    SC --> RUN[Visual run<br/>capture → compare]
    BL --> RUN
    RUN --> VD[Verdict + diff evidence]
    VD --> RV[Human review<br/>accept as new baseline / file defect]
    RV --> BL
```

The shape mirrors the API side exactly, and that is the point: a **screen** is to visual testing what an **endpoint** is to API testing — the grounded unit that a case must reference. A visual case whose screen is not in the inventory is discarded, the same way a test case referencing an undiscovered endpoint is discarded today (BO-07).

**Human gate preserved.** A capture never becomes a baseline on its own. A new baseline is an approval, recorded with who approved it and when — otherwise a regression silently becomes the new normal, which is the classic way visual suites rot into noise.

---

## 2. The screen inventory (discovery, no AI)

The same fidelity ladder the endpoint inventory uses:

| Source | How the screen is discovered | Fidelity |
|---|---|---|
| `route` | Declared by the user or read from the app's route manifest (Next.js `app/**/page.tsx`, a router config, a sitemap) | highest |
| `crawl` | A headless crawl from a seed URL following in-origin links, deduplicated by templated path | medium |
| `manual` | Added by hand for a state a crawl cannot reach (a modal, an error state) | lowest |

A screen is the tuple **(path, viewport, state)** — `/projects/{id}` at 1280×720 logged in as `qa_lead` is a different screen from the same path at 390×844 as `viewer`. This is what makes the inventory finite and greppable instead of "every possible pixel arrangement".

---

## 3. The comparison algorithm

Four stages, each cheap, each explainable. Everything below is integer or float arithmetic on arrays — no dependency heavier than an image decoder.

### 3.1 Normalise before comparing

Comparison is meaningless if the two images disagree on anything but content:

- **Fixed viewport and device pixel ratio**, recorded on the baseline and enforced on capture; a mismatch is a configuration error, not a diff.
- **Disable animation and caret blink** (`prefers-reduced-motion`, `animation-duration: 0`), and wait for fonts and network idle before the shot. Most visual-suite flakiness is a screenshot taken mid-transition, not a real difference.
- **Freeze time-dependent content** through masks (§3.4) rather than hoping it matches.

### 3.2 Perceptual colour distance, not RGB equality

Comparing raw RGB triples flags differences no human can see and misses some they can. Convert both images to **CIE Lab** and measure with **ΔE (CIEDE2000)**, the standard model of how different two colours *look*:

```
sRGB → linear RGB → CIE XYZ (D65) → CIE Lab → ΔE₀₀(pixel_base, pixel_new)
```

The thresholds are then meaningful rather than arbitrary:

| ΔE₀₀ | Meaning | Default policy |
|---|---|---|
| < 1.0 | Imperceptible to the human eye | ignore |
| 1–2 | Visible only side by side | ignore (tunable) |
| 2–5 | Noticeable at a glance | count as a differing pixel |
| > 5 | Obvious | count, and weight it in severity |

Anti-aliasing is the main false-positive source: text edges legitimately shift by a subpixel between renders. A pixel is treated as anti-aliasing noise — and skipped — when it differs but **at least two of its eight neighbours** are close matches and its own ΔE is under a small edge threshold. This is the standard trick that makes text-heavy pages usable in a visual suite.

### 3.3 Three complementary measures

One number is never enough; report all three, and let the gate use them together.

1. **Pixel ratio** — differing pixels ÷ compared pixels. Answers *how much* changed. Cheap, and the basis of the primary threshold.
2. **Cluster analysis** — connected-component labelling over the difference mask, producing bounding boxes. Answers *where*, and separates one moved button (one dense cluster) from a global colour shift (thousands of scattered pixels). A small dense cluster is far more likely to be a real regression than the same pixel count spread thinly.
3. **Colour histogram distance** — a 3-D Lab histogram per image, compared with earth-mover's or χ² distance. Catches a *palette* change: a theme token altered site-wide moves the histogram sharply while the layout is untouched, and it survives a one-pixel layout shift that would make a per-pixel diff useless.

The third measure is what the user asked for — "developing" the image's colours — and it is the one that answers questions per-pixel diffing cannot: *did the brand palette drift? did contrast collapse? did dark mode leak into light mode?*

### 3.4 Ignore regions, declared not guessed

Timestamps, avatars, charts of live data and randomised ids change legitimately. Each screen carries a list of **masks** — CSS selectors resolved to boxes at capture time, or literal rectangles — which are filled with a flat colour in both images before comparison and excluded from the denominator.

Selectors, not coordinates, wherever possible: a rectangle silently stops covering the thing it was meant to cover the moment the layout moves, and then the suite is green for the wrong reason.

### 3.5 Bonus: accessibility contrast, free of charge

The Lab conversion is already done, so the engine can compute **WCAG contrast ratios** for text regions on the same pass and fail a screen whose contrast fell below AA. This is deterministic, needs no model, and reuses the `a11y` delta-baseline policy the Playwright suite already applies to the product itself.

---

## 4. Verdicts and severity

Deterministic mapping from measurements to an outcome, so the same capture always yields the same verdict:

| Verdict | Rule |
|---|---|
| `passed` | pixel ratio ≤ threshold, no cluster exceeds its area limit, histogram distance ≤ limit |
| `failed` | any threshold exceeded |
| `errored` | capture failed — page did not load, viewport mismatch, baseline missing |
| `new` | no baseline yet: recorded, never auto-approved, and reported as a gap |

Severity ranks the *review queue*, it does not decide the verdict: a large dense cluster in the upper third of the page (where primary actions live) outranks a thin scattered difference at the footer.

---

## 5. Data model

Four tables, following the existing conventions (org-scoped, append-only audit, states copied verbatim into `data-state` badges):

| Table | Purpose | States |
|---|---|---|
| `Screen` | The grounded unit: path, viewport, actor role, masks, source | `active \| excluded` |
| `VisualBaseline` | Approved image + its capture metadata; versioned, never overwritten | `approved \| superseded` |
| `VisualCapture` | One shot taken during a run | — |
| `VisualResult` | Verdict + measurements + diff-image key | `passed \| failed \| errored \| new` |

Images live in the existing storage directory, addressed by content hash so an unchanged screen costs nothing to re-record. Retention mirrors the artefact policy already in the architecture doc: baselines forever, captures and diffs 14 days.

---

## 6. API surface

No new concepts on the wire — the same async `202 {job_id}` pattern as every other long operation:

```
GET    /v1/projects/{id}/screens                 discovered screen inventory
POST   /v1/projects/{id}/screens                 add a screen manually
PATCH  /v1/screens/{id}                          masks, viewport, exclusion
POST   /v1/projects/{id}/screens/discover        202 — crawl or read the route manifest
GET    /v1/screens/{id}/baseline                 current approved baseline
POST   /v1/screens/{id}/baseline                 approve a capture as the baseline (audited)
POST   /v1/projects/{id}/visual-runs             202 — capture + compare
GET    /v1/visual-runs/{id}                      counts + state
GET    /v1/visual-runs/{id}/results              per-screen verdicts + measurements
GET    /v1/visual-results/{id}/diff.png          the diff image (evidence)
```

Go parity is mandatory, as for every route. The comparison itself is pure arithmetic and ports cleanly; the **capture** is the one piece that needs a browser, which is why §8 keeps it behind a boundary.

---

## 7. UI

One new page in the Analysis group, plus a review surface:

- **Screens** — the inventory, with each screen's baseline thumbnail, viewport, masks and last verdict.
- **Visual run report** — the standard three-pane diff: baseline, current, and the diff overlay with clusters boxed; the measurements beside it (pixel ratio, largest cluster, histogram distance, contrast findings).
- **Review action** — *Accept as new baseline* (audited) or *File defect*, mirroring the approve/reject pair the test-case review already uses.

Testids follow the existing convention: `screens-page-root`, `screens-row`, `screens-row-verdict-badge` carrying `data-state`, `visual-result-accept-baseline-button`, and so on.

---

## 8. The browser problem, stated honestly

Everything above is deterministic arithmetic **except capture**, which needs a real browser, and that collides with the air-gapped constraint (NFR-D1) the same way the traffic-capture feature does.

Three options, in order of preference:

1. **Bake a pinned browser into the deployment image.** Predictable, offline, and the same approach the CI images already take. Cost: image size.
2. **Accept uploaded screenshots.** The engine compares whatever it is given, and capture becomes the client's problem — a CI job, a mobile harness, a manual upload. Zero browser dependency, and it makes the engine usable for native apps too.
3. **A capture sidecar service** the operator runs separately, reachable over the internal network.

**Recommended: ship (2) first.** The comparison engine is the whole value; capture is plumbing that every team already has. Shipping the comparator alone means a customer can point their existing Playwright/Cypress screenshots at Traceo on day one, and it keeps the core deterministic and dependency-free. Add (1) as a convenience once the comparator has earned its keep.

---

## 9. Rollout

| Phase | Deliverable | Depends on |
|---|---|---|
| **V0 — comparator** | Lab/ΔE₀₀ diff, anti-aliasing suppression, masks, three measures, diff-image output. Pure functions with a golden-image test set covering: identical, imperceptible shift, moved element, palette change, layout reflow. | nothing |
| **V1 — data + API** | Screen inventory, baselines, visual runs, results; upload-a-screenshot capture path; Go parity. | V0 |
| **V2 — UI** | Screens page, three-pane diff report, accept-baseline flow. | V1 |
| **V3 — capture** | Bundled headless browser, route-manifest discovery and crawl, viewport matrix. | V1 |
| **V4 — gates** | Visual gate in the CI endpoint (`/gate`), contrast findings folded into the a11y policy, severity-ranked review queue. | V2 |

V0 is where the engineering risk is, and it is testable without any of the rest: a directory of image pairs and their expected verdicts.

---

## 10. What this will not do

Stated plainly so nobody expects it later:

- It cannot tell you a design is **wrong** — only that it **changed**. The judgement stays human, which is the same division of labour the rest of the product uses.
- It cannot survive genuinely dynamic content without masks. A screen full of live data needs its masks declared, or it will be noise.
- A **one-pixel layout shift** moves everything below it. Per-pixel comparison reports that honestly as a large diff; the cluster analysis and the histogram are what keep it interpretable instead of just alarming.
- Cross-browser and cross-OS rendering differ enough that a baseline is only valid for the platform that produced it. Baselines are therefore keyed by platform, and comparing across platforms is refused rather than fudged.
