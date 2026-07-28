# Traceo — Figma Design Specification

**Version 2.0 · Dark-only · Arabic-first RTL · Desktop 1440**
A complete blueprint to reproduce the entire Traceo product UI in Figma: variables, text styles, components (with variants and auto-layout values), and every screen frame with exact measurements.

---

# PART 1 — FILE SETUP

## 1.1 Figma file structure (Pages)

```
📄 00 · Cover
📄 01 · Foundations   (variables, color styles, text styles, grids)
📄 02 · Components    (the full component library)
📄 03 · Patterns      (composed molecules: tables, code blocks, pipeline strip…)
📄 04 · Screens · Auth & Projects
📄 05 · Screens · Dashboard & Workspace
📄 06 · Screens · Analysis (Generate / Review / Runs / Matrix)
📄 07 · Screens · Settings & Exports
📄 08 · RTL / LTR mirrors + states
```

## 1.2 Frame defaults

- Desktop frame: **1440 × 900** (min supported 1280)
- Content max-width: **1240** centered, side padding **32**
- App pages use the Shell layout (Section 4.1): sticky header 64 + sidebar 240 + content
- Layout grid on content frames: 12 cols, gutter 16, margin 32, color `#FF8A22` @ 4%
- **RTL first**: design Arabic frames as primary; EN frames are mirrors. In Figma, keep text auto-direction; numbers/IDs/paths always LTR (see 1.5).

## 1.3 Variables (Figma Variables — collection "Traceo/Core")

Create one collection, single mode ("Dark" — the product is dark-only).

### Surfaces
| Variable | Value |
|---|---|
| `bg` | `#131217` |
| `surface` | `#1B1A21` |
| `surface-2` | `#22212B` |
| `surface-3` | `#2C2B37` |
| `overlay` | `#07070B` @ 66% |

### Borders
| Variable | Value |
|---|---|
| `border` | `#312F3C` |
| `border-strong` | `#443F54` |

### Text
| Variable | Value |
|---|---|
| `text` | `#F2EFF7` |
| `text-secondary` | `#ADA8BB` |
| `text-muted` | `#756F84` |
| `text-inverse` | `#1A1207` |

### Accent (Amber — the single brand color)
| Variable | Value | Use |
|---|---|---|
| `accent` | `#FF9B3D` | links, active icons, REQ ids |
| `accent-press` | `#F08A2A` | pressed link |
| `accent-fill` | `#FF8A22` | primary button bg |
| `accent-fill-press` | `#F07A12` | primary pressed |
| `accent-fg` | `#211405` | **dark text on amber** (never white-on-amber) |
| `accent-subtle` | `#FF8A22` @ 16% | tinted bg: active nav, FR chips, info panels |
| `accent-ring` | `#FF8A22` @ 42% | focus ring |
| `accent-hover-link` | `#FFB268` | link hover |

### Spectrum (decorative + data accents — small doses only)
| Variable | Value |
|---|---|
| `c-amber` | `#FF8A22` |
| `c-coral` | `#FF5C72` |
| `c-pink` | `#F85EC2` |
| `c-violet` | `#9B6BFF` |
| `c-blue` | `#4D9DFF` |
| `c-cyan` | `#2BD4C4` |
| `c-green` | `#4FD86B` |
| `c-yellow` | `#FFC53D` |

### Semantic
| Variable | Solid | Subtle (16%) |
|---|---|---|
| `success` | `#3FD179` | `#3FD179` @ 16% |
| `warning` | `#FFC53D` | `#FFC53D` @ 16% |
| `error` | `#FF5C72` | `#FF5C72` @ 16% |
| `info` | `#4D9DFF` | `#4D9DFF` @ 16% |

### Gradients (as Figma color styles, linear 135°)
| Style | Stops |
|---|---|
| `grad/hero` | `#FF8A22` 0% → `#F85EC2` 52% → `#9B6BFF` 100% — **logo tile only** |
| `grad/warm` | `#FF8A22` 0% → `#FF5C72` 100% — trend bars, progress fills |
| `grad/cool` | `#9B6BFF` → `#4D9DFF` (reserve) |
| `grad/mint` | `#2BD4C4` → `#4FD86B` (reserve) |

