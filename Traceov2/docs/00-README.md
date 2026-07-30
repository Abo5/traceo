# Traceo — project documentation set

**Version 2.0 · 26 July 2026**

| # | Document | What it answers |
|---|---|---|
| 01 | [BRD](01-BRD-Traceo.md) | Why the product exists, what business problems it solves, scope, objectives, risks, commercial model |
| 02 | [Feature Reference](02-Feature-Reference.md) | Every capability with a stable **FR-###** ID, acceptance criteria, dependencies and the BR it satisfies |
| 03 | [SRS](03-SRS-Traceo.md) | How the system behaves — information model, layer-by-layer specification, non-functional requirements |
| 04 | [User Flows](04-User-Flows.md) | Eight end-to-end flows across the 11 screens, with alternates and error paths |
| 05 | [Design Spec](05-Design-Spec.md) | Tokens, components, layout rules, RTL behaviour, accessibility |
| — | `index.html` | The interactive design — all 11 screens, navigable |

## The reference system

Everything hangs off one identifier scheme, so a single ID means the same thing in the document, the design and the conversation:

```
BR-03  (business requirement)
  └── FR-050  Traceability matrix     ── shown on the Report screen
  └── FR-051  Coverage gap detection  ── shown on the Report + Dashboard
  └── FR-024  Endpoint coverage map   ── shown on the API surface screen
```

| Prefix | Meaning | Lives in |
|---|---|---|
| `BR-##` | Business requirement | BRD |
| `FR-###` | Product feature | Feature Reference · shown beside the control in the UI |
| `NFR-x#` | Non-functional requirement | SRS |
| `REQ-###` | A *customer's* requirement inside a workspace | Product data |
| `TC-###` / `BUG-###` / `#####` | Test case / defect / run | Product data |

## Counts

- **37** features documented across **8** capability groups
- **19** P0 · **13** P1 · **5** P2
- **37** shipped — implemented in the codebase and covered by the test suite
- **10** business requirements · **11** screens · **8** user flows

## Implementation status

Every FR in this set is implemented. Two notes on how a capability is delivered rather
than whether it is:

- **FR-021 / FR-022** — the endpoint surface is built from a HAR capture and DOM form
  descriptors, which a proxy, browser devtools or Traceo's own Playwright driver can
  produce. The driver is an optional dependency so an air-gapped install still gets
  traffic-based discovery by importing a capture.
- **FR-071** — the PDF deliverable is a self-contained printable HTML report (print to
  PDF); XLSX is generated natively. Both are bilingual and carry the run identity on
  every page.
