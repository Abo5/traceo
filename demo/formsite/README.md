# Formery — a demo site made of forms

A local site for exercising Traceo end to end. Five pages, nine forms, every kind of input
control, and a mix of rules that hold and rules that do not.

```bash
python3 -m http.server 8888 --directory demo/formsite
```

Then in Traceo: open a project → **Runs** → paste a page URL → tick **Functionality** →
**Start the run**. Each page is its own target, so scan them one at a time.

## Measured results

Numbers below are from an actual `functional` run over each page.

| Page | URL | Checks | Findings |
|---|---|---|---|
| Home | `/index.html` | 15 | **none** |
| Support | `/support.html` | 22 | **none** |
| Profile | `/profile.html` | 22 | 5 |
| Checkout | `/checkout.html` | 35 | 6 |
| Sign up | `/signup.html` | 38 | 7 |

Two pages are deliberately clean. A tool that only ever finds problems is not measuring anything,
so a run that comes back with nothing has to be reachable.

## What is wrong, and why

**Planted at runtime.** Each of these declares a rule in the HTML and removes it in JavaScript, so
none can be found by reading the markup — the page has to be driven:

| Where | Declares | Does |
|---|---|---|
| `signup` → age | `min=18 max=120` | strips both bounds on first keystroke |
| `signup` → bio | `maxlength=60` | raises it to 4000 on first keystroke |
| `checkout` → quantity | `min=1 max=10` | strips both bounds on first keystroke |
| `profile` → display name | `minlength=2` | drops the attribute on first keystroke |
| `profile` → the form | — | **resets itself** when a submission is refused, so everything typed is lost |
| `signup` → password | — | never compared with its confirmation (see "not covered" below) |

**Genuine bugs of the ordinary kind**, not planted so much as written the way these things get
written:

* `signup` and `payment` carry `novalidate` and validate only *some* fields in script, so
  **password, country, terms and CVC are marked `required` and never enforced**.
* `signup` checks `if (!username.value)` — truthiness, not content — so **`"   "` passes as a
  username**.
* Several required text fields accept a **whitespace-only value**. HTML's `required` is satisfied by
  any non-empty string, spaces included, so this is not something the browser will catch for you.
  It shows up wherever a form does not trim before checking — including on the otherwise-correct
  address form.

## What is correct here, on purpose

A tool that only ever finds problems is not measuring anything, so several things are built
properly and the run should say so:

* `signup` — the **terms gate** (submit stays disabled until the box is ticked) and the
  **conditional "Which country?"** field (revealed only for "Other") both work.
* `checkout` → address form — honest constraint validation throughout.
* `index` and `support` — nothing to find at all.

## Not covered by any check

`signup` never compares `password` with `password2`. No case notices, because every family
reasons about one field at a time or about the form as a whole — and an HTML form has no way to
declare "these two must match". That rule can only come from a requirements document.

## The field that should produce no validation case

`search` on the home page declares nothing: no type, no length, no range, no pattern. It should get
a presence check and **no** validation case. With no stated rule there is nothing to violate, and
inventing one would be testing Traceo's opinion rather than the product's.