### Numbers (spacing / radius)
Spacing scale (4px grid): `0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64`
Radius: `r-xs 6 · r-sm 8 · r-code 10 · r-md 12 · r-lg 16 · r-xl 22 · r-pill 999`
Sizes: `header-h 64 · sidebar-w 240 · field-h 44 · button-h 44 · button-h-sm 34 · tap-min 44`

## 1.4 Text styles

Fonts: **IBM Plex Sans Arabic** (300/400/500/600/700) for ALL UI text (Arabic + Latin), **JetBrains Mono** (400/500/700) for ALL data (ids, numbers, paths, JSON, timestamps).

| Style name | Font / Size / Weight | Line height | Tracking | Case |
|---|---|---|---|---|
| `display/stat-lg` | Mono or Plex · 34 · 700 | 1.1 | -2% | — |
| `display/stat` | Plex · 28 · 700 | 1.15 | -2% | — |
| `heading/page` | Plex · 24 · 700 | 1.2 | -2% | — |
| `heading/card` | Plex · 15 · 600 | 1.3 | -1% | — |
| `label/eyebrow` | Plex · 11 · 600 | 1.2 | **+6%** | **UPPERCASE** |
| `body/default` | Plex · 13.5 · 400 | 1.55 | 0 | — |
| `body/secondary` | Plex · 12.5 · 400 | 1.55 | 0 | — |
| `body/hint` | Plex · 11.5 · 400 | 1.5 | 0 | — |
| `mono/data` | JetBrains Mono · 12 · 500 | 1.4 | 0 | — |
| `mono/small` | JetBrains Mono · 10.5 · 500 | 1.3 | 0 | — |
| `mono/code` | JetBrains Mono · 12 · 400 | **1.7** | 0 | — |
| `mono/table-head` | Plex · 11 · 600 | 1.2 | +6% | UPPERCASE |
| `button/default` | Plex · 13.5 · 600 | 1 | 0 | — |

## 1.5 Global rules (pin these on the Foundations page)

1. **No shadows anywhere.** Depth = 1px strokes + surface steps (`bg → surface → surface-2 → surface-3`). Code blocks recess back down to `bg`. Single exception: Modal sits on `overlay`.
2. **Data is always Mono + LTR** — even inside Arabic sentences: ids (`REQ-014`, `#1001`), HTTP paths, JSON, dates (`2026-07-26 16:28`), counts.
3. Mixed-language text (requirement descriptions, case titles) = auto direction; truncate with ellipsis inside an LTR-isolated span.
4. Amber is rationed: one primary button per view, active nav item, key ids. Spectrum colors appear only as 26px numbered chips, stat numbers, and method badges.
5. Motion (prototype settings): 120ms ease-out for hovers, 200ms for overlays; press = scale 0.97. Nothing bounces.

---

# PART 2 — COMPONENT LIBRARY (Page 02)

Every component built with Auto-layout. Stroke = 1px `border` unless stated. All radii from the radius scale.

## 2.1 Button
**Variants:** `variant` = primary / secondary / ghost / danger · `size` = md / sm · `state` = default / hover / pressed / disabled

| Prop | md | sm |
|---|---|---|
| Height | 44 | 34 |
| Padding H | 18 | 14 |
| Radius | 8 | 8 |
| Text | `button/default` | 12.5/600 |
| Gap (icon-text) | 8 | 6 |

| Variant | Fill | Text | Stroke |
|---|---|---|---|
| primary | `accent-fill` | `accent-fg` | none |
| primary/hover | `accent-fill` +4% lighter | `accent-fg` | none |
| primary/pressed | `accent-fill-press`, scale 97% | `accent-fg` | none |
| secondary | `surface-3` | `text` | `border-strong` |
| ghost | transparent | `accent` | none |
| danger | `error` | `#FFFFFF` | none |
| disabled (any) | 40% opacity | — | — |

