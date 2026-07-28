# Design Specification — Traceo

**Version 2.0 · 26 July 2026**
The design system behind `index.html`. Dark-only, high-contrast, built for long sessions reading tables.

---

## 1. Principles

1. **The verdict is the interface.** Pass, fail and gap are the three states everything reduces to. They get colour, weight and position before anything else does.
2. **Never colour alone.** Every verdict carries a text label as well as a hue.
3. **Density over decoration.** QA leads read tables. Padding serves scanning, not whitespace aesthetics.
4. **A reference beside every feature.** FR-### chips sit next to the control they name, so the interface, the BRD and the conversation use one vocabulary.
5. **RTL is a first-class layout, not a stylesheet override.** Every rule below mirrors.

---

## 2. Colour

### 2.1 Surfaces

| Token | Value | Use |
|---|---|---|
| `--bg` | `#131217` | Page background |
| `--surface` | `#1B1A21` | Cards, sidebar, topbar |
| `--surface-2` | `#22212B` | Inputs, nested cards, table row hover |
| `--surface-3` | `#2C2B37` | Neutral badges, active tab, bar track |
| `--overlay` | `rgba(7,7,11,.66)` | Scrim behind panels |

### 2.2 Borders and text

| Token | Value | Use |
|---|---|---|
| `--border` | `#312F3C` | Default 1px border, table row divider |
| `--border-strong` | `#443F54` | Secondary buttons, dashed drop zone, open accordion |
| `--text` | `#F2EFF7` | Primary text |
| `--text-secondary` | `#ADA8BB` | Body copy, labels |
| `--text-muted` | `#756F84` | Metadata, crumbs, timestamps |

### 2.3 Accent

| Token | Value | Use |
|---|---|---|
| `--accent` | `#FF9B3D` | Active navigation, links, reference chips |
| `--accent-fill` | `#FF8A22` | Primary button background |
| `--accent-fill-press` | `#F07A12` | Primary button hover |
| `--accent-fg` | `#211405` | Text on accent fill |
| `--accent-subtle` | `rgba(255,138,34,.16)` | Active nav background, accent badges |
| `--accent-ring` | `rgba(255,138,34,.42)` | Focus ring |

### 2.4 Semantic

| Token | Value | Meaning |
|---|---|---|
| `--success` | `#3FD179` | Passed, verified, connected, coverage ≥ 85% |
| `--warning` | `#FFC53D` | Gap, not verified, coverage 60–84% |
| `--error` | `#FF5C72` | Failed, critical, coverage < 60% |
| `--info` | `#4D9DFF` | Planned, informational |

Each has a `-subtle` variant at 16% alpha for badge backgrounds.

### 2.5 Spectrum and gradients

Spectrum (integration marks, method badges, charts): amber `#FF8A22` · coral `#FF5C72` · pink `#F85EC2` · violet `#9B6BFF` · blue `#4D9DFF` · cyan `#2BD4C4` · green `#4FD86B` · yellow `#FFC53D`.

| Gradient | Definition | Use |
|---|---|---|
| `--grad-hero` | amber → pink → violet, 135° | Logo mark, marketing CTA panel |
| `--grad-warm` | amber → coral, 135° | Trend bars |
| `--grad-cool` | violet → blue, 135° | Avatar |
| `--grad-mint` | cyan → green, 135° | Reserved |

### 2.6 HTTP method colours

`GET` blue · `POST` green · `PATCH` yellow · `PUT` violet · `DELETE` coral — rendered as a 16%-alpha badge with the hue as text.

---

## 3. Typography

| Role | Family | Size / weight | Notes |
|---|---|---|---|
| Marketing H1 | IBM Plex Sans Arabic | 54 / 700, −0.03em, line-height 1.06 | 38px below 820px |
| Page title | IBM Plex Sans Arabic | 24 / 700, −0.02em | `.page-head h2` |
| Section title | IBM Plex Sans Arabic | 32 / 700, −0.02em | Marketing sections |
| Topbar title | IBM Plex Sans Arabic | 17 / 600 | |
| Card title | IBM Plex Sans Arabic | 15 / 600 | |
| Body | IBM Plex Sans Arabic | 15 / 400, line-height 1.55 | |
| Small body / table cell | IBM Plex Sans Arabic | 14 / 400 | |
| Label | IBM Plex Sans Arabic | 12 / 500, secondary | |
| Eyebrow | IBM Plex Sans Arabic | 11 / 600, 0.06em, uppercase, muted | `.eyebrow` |
| Table header | IBM Plex Sans Arabic | 11 / 600, 0.06em, uppercase, muted | |
| Numeric / code / IDs | JetBrains Mono | 11–13 | Run IDs, paths, latency, evidence |

