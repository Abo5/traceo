# Traceo Frontend — Contract (v1)

Next.js 15 (App Router) + TypeScript, plain CSS (global tokens file — NO Tailwind, the design
system is token-driven inline/global CSS reproduced from the Traceo design export).
Dev server on :3000, backend on http://localhost:8000/v1.

## Design system (from Traceo design export — follow EXACTLY)
Dark only. `globals.css` defines on `:root`:
- Surfaces: --bg:#131217; --surface:#1B1A21; --surface-2:#22212B; --surface-3:#2C2B37; --overlay:rgba(7,7,11,.66)
- Borders: --border:#312F3C; --border-strong:#443F54
- Text: --text:#F2EFF7; --text-secondary:#ADA8BB; --text-muted:#756F84; --text-inverse:#1A1207
- Accent (amber): --accent:#FF9B3D; --accent-press:#F08A2A; --accent-fill:#FF8A22; --accent-fill-press:#F07A12; --accent-fg:#211405; --accent-subtle:rgba(255,138,34,.16); --accent-ring:rgba(255,138,34,.42)
- Spectrum: --c-amber:#FF8A22; --c-coral:#FF5C72; --c-pink:#F85EC2; --c-violet:#9B6BFF; --c-blue:#4D9DFF; --c-cyan:#2BD4C4; --c-green:#4FD86B; --c-yellow:#FFC53D
- Semantic: --success:#3FD179; --warning:#FFC53D; --error:#FF5C72; --info:#4D9DFF (+ .16 subtle rgba variants)
- Gradients: --grad-hero:linear-gradient(135deg,#FF8A22 0%,#F85EC2 52%,#9B6BFF 100%); --grad-warm:linear-gradient(135deg,#FF8A22,#FF5C72)
- Radius: 6/8/12/16/22px + pill 999px. Motion: 120ms/200ms/320ms cubic-bezier(.2,.6,.2,1); press scale .97.
- Fonts (Google): 'IBM Plex Sans Arabic' 300–700 for UI; 'JetBrains Mono' 400/500/700 for ALL ids, metrics, code, evidence.
Aesthetic rules: 1px borders + surface steps for depth (NO shadows), cards radius 12–16px on --surface,
nested content on --surface-2, code blocks recessed on --bg, pill segmented controls, 11px uppercase
letterspaced eyebrows, mono chips tinted with spectrum colors, big bold headings with -0.02em tracking.

## App shell
- Sticky 64px header: 30px logo tile (grad-hero, dark "T", radius 9px) + wordmark "Traceo" + mono tagline
  "requirement → test → result"; right side: language switch (AR/EN) + user menu (name, logout).
- Project pages use a left sidebar nav (RTL: right side): نظرة عامة Dashboard / المتطلبات Requirements /
  الواجهات Endpoints / التوليد Generate / المراجعة Review / التشغيلات Runs / مصفوفة التتبّع Matrix /
  البيئات Environments. Active item: accent-subtle bg + accent text.
- i18n: `lib/i18n.ts` exports `useLang()` + `t(key)` with an `ar`/`en` dictionary; `<html dir>` flips to rtl
  when ar. Default ar. Language persisted in localStorage. ALL screens must render correctly in RTL.

## Shared files — owned by the SHELL agent; SCREENS agent imports them exactly as specified
### `lib/api.ts`
```ts
export const API = process.env.NEXT_PUBLIC_API || "http://localhost:8000/v1";
export function getToken(): string | null;
export function setToken(t: string | null): void;
export async function api<T = any>(path: string, opts?: { method?: string; body?: any; form?: FormData }): Promise<T>;
// api(): JSON fetch with Authorization Bearer, throws ApiError{code,message,status}; form uploads when opts.form
export async function pollJob(jobId: string, onProgress?: (j: any) => void): Promise<any>; // polls /jobs/{id} every 1s until completed/failed; throws on failed
```
### `lib/i18n.ts`
```ts
export function useLang(): { lang: "ar" | "en"; setLang(l: "ar" | "en"): void; dir: "rtl" | "ltr" };
export function useT(): (key: string) => string;   // returns key itself if missing — screens may pass literal Arabic strings too
```
### `components/ui.tsx`
```tsx
export function Button({ variant = "primary" | "secondary" | "ghost" | "danger", size = "md" | "sm", ...props });
export function Card({ title?, action?, children, pad? });               // bordered --surface card
export function Badge({ tone: "success" | "warning" | "error" | "info" | "muted" | "accent", children });
export function Pill({ active, onClick, children });                     // segmented pill button
export function StatCard({ value, label, color? });                      // big mono number + label
export function Table({ head: ReactNode[], children });                  // grid table, 11px uppercase header
export function Progress({ pct, tone? });                                // 6px pill progress bar
export function Empty({ icon?, title, hint? });
export function Modal({ open, onClose, title, children });
export function Field({ label, hint?, children });                       // form field wrapper
export function Input(props); export function Select(props); export function Textarea(props);
export function Mono({ children });                                      // JetBrains Mono span
export function StatusDot({ state });                                    // colored dot per state name
export function PageHeader({ title, sub?, actions? });
```
State color mapping (StatusDot/Badge tones): draft=muted, approved=success, rejected=error, stale=warning,
archived=muted, extracted=info, confirmed=success, changed=warning, removed=error, passed=success,
failed=error, errored=warning, queued=info, running=info, completed=success, aborted=error, cancelled=muted.

## Routes & ownership
SHELL agent: app/layout.tsx, app/globals.css, app/page.tsx (redirect), app/login, app/register,
app/projects/page.tsx (list+create), app/projects/[id]/layout.tsx (sidebar shell, fetches project),
app/projects/[id]/page.tsx (dashboard: StatCards req/confirmed/cases by state/coverage + latest run card),
app/projects/[id]/environments, app/settings/members, app/settings/audit, lib/*, components/ui.tsx.

SCREENS agent (create ONLY these files; import shared per contract above):
- app/projects/[id]/requirements/page.tsx — upload zone (dashed 1.5px border, accent hover; posts multipart
  to /projects/{id}/documents then pollJob), documents list w/ version + parse_status badge, requirements
  table: mono external_id (accent), description, editable inline or via Modal (PATCH /requirements/{rid}),
  confidence bar, type/priority/state badges, confirm button per row + "اعتماد الكل" confirm_all, filters.
- app/projects/[id]/endpoints/page.tsx — import card (URL input or file upload to /projects/{id}/api-specs),
  warnings display, inventory table: mono METHOD badge (spectrum color per verb), path, summary, params
  count, include/exclude toggle (PATCH /endpoints/{eid}).
- app/projects/[id]/generate/page.tsx — requirement multi-select (confirmed only), depth pill selector
  (smoke/standard/exhaustive with hint lines), summary sidebar (selected count, endpoints discovered,
  amber info panel: "التوليد مقيّد بالواجهات المكتشفة فقط — كل حالة تمر عبر بوابة التحقق قبل الحفظ"),
  Generate button -> 202 -> pollJob w/ progress; result panel: generated / discarded (mono, error tint) /
  unmappable list with reasons.
- app/projects/[id]/review/page.tsx — THE FLAGSHIP. Left: filterable queue list (state pills, search).
  Right: selected case detail — linked requirement text panel (accent border), steps table (mono method+path,
  request JSON block on --bg, assertions list), edit via Modal (JSON editors for steps/assertions ok),
  Approve (primary) / Reject (danger w/ reason select: incorrect|shallow|duplicate|other + free text) /
  keyboard: a=approve r=reject j/k=next/prev. Bulk approve/reject on filtered selection. Processing a case
  advances to next WITHOUT losing filters (NFR-USE-05).
- app/projects/[id]/runs/page.tsx — launch card (environment select, approved cases count, optional subset)
  -> POST /projects/{id}/runs -> pollJob showing live partial counts (poll GET /runs/{id} every 1.5s too);
  history table of runs (state badge, counts, duration, initiator).
- app/projects/[id]/runs/[runId]/page.tsx — report: 5 StatCards (total/passed/failed/errored/duration),
  tabs (الإخفاقات Failures / الكل All / مقارنة Compare), failure accordion cards: BUG-style mono id, title,
  linked req chip, expanded = steps-to-reproduce + request/response evidence blocks (mono, recessed) +
  failure_reason expected vs actual, defect-report style. Compare tab: select another run -> newly
  failing/passing lists. Export buttons: report.html (open in new tab), matrix.xlsx (download).
- app/projects/[id]/matrix/page.tsx — traceability matrix: coverage % StatCard + gaps count, filter pills
  (status/priority/type), grid rows: mono req id (accent), description, linked case chips w/ state dots,
  status pill (not_covered=warning, passing=success, failing=error, errored=warning, covered_not_run=info),
  per-row Progress (passed/total gradient), gaps section listing uncovered reqs w/ reason + "توليد مستهدف"
  button linking to generate page preselected (?req=). Excel export button.

All user-visible strings bilingual via t() or inline `lang === "ar" ? "..." : "..."`. Arabic-first.
Numbers/ids/code always LTR inside RTL layouts (use dir="ltr" on mono spans).