## 2.2 Card
Auto-layout vertical · padding **20** · gap 14 · fill `surface` · stroke `border` · radius **12** (variant `lg` = radius 16, padding 24).
**Slots:** optional header row (auto-layout horizontal, space-between: title `heading/card` + action slot — usually a RefChip or small Button), content area.
Nested panels inside a Card use fill `surface-2`, radius 10.

## 2.3 Badge
Auto-layout horizontal · height **22** · padding H 10 · radius pill · text 11/600.
**Variant `tone`:** success / warning / error / info / muted / accent → fill = tone-subtle, text = tone-solid. (muted: fill `surface-3`, text `text-secondary`.)

## 2.4 Pill (segmented control)
Container: auto-layout horizontal · fill `surface` · stroke `border` · radius pill · padding **4** · gap 4.
Item: height 32 · padding H 14 · radius pill · text 13/600.
**States:** idle = transparent, text `text-secondary` · hover = `surface-2` · **active** = fill `accent-fill` + text `accent-fg` (main nav) **or** fill `surface-3` + text `text` (report tabs) **or** fill `accent-subtle` + stroke `accent` (option pills).

## 2.5 StatCard (KPI)
Auto-layout vertical · padding 20 · gap 6 · fill `surface` · stroke `border` · radius 12 · min-width 180.
Number: `display/stat` colored per KPI (amber/success/blue/error/cyan). Label: `body/secondary`. Optional corner slot (top-end) for RefChip. Optional delta line: `mono/small` colored ±.

## 2.6 Table
Header row: height 36 · text `mono/table-head` color `text-muted` · bottom stroke `border`.
Body row: min-height 48 · padding H 16 · bottom stroke `border` @ 60% · hover fill `surface-3`.
Container: Card with padding 0, radius 14, clip content. Numeric/id cells use `mono/data`.

## 2.7 Progress
Track: height **6** · radius pill · fill `surface-3`.
Fill: `grad/warm` (default) or semantic solid. Variant `size=sm`: width 52 for table cells.

## 2.8 Input / Select / Textarea
Height **44** (textarea min 96) · fill `surface-2` · stroke `border` · radius 8 · padding H 14 · text `body/default`.
Label above: 12.5/500 `text-secondary`, gap 6. Hint below: `body/hint` `text-muted`.
**States:** focus = stroke `accent` + outer ring 3px `accent-ring` · error = stroke `error` + hint in `error` · disabled = 50% opacity.

## 2.9 Modal
Scrim: `overlay` full-screen. Panel: width **560** (confirm: 440) · fill `surface` · stroke `border` · radius **22** · padding 24 · gap 16. Header: title `heading/card` + close ghost icon-button 28×28. Footer: auto-layout end-aligned, gap 8 (secondary + primary).

## 2.10 Mono
Text span: `mono/data`, **direction LTR always**. Used for every id, path, number.

## 2.11 StatusDot
Ellipse **8×8**, fill by state map (Section 3.4). Always paired with a text label (never color-only).

## 2.12 Empty state
Auto-layout vertical centered · padding 40 · gap 8: icon (optional 28px, `text-muted`), title `body/default` 600, hint `body/hint` `text-muted` — hint always names the next action ("Upload a requirements document to start").

## 2.13 PageHeader
Auto-layout horizontal space-between, align end. Start: title `heading/page` + sub `body/secondary` (gap 4, vertical). End: actions slot (buttons / RefChip), gap 8. Margin-bottom 20.

## 2.14 RefChip *(v2 signature)*
Auto-layout · height 20 · padding H 6 · radius **6** · fill `accent-subtle` · text `mono/small` color `accent` · content: `FR-###` (LTR). Placed in Card action slots and beside page titles to bind UI to the spec.