**Arabic:** IBM Plex Sans Arabic covers both scripts, so mixed-direction text keeps one voice. In Figma, where the Arabic variant is unavailable, IBM Plex Sans is the substitute for Latin content.

---

## 4. Spacing, radius, elevation

**Spacing scale:** 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 22 · 28 · 40 · 72 px.
Grid gap 14 · card padding 20 · content padding 28 · marketing section padding 72/40.

| Radius | Value | Use |
|---|---|---|
| `--r-xs` | 6px | Tags |
| `--r-sm` | 8px | Buttons, inputs, nav items |
| `--r-md` | 12px | Cards, accordions, KPIs |
| `--r-lg` | 16px | Reserved |
| `--r-xl` | 22px | Reserved |
| `--r-pill` | 999px | Badges, chips, avatars, bars |

| Shadow | Value | Use |
|---|---|---|
| `--shadow-md` | `0 6px 18px rgba(0,0,0,.34)` | Highlighted pricing card |
| `--shadow-lg` | `0 16px 40px rgba(0,0,0,.46)` | Side panel |

Elevation is carried by surface value and border first; shadow is reserved for genuinely floating layers.

---

## 5. Motion

`--dur: 200ms` · `--ease: cubic-bezier(.2,.6,.2,1)`

| Element | Transition |
|---|---|
| Buttons, chips, nav items | background + colour |
| Button press | `scale(.97)` |
| Accordion caret | `rotate(90deg)` on open |
| Switch knob | position + background |
| Table row | background on hover |
| Trend bar | opacity `.85 → 1` on hover |

No entrance animation on route change — the screen appears at once. Scroll resets to top on navigation.

---

## 6. Components

| Component | Anatomy | States |
|---|---|---|
| **Button** | height 44 (sm 36, lg 52), radius 8, gap 8, weight 600 | primary · secondary · ghost · hover · active · focus-visible |
| **Badge** | pill, 4/10 padding, 12px/600 | success · warning · error · info · neutral · accent |
| **Chip** | pill, 8/14, 1px border, 13px | default · hover · on (accent subtle + accent border) |
| **Tag** | radius 6, 3/9, mono 11 | single state; used for techniques and screens |
| **Reference chip** | mono 11, accent on accent-subtle, radius 6 | single state; always adjacent to what it names |
| **Input** | height 46, radius 8, surface-2, 1px border | default · focus (accent border + 3px ring) · placeholder muted |
| **Select** | as input, sans font | |
| **Check card** | 14/16 padding, 17px box, radius 8 | off · on (accent border + 6% accent wash) |
| **Switch** | 38 × 22, pill | off (surface-3, muted knob) · on (accent fill, accent-fg knob) |
| **Card** | surface, 1px border, radius 12 | with optional 14/20 header separated by a border |
| **KPI** | 18/20 padding; value 28/700, label 12, delta mono 11 | delta coloured by direction |
| **Table** | header 11 uppercase muted on surface-2; cells 13/16, 14px | row hover surface-2; last row no divider |
| **Coverage bar** | height 6, pill, track surface-3, min-width 90 | fill coloured by threshold, always paired with the number |
| **Tabs** | inline pill group, 4px inset, tab 8/16, 13/600 | on = surface-3 + primary text |
| **Accordion** | card with 15/20 header row and 0/20/20 body | closed · open (stronger border, caret rotated) |
| **Code box** | bg `--bg`, 1px border, radius 10, mono 12, 14/16 padding | pre-wrap; used for evidence and CI snippets |
| **Drop zone** | 1.5px dashed strong border, radius 12, 28 padding | default · hover (accent border) |
| **Donut** | 96px conic ring on a 70px surface core | percentage in the core |
| **Trend** | 96px tall flex row of gradient bars, 5px gap | values scaled into 12–100% so small differences stay legible |
| **Empty state** | 48/24 padding, centred, muted | always names the next action |

---

## 7. Layout

### 7.1 Application shell