## 2.15 TrendBars *(v2)*
Container height **130**, auto-layout horizontal, gap 6, align bottom, baseline stroke 1px `border`.
Bar: width **10** · radius top 3 · fill `grad/warm` · height = coverage% of container. Hover tooltip: `#1042 · 87%` in `mono/small`. X labels: run ids `mono/small` `text-muted`.

## 2.16 Donut *(v2)*
**96×96** ring, stroke-width 12: segments passed=`success`, failed=`error`, errored=`warning` (gap 2°). Center: pass-rate `display/stat` 22/700 Mono.

## 2.17 SeverityBadge *(v2)*
Badge with fixed mapping: **critical**=error tone (حرج) · **major**=warning tone (كبير) · **minor**=muted tone (طفيف).

## 2.18 DateTimeText *(v2)*
`mono/small`, LTR, format `YYYY-MM-DD HH:mm` — the only allowed date rendering.

## 2.19 MethodBadge
Badge, mono uppercase 10.5/700, tone by verb: GET=`c-blue` · POST=`c-green`→use `success` · PUT/PATCH=`c-yellow`→`warning` · DELETE=`error`. Fill = 16% of the color.

## 2.20 NumberedChip (pipeline / sections)
**26×26** · radius 8 · fill spectrum-color @ 16% · number `mono/data` 700 in the spectrum color. Sequence colors: amber → pink → violet → blue → cyan.

## 2.21 Toggle (include/exclude)
Track 36×20 radius pill: off = `surface-3` + stroke `border` · on = `accent-fill`. Knob 16×16 white-ish `#F2EFF7`, travel 16.

## 2.22 Code / Evidence block
Fill **`bg`** (recessed) · stroke `border` · radius 10 · padding 14 · text `mono/code` `text-secondary` · **LTR** · wraps. Secrets shown as `••••••••`.

## 2.23 Dropzone
Stroke **1.5 dashed** `border-strong` · radius 12 · fill transparent · padding 32 · centered stack: icon + "Drop the requirements document" `body/default` + hint `body/hint`. Hover/drag-over: stroke `accent`, fill `accent-subtle` @ 50%.

## 2.24 AlertPanel (amber info)
Fill `accent-subtle` · radius 10 · padding 14 · text `body/secondary`. Used for the grounding-gate notice on Generate.

---

# PART 3 — PATTERNS (Page 03)

## 3.1 App Shell
```
Frame 1440×900
├─ Header (1440×64, fixed top)
│   fill: bg @ 86% + background-blur 12 · bottom stroke `border`
│   padding H 24 · auto-layout space-between
│   Start: LogoTile 30×30 (radius 9, fill grad/hero, "T" 16/700 accent-fg)
│          + "Traceo" 17/700 -2% + tagline `requirement → test → result` mono/small text-muted (LTR)
│   End: Lang pill (AR/EN) + user name body/secondary + logout ghost
├─ Sidebar (240×836, under header, start side — RIGHT in RTL)
│   fill surface · end stroke border · padding 12
│   Project block: name 14/600 + language Badge + optional "Archived" Badge
│   Nav groups (gap 2, group gap 10):
│     eyebrow `label/eyebrow` 10.5 text-muted padding 10/12/4
│     item: height 38 · padding H 12 · radius 8 · text 13/500
│       active: fill accent-subtle + text accent · hover: fill surface-2
│   Groups: Workspace(Overview, Requirements, Endpoints) /
│           Analysis(Generate, Review, Runs, Matrix) / Configure(Environments)
└─ Content (1200 wide, padding 32/24, vertical gap 16)
```

## 3.2 Pipeline strip
Auto-layout horizontal, gap 12, wrap. Step = NumberedChip + label `body/secondary`; steps joined by a 24px arrow line `border-strong`. 5 steps colored amber→pink→violet→blue→cyan.

## 3.3 Defect (failure) card — run report
Card `surface-2`, radius 12. Collapsed row: case-id `mono/data` `error` + title (auto-dir, ellipsis) + REQ chips (`mono/small` `accent`) + SeverityBadge + chevron.
Expanded adds: "STEPS TO REPRODUCE" eyebrow + ordered list; two Code blocks (Request / Response); Expected vs Actual chips (Badge success-subtle vs error-subtle); assertion list with pass/fail dots.

## 3.4 State → color map (single source of truth)
`draft/archived/cancelled` = muted · `approved/confirmed/passed/completed` = success · `rejected/failed/aborted/removed` = error · `stale/errored/changed` = warning · `extracted/queued/running` = info.
Matrix coverage: `not_covered`=warning · `covered_not_run`=info · `passing`=success · `failing`=error · `errored`=warning.

---

# PART 4 — SCREENS (exact frame specs)

All frames 1440×900 unless noted. RTL: content mirrored, sidebar right; specs below written start/end (direction-agnostic).

## 4.1 Login `/login` (Page 04)
- Canvas `bg`; centered Card **400w** radius 16 padding 32 gap 18
- LogoTile 40 + "Traceo" 22/700 centered
- Email + Password Inputs (labels Arabic: البريد الإلكتروني / كلمة المرور)
- Primary Button full-width "تسجيل الدخول"
- **Demo hint panel**: fill `surface-2` radius 10 padding 12 — `demo@traceo.sa / Demo1234!` in `mono/small`
- Ghost link to register. Register mirrors with 4 fields (org, name, email, password).

## 4.2 Projects `/projects`
- PageHeader: "المشاريع" + primary "مشروع جديد"
- Grid: cards min **280w**, gap 16 — Card: name 15/600 · language Badge · created date `DateTimeText` muted · id short `mono/small` muted · hover: stroke `border-strong`
- New-project Modal: name Input + language Select (ar/en)

## 4.3 Dashboard (Overview) — v2 composition (Page 05)
Vertical stack, gap 16:
1. **KPI row** — 5 StatCards in auto-layout grid (gap 16):
   - Coverage % (amber number) + RefChip `FR-050` top-end
   - Approved cases (success)
   - Latest run `207/265` (blue) + label `آخر تشغيل #1001`
   - Open defects (error if critical>0) + sub "· N حرجة" + RefChip `FR-052`
   - Median run duration `1.0s` (cyan)
2. **Grid 1.6fr / 1fr** (gap 16):
   - Card "اتجاه التغطية" + RefChip `FR-054` → TrendBars (last 14 runs)
   - Card "آخر تشغيل" → Donut 96 + counts column (passed/failed/errored colored `body/secondary`) + secondary Button "فتح التقرير"
3. **Grid 1fr / 1fr**:
   - Card "مراقبة الانحدار" + RefChip `FR-062`: rows (fill `surface-2`, radius 10, padding 8/10): SeverityBadge + title (auto-dir ellipsis) + REQ mono chips + outcome Badge → links to run. Empty: success-colored line "لا انحدارات — كل ما نجح سابقاً ما زال ينجح"
   - Card "فجوات التغطية" + RefChip `FR-051`: gap rows (fill warning-subtle, radius 10): REQ id `mono/data` warning + reason `body/secondary` + ghost "توليد مستهدف"; second line: next-action `body/hint` muted
4. Case-state chips row: 5 pills (`surface-2` + stroke, radius pill, padding 6/14): StatusDot + label + count Mono
5. Pipeline strip (3.2)
6. Card "إجراءات سريعة": 4 secondary buttons + 1 primary "تشغيل جديد"

## 4.4 Requirements
- PageHeader "المتطلبات" + upload primary button
- **Dropzone** full-width (2.23); during parse → Progress + stage message `body/hint`
- Documents list: rows with filename (auto-dir) + version Badge (v1/v2) + parse-status Badge
- **Requirements Table** columns: REQ id (`mono/data` `accent`) · Description (auto-dir, ellipsis, ~40%) · Confidence (Progress sm 52 + %) · Type Badge · Priority Badge · State Badge · row actions (اعتماد secondary-sm / تحرير ghost-sm)
- Toolbar: state filter Pills + search Input 260w + "اعتماد الكل" secondary
- Edit Modal: description Textarea + acceptance-criteria list + type/priority Selects