```
┌────────────┬──────────────────────────────────────────┐
│ sidebar    │ topbar  60px                             │
│ 248px      ├──────────────────────────────────────────┤
│            │ content · 28px padding · max-width 1360  │
└────────────┴──────────────────────────────────────────┘
```

- **Sidebar** — brand block (60px, bordered below), grouped nav, user footer pinned to the bottom. Groups: Workspace · Analysis · Configure · Docs. Active item = accent text on accent-subtle. Counts sit right-aligned in mono.
- **Topbar** — screen title, breadcrumb in mono muted, actions right-aligned.
- **Content** — page head (title + one-line description + actions), then the screen body.

### 7.2 Grids

`.g2` `.g3` `.g4` `.g5` are equal-width `minmax(0,1fr)` tracks at 14px gap. Asymmetric layouts use explicit `minmax(0,1.6fr) minmax(0,1fr)` (dashboard) or `minmax(0,1.7fr) minmax(0,1fr)` (new run, settings).

Cards in a row stretch to equal height by default so bottom-aligned actions line up; dashboard panels of unrelated length opt out with `align-items:start`.

### 7.3 Marketing layout

Sticky header · sections at 72/40 padding, max-width 1240 · alternating sections use `--surface` with top and bottom borders.

### 7.4 Breakpoints

| Width | Behaviour |
|---|---|
| ≥ 1100px | Full layout |
| < 1100px | `.g5`/`.g4`/`.g3` collapse to 2 columns |
| < 820px | Sidebar hidden; all grids single column; H1 → 38px; content padding → 20px |

---

## 8. Content rules

| Rule | Example |
|---|---|
| Sentence case everywhere except eyebrows and table headers | "New run", not "New Run" |
| IDs in mono, always | `REQ-014`, `TC-102`, `#1042` |
| Verdicts as words, not only colour | "2 failed", "no coverage", "verified" |
| Empty states name the next action | "No endpoint serves this requirement — supply a spec or a sample request." |
| Numbers carry their unit | `188 ms`, `86%`, `6m 12s` |
| Gaps state a reason, never a bare zero | "0 tests" + why |
| Feature chips sit beside the control, not in a tooltip | *Fixture teardown* `FR-043` |

---

## 9. Accessibility

- Contrast: `--text` on `--surface` ≈ 13:1; `--text-secondary` ≈ 6.4:1; `--text-muted` reserved for non-essential metadata.
- Focus: 2px `--accent-ring` at 2px offset on every interactive element.
- Verdict never conveyed by hue alone.
- Tables use real `<th>` semantics; badges carry accessible text.
- Hit targets ≥ 36px in the small size, ≥ 44px default.

---

## 10. RTL

When the interface language is Arabic, `dir="rtl"` mirrors the whole layout:

| Element | Mirrored behaviour |
|---|---|
| Shell | Sidebar moves to the right; content border flips |
| Nav counts | Move to the left edge of the row |
| Tables | Column order reverses; numeric and mono cells stay LTR |
| Coverage bars | Fill grows right-to-left |
| Accordion caret | Rotates −90° on open |
| Code and evidence blocks | Remain LTR — they are machine text |
| Latin identifiers inside Arabic prose | Isolated so they do not reorder |

---

## 11. Screen inventory

| # | Screen | Route | Layout |
|---|---|---|---|
| 1 | Overview | `#/overview` | Marketing, no shell |
| 2 | Dashboard | `#/dashboard` | 5 KPIs · trend + latest run (1.6/1) · regression watch + gaps (1/1) |
| 3 | Runs | `#/runs` | Filter chips · full-width table |
| 4 | New run | `#/new` | 1.7/1 — three numbered cards + summary rail |
| 5 | Run report | `#/runs/{id}` | 5 KPIs · tabs · failures accordion / matrix / gap cards |
| 6 | Requirements | `#/requirements` | Filter chips · accordion list, first expanded |
| 7 | Test cases | `#/testcases` | Filter chips · table |
| 8 | API surface | `#/api` | 4 KPIs · endpoint table · two supporting cards |
| 9 | Integrations | `#/integrations` | Category sections of 3-up cards · pipeline gate card |
| 10 | Settings | `#/settings` | 1.4/1 — configuration column + vault/retention/audit rail |
| 11 | Feature reference | `#/reference` | 5 KPIs · filter chips · grouped tables |