## 4.5 Endpoints (API surface)
- PageHeader "الواجهات" + RefChip `FR-024`
- Import Card: Pill tabs (رابط URL / رفع ملف) → URL Input + fetch Button, or file drop; result line: endpoints count + warnings (warning Badge list) + diff summary chips (+added / −removed)
- **Inventory Table** columns: MethodBadge · Path `mono/data` (LTR nowrap) · Summary `body/secondary` · Params count Mono · **Tests** Mono (warning color if 0) · **Coverage** (Progress sm + % — success ≥80 / warning ≥40 / error below) · **Last outcome** (StatusDot + `mono/small`) · Security Badge (محمي info / مفتوح muted) · Include Toggle
- Row with 0 tests: fill `warning` @ 7%

## 4.6 Generate (Page 06)
Two-column: content + **sticky summary 360w**.
- Requirements checklist Card: rows = checkbox + REQ id mono + description (auto-dir, ellipsis); header: select-all + priority filter Pills
- **Depth selector**: 3 option pills (smoke/standard/exhaustive), each with hint line `body/hint`; selected = accent-subtle fill + accent stroke
- Summary Card (sticky top 88): rows key/value (`body/secondary` + Mono): selected reqs, endpoints; **AlertPanel**: "التوليد مقيّد بالواجهات المكتشفة فقط — أي حالة تشير إلى واجهة غير موجودة تُستبعد قبل الحفظ"; full-width primary "توليد" → Progress + stage text
- **Result panel**: 2 StatCards (توليد success / استبعاد error) + unmappable list (REQ mono + reason, warning tint) + primary CTA "إلى المراجعة"

## 4.7 Review — flagship
Two panes: **list 400w** + detail flex.
- List pane Card: filter Pills (الكل/مسودة/معتمد/مرفوض/قديم) + search; virtualized rows 64h: checkbox + title (auto-dir ellipsis) + technique Badge + StatusDot + REQ chips; **selected row**: stroke `accent`
- Detail pane:
  - **Linked-requirement panel**: Card stroke `accent`, fill surface: REQ id mono accent + full text `body/default` 1.6 + RefChips `FR-035` `FR-036` in header
  - Meta line `mono/small` muted: technique · priority · model · prompt version
  - **Steps**: per step — `METHOD /path` mono 600 + request Code block + assertions rows (op chip `surface-3` mono 10.5 + expected value mono) + extractions
  - Action bar (sticky bottom of pane): primary "اعتماد (A)" + danger "رفض (R)" + secondary "تعديل"; keyboard hints `mono/small` muted
  - Reject Modal: reason Select (incorrect/shallow/duplicate/other) + Textarea
  - Edit Modal 640w: title/priority Inputs + steps & assertions as JSON Textareas (mono)
- Bulk bar (appears on multi-select, sticky): count + "اعتماد الكل" + "رفض الكل"

## 4.8 Runs
- **Launch Card**: Environment Select + big count line — number `display/stat` success + "حالة معتمدة جاهزة للتشغيل" `body/secondary` + ghost "تشغيل مجموعة فرعية" + primary "تشغيل"
- **Live panel** (when running): state Badge info + counters chips updating + Progress + danger-ghost "إلغاء" → on finish becomes link "عرض التقرير"
- **History Table**: `#1001` Mono · state Badge · counts (colored mini-chips) · started/finished `DateTimeText` · initiator

## 4.9 Run Report
- Header row: "تشغيل #1001" `heading/page` + state Badge + env/date `mono/small` muted + secondary "تصدير HTML"
- KPI row: 5 StatCards (total / passed success / failed error / errored warning / duration)
- Tabs Pill: الإخفاقات / جميع النتائج / مقارنة (active = `surface-3`)
- **Failures tab**: severity filter Pills (الكل / حرج n / كبير n / طفيف n) + Defect cards (3.3)
- **Performance section** + RefChip `FR-044`: Table — Method+Path mono · P50 · P95 · MAX · Calls (all Mono)
- **Compare tab**: run Select + coverage-delta chip (`+2.1 pts` success-subtle / negative error-subtle) + unchanged count + two lists: newly-failing (error tint rows) / newly-passing (success tint)

## 4.10 Matrix
- PageHeader "المصفوفة" + RefChip `FR-050` + secondary "تصدير Excel"
- Top: StatCard coverage % + StatCard gaps + status filter Pills
- **Rows** (Card container, padding 0): REQ id `mono/data` accent 700 · description auto-dir ellipsis · case chips (StatusDot 6 + short title, fill `surface-2` radius 6, link) · coverage-status Pill (state map) · Progress passed/total (grad/warm)
- **Gaps section**: warning cards — stroke `warning`, fill warning-subtle, radius 12, padding 12/16: REQ mono warning 700 + reason + next-action `body/hint` muted + secondary-sm "توليد مستهدف". Empty state: "✓ لا توجد فجوات — كل المتطلبات المؤكّدة مغطاة"

## 4.11 Environments
- Cards grid 320w+: name 600 + `base_url` `mono/data` LTR + auth-type Badge + TLS Badge + **"سر محفوظ ••••" chip** (muted) + secondary-sm "فحص الاتصال" + ghost "تعديل" / danger-ghost "حذف"
- Check result inline: Badge success "متصل · 200" or error "غير متصل" + redacted reason
- Modal: name/base_url Inputs + auth-type Select driving conditional secret fields (api_key: key+header · basic: user+pass · bearer: token · oauth2: client_id+secret+token_url) + variables (KEY=VALUE textarea) + TLS toggle. Editing with blank secret = keep stored.

## 4.12 Settings (Members / Audit) (Page 07)
- Members Table: name · email mono · role inline Select · remove danger-ghost; invite Modal
- Audit Table (newest first): time `DateTimeText` · actor · action `mono/data` (`test_case.approved`) · object type+id mono · expandable detail row (Code block); cursor pagination "تحميل المزيد" secondary

## 4.13 Exported report (HTML/PDF) — off-app artifact
Same identity, self-contained: RTL when project is Arabic; header `#1001` + KPI row + full defect reports with evidence + results table; print stylesheet flips to white bg. Excel: 4 sheets, header row fill `#FF8A22` white bold text, frozen panes, rightToLeft per sheet.

---

# PART 5 — STATES & ACCESSIBILITY

## 5.1 Mandatory states per screen
| State | Spec |
|---|---|
| Loading | muted text "جارٍ التحميل…" or Progress for long jobs — never a blank frame |
| Empty | Empty component with next-step hint |
| Error | `error` text + secondary "إعادة المحاولة" — never raw stack traces |
| Background job | Progress + current-stage message, updating |
| Live run | counters updating + cancel |

## 5.2 Accessibility
- Contrast AA: `accent-fg` on amber; secondary text ≥ 4.5:1
- Focus visible always: 3px `accent-ring` outer ring
- Review fully keyboard-operable (a / r / j / k) — hints rendered in UI
- Color never alone: every dot/badge paired with a text label
- Hit areas ≥ 44px (sm buttons 34 acceptable in dense tables)

## 5.3 Anti-patterns (never do)
1. Box-shadows on cards/buttons
2. White text on amber (always `accent-fg`)
3. IDs/numbers/paths in UI font or RTL
4. Dates rendered without DateTimeText
5. Spectrum colors as large fills (chips + numbers only)
6. Two primary buttons in one view
7. Physical left/right in layout logic (use start/end)
8. A list without an empty state; an error without retry
9. Motion > 320ms or springy
10. Revealing a stored environment secret (write-only + `••••` chip)

---

*Code parity: `frontend/app/globals.css` (tokens) · `frontend/components/ui.tsx` (components) · reference shots in `Traceov2/shots/` · Arabic narrative spec in `docs/UI_DESIGN_SPEC_AR.md`.*
