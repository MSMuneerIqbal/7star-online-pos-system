# 7 Star Battery POS — design

**What this file is.** How the system looks and behaves on screen. The visual
language, the screen patterns, and the chart system for the dashboards.

[PRINCIPLES.md](PRINCIPLES.md) is *why*. [SPECS.md](SPECS.md) is *what*. This is
*how it looks and feels*.

---

## 1. The brief

Who uses this, and in what conditions — every decision below answers to this.

| | |
|---|---|
| **Where** | A shop counter and a warehouse office. Desktop, mouse and keyboard. Not phones |
| **Who** | A salesman entering invoices all day; a branch admin checking the day; an owner reading the whole company |
| **How long** | Hours at a stretch, in one screen, often with a customer waiting |
| **What matters** | Speed of entry, then trust in the number. Nothing else comes close |

Three consequences, and they govern everything else:

1. **Density over comfort.** A full invoice must fit without scrolling. This is
   why the type scale is already tighter than Tailwind's default and stays that
   way.
2. **The number is the interface.** Money and quantities get tabular figures,
   right alignment, and the strongest ink on the screen.
3. **Quiet chrome.** Borders, headers and toolbars recede so the data reads. If
   something is loud, it should be loud because it is *wrong* — an overdue
   balance, a stock-out — not because it is a heading.

---

## 2. Foundations — already built, and staying

`web/src/index.css` has a real token system. It is good. Extend it, and correct
the brand hue to match the real identity (below).

### Brand identity

Taken from the logo and read directly off `7starbattery.pk` — not approximated.

**The mark.** Red five-point star with a black `7`, and "The 7 STAR" set in blue
beside it. Source: `7starbattery.pk/assets/images/logo-mark.png`, 694×699.
Save it to `web/public/logo.png`; an SVG would be better for print and should be
requested from whoever drew it.

**The masthead**, word for word and weight for weight as the website sets it:

```
LAPTOP                              Jost 900 · 34px · #000000
BATTERY STATION                     Jost 900 · 34px · #000000
┌───────────────────────────────┐
│ A HOUSE OF LAPTOP BATTERIES   │   Inter 700 · 13px · white on #3d78e6
└───────────────────────────────┘
BEST QUALITY BEST PRICE             Jost 900 · 21px · #000000 · uppercase
LAPTOP BATTERY SPECIALIST IN PAKISTAN   Inter 700 · 12px · #dc2626 · uppercase
```

Full legal name, as the site's own alt text has it: **The 7 Star Laptop Battery
Station**.

**Where the masthead appears:** the login screen, and the header of every printed
document. **Nowhere else.** The app header carries the mark plus the branch name
only — a five-line masthead above an invoice grid is wasted counter space.

**Two typefaces.** **Jost** at weight 900 for the masthead and printed document
headings; **Inter** for every piece of interface and every number. The app already
uses Inter, so this adds one font, loaded only where the masthead renders. Jost
never touches data — not a stat tile, not the hero figure, not an axis.

### Colour

The brand hue is **oklch H 261.5**, taken from the site's own accent
`#3d78e6`. The existing tokens sit at H 250, a slightly greener blue — **correct
them to 261.5** so the app and the website read as one company.

| Step | Hex | White text on it |
|---|---|---|
| 50 | `#eef6ff` | — |
| 100 | `#dbecff` | — |
| 200 | `#bad9ff` | — |
| 300 | `#92beff` | — |
| 400 | `#6ca2ff` | — |
| 500 | `#4b86f3` | 3.50:1 |
| **600** | **`#346dd7`** | **4.87:1 — the interactive step** |
| 700 | `#2455b0` | 7.00:1 |
| 800 | `#193e84` | 10.18:1 |
| 900 | `#102b5d` | 13.76:1 |

**Two blues, on purpose.** `#3d78e6` is the *identity* blue — it appears in the
masthead bar exactly as the website uses it. `brand-600 #346dd7` is the
*interactive* step, used for buttons, active nav and links, because white label
text on it clears 4.5:1 while the identity blue reaches only 4.18:1. Identity
colour and functional colour are allowed to differ by one step; text legibility
is not negotiable.

**Brand red `#dc2626`** is the tagline red. In the app it serves as the
**critical** status colour and nothing else — see §6.2. It is never a chart
series and never a button.

Neutrals stay Tailwind `slate`: page `slate-100`, cards white, borders
`slate-200`, ink `slate-900` / `slate-600` / `slate-400`.

### Type

Inter, with a scale deliberately one step below web-normal:

| Token | Size | Used for |
|---|---|---|
| `--text-xs` | 0.6875rem / 11px | Field labels, badges, table meta |
| `--text-sm` | 0.8125rem / 13px | Buttons, table cells, most UI |
| `--text-base` | 0.875rem / 14px | Body default |
| `--text-lg` | 1rem / 16px | Page titles, card headings |

Add for the dashboards only:

| Token | Size | Used for |
|---|---|---|
| `--text-stat` | 1.5rem / 24px | Stat tile values |
| `--text-hero` | 3rem / 48px | The one hero figure per view |

Both in Inter. **Never a display or serif face** — on a business dashboard it
reads as decoration, not authority.

### Figures

- `tabular-nums` (the existing `.tabular` class) on **columns** — table cells,
  axis ticks, ledger rows. Digits must align vertically.
- **Proportional figures** on stat tiles and the hero figure. Tabular gives every
  digit the width of a `0`, so `121` looks gap-toothed at 48px.

### Density

`--spacing-row: 0.375rem` — 6px table row padding. Rows land at ~28px. That is
what lets ~20 invoice lines sit on screen at once.

---

## 3. Layout

### The shell

```
┌────────────┬──────────────────────────────────────────────────┐
│            │  header  48px  ·  user · branch · logout         │
│  sidebar   ├──────────────────────────────────────────────────┤
│  240px     │                                                  │
│  slate-800 │  page                                            │
│            │    title row      ·  actions right               │
│  nav tree  │    filter row     ·  one row, scopes everything   │
│  by head   │    content        ·  cards / table / grid         │
│            │                                                  │
└────────────┴──────────────────────────────────────────────────┘
```

Sidebar dark (`slate-800`), everything else light. The dark rail is the only
heavy block on screen, which is what makes the content area feel calm.

Active nav item: `bg-brand-600` filled, white text. Never an underline or a left
bar — at this density a filled pill is the only reliably visible state.

### Page anatomy — every screen, same order

1. **Title row.** Page name left, primary action right. One primary action only.
2. **Filter row.** A single left-aligned row. **Date range first**, then
   dimensions. It scopes everything below it — never a filter inside a card.
3. **Content.**

### Widths

Content is fluid to a `1600px` max. Below `1280px` the sidebar collapses to
icons. Below `1024px` we do not support the app — it is a counter tool, and
pretending otherwise produces layouts nobody can enter an invoice into.

---

## 4. Components

Existing primitives — `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`,
`.field-label`, `.field-input`, `.field-error`, `.card` — stay exactly as they
are. What follows is what to add.

### Buttons

One primary per screen. Everything else secondary. `.btn-danger` only for
destructive confirmation inside a modal, never as a row action — a red button in
a table row gets misclicked all day.

### Status pill

Reserved colours, always **icon + word**, never colour alone:

| State | Token | Reads |
|---|---|---|
| Paid, Received, Accepted, Ready | `good` | ✓ |
| Partial, Pending, Raised | `warning` | ⏱ |
| Due, Rejected, Damaged, Overdue | `critical` | ! |
| Draft, Held, Inactive | `slate` | — |

Pills are `text-xs`, `rounded-sm`, tinted background with the status ink at full
strength. Nothing else on the screen may use these four colours.

### Table

The workhorse. `TanStack Table` already in place.

- Header: `text-xs`, `font-medium`, `slate-600`, `slate-50` background, sticky.
- Rows: 28px, hairline `slate-200` divider, hover `slate-50`.
- **Numbers right-aligned and tabular. Text left. Never centred.**
- Zebra striping: no. At 28px rows, hairlines are enough and stripes add noise.
- Row state is a **left 2px edge** in a status colour, not a filled row — a
  filled row destroys the readability of the numbers on it.
- Every table has a footer totals row when the column is money.

### Invoice grid

The most-used component in the system. `InvoiceGrid` exists; hold it to this:

- **Keyboard first.** Tab moves along the row, Enter commits and opens the next,
  Escape cancels the row. A salesman should never need the mouse.
- Product search is a typeahead on model, brand and barcode.
- The quantity cell validates against branch stock **as you type**, and shows the
  available figure inline.
- The price cell shows the branch's selling price as the default and refuses
  below the minimum price (SPECS §8.2), with the floor named in the error.
- Running totals pinned to the bottom right, never scrolling out of view.

### Modal

For create and edit of a single record, and for destructive confirmation. Never
for a document with lines — those get their own route so they survive a refresh.

### Empty and loading states

- **Empty:** one sentence saying what would appear here, and the button that
  creates the first one.
- **Loading:** hold the previous render at 60% opacity. **No skeletons, no
  spinners on refetch** — a layout that jumps while a filter applies makes the
  numbers feel untrustworthy.

---

## 5. The five screen patterns

Every screen in SPECS is one of these. Building the five well builds the app.

| Pattern | Used by | Shape |
|---|---|---|
| **List** | Products, customers, workers, expenses | Filter row · table · row actions · Excel export |
| **Document** | Sale, purchase, dispatch, claim, shipment | Header fields · line grid · totals · save + print |
| **Queue** | Demand orders, E-Store shipments, claims | Status tabs · table · approve/reject on the row |
| **Ledger** | Customer statement, account ledger, item ledger | Date range · opening balance · movements · running balance · closing |
| **Dashboard** | Super admin, branch | §7 below |

### Queue — worth calling out

Approval screens (dispatch, accept a shipment, allot a warranty claim) are where
mistakes cost money. So:

- Status tabs across the top with **live counts** — `Raised 4 · Approved 2`.
- Approve and Reject sit on the row, but **Reject always asks for a reason**.
- Partial approval is edited in place: the requested quantity stays visible
  beside the approved one, so the difference is never hidden.

---

## 6. The chart system

Only the super admin dashboard has charts (PRINCIPLES §12). Branch dashboards are
figures only.

### 6.1 The constraint that shapes everything

There are **seven branches**. Seven is the ceiling for categorical colour, and
past it adjacent classes blur. So:

> **Branches are never a categorical colour dimension.**

Comparing branches is a *magnitude* job, not an *identity* job. It gets a sorted
bar chart in one hue. Branch-over-time gets **emphasis** — the branch in
question in brand blue, every other branch in `slate-300`. This is not a
compromise; it is a better chart. Seven coloured lines is a plate of spaghetti
nobody reads.

Categorical colour is reserved for the few places where series genuinely *are*
the subject, and there are never more than four: sales channels (Walk-in /
Credit / Lab / E-Store), or stock valued at wholesale vs at selling price.

### 6.2 The palette — validated, not eyeballed

Run against the app's real surfaces (`#ffffff` light card, `#0f172a` dark),
`scripts/validate_palette.js`, all six checks:

**Categorical — light** · all checks pass, worst adjacent CVD ΔE 12.7

| Slot | Hue | Hex |
|---|---|---|
| 1 | blue — `brand-600` | `#346dd7` |
| 2 | amber | `#c57800` |
| 3 | teal | `#009d89` |
| 4 | violet | `#6f3bb2` |

**Categorical — dark** · all checks pass, worst adjacent CVD ΔE 12.5

| 1 | `#2c90e8` | 2 | `#c8800d` | 3 | `#189e8c` | 4 | `#9163d5` |
|---|---|---|---|---|---|---|---|

**Slot cap.** Four slots for bars, stacks and lines. **Three** for scatter,
bubble and small multiples — violet and blue fail the all-pairs floor
(normal-vision ΔE 13.5, below the 15 floor), so the fourth slot only holds where
marks sit adjacent. Past four: fold into "Other" or facet.

**Sequential** — one hue, the brand blue, light→dark. It *is* the brand ramp
(§2), so charts and UI share one blue. For branch comparison, stock heat,
anything ordered:

`#dbecff` `#bad9ff` `#92beff` `#6ca2ff` `#4b86f3` `#346dd7` `#2455b0` `#193e84`

For an *ordinal* ramp (aged receivable buckets) start no lighter than `#92beff`
so the first band still clears 2:1 on white.

**Diverging** — blue ↔ red, neutral `slate-200` midpoint. For variance against
target, month-on-month change.

**Status — reserved, never a series colour**

| Role | Light | Dark |
|---|---|---|
| good | `#1c882d` | `#4db155` |
| warning | `#d78d00` | `#e8a127` |
| critical | **`#dc2626`** — the brand red | `#e54c4a` |

Critical is the **tagline red from the logo**, 4.83:1 on white. The brand already
uses red to mean *look here*; the app keeps that meaning rather than inventing a
second red.

**Red and green are status only.** They never appear as series colours. In a
business where "overdue" and "profit down" must be the loudest thing on screen,
spending red on "Faisalabad" wastes the strongest ink available.

### 6.3 Form per panel

Straight from SPECS §17. The form comes from the job, not from variety.

| Panel | Job | Form | Colour |
|---|---|---|---|
| Today's sales | One headline number | **Hero figure** + delta vs yesterday | ink + status delta |
| Month to date, dues, receivables, stock value | Headline numbers | **KPI row** of stat tiles with sparklines | ink + status delta |
| Sales trend, 12 months | Change over time | **Line**, 2px, end-dot, value labelled at the end only | 1 hue |
| Sales by branch | Compare magnitude | **Sorted horizontal bar**, longest first | sequential, 1 hue |
| Sales by channel | Distinct series | **Stacked bar** by month, 4 segments | categorical 1–4 |
| Branch profit vs target | Polarity | **Diverging bar** from a zero baseline | diverging |
| Aged receivables | Ordered bands | **Stacked horizontal bar**, 0–30 / 31–60 / 61–90 / 90+ | ordinal ramp |
| Stock value by branch | Two measures | **Grouped bar** — wholesale, selling | categorical 1–2 |
| Production output | Change over time | **Column** by day, with a damage line | 1 hue + status critical |
| Warranty by model | Compare magnitude, long names | **Sorted horizontal bar**, top 10 | sequential, 1 hue |
| Best and worst movers | Two short lists | **Table**, not a chart | none |

Note the last row. Ten products with ten colours is the classic mistake — a
ranked list is a table, and a table reads faster.

### 6.4 Marks

Fixed across every chart, no exceptions:

| Mark | Spec |
|---|---|
| Bar / column | ≤24px thick, **4px rounded data-end, square at the baseline** |
| Line | 2px, round join and cap |
| End marker | ≥8px, with a **2px white ring** so it stays legible over a line |
| Area fill | series hue at ~10% opacity — a wash, never a block |
| Gridlines, axes | `slate-200`, **1px solid hairline. Never dashed** |
| Between marks | a **2px gap in the surface colour** — never a border around a mark |

### 6.5 Labels

- **Legend whenever there are two or more series.** One series needs none — the
  title already says what it is.
- Direct-label **selectively**: the endpoint, the extreme, the branch the story
  is about. A number on every point is chaos and goes unread.
- **Text never wears the series colour.** Labels and values use ink tokens;
  identity comes from the coloured mark beside them. The one exception is a
  label sitting inside a filled segment, which takes white or ink by luminance.
- A label that does not fit moves outside the bar, or to the tooltip. It is never
  clipped.

### 6.6 Interaction

- **Crosshair on lines**, snapping to the nearest date. One tooltip lists every
  series at that X, so the pointer never has to find a 2px line.
- **The mark is the hit target on bars and cells**, and the hovered mark lifts.
- Hit areas are at least 24px, including the 2px gap.
- In the tooltip, **the value leads and the series name follows** — the reader
  already knows which series they are pointing at.
- Series names come from the database: insert with `textContent`, never
  `innerHTML`.
- **Every chart has a table view.** A tooltip enhances; it never gates. This is
  also how the Excel export gets its shape.

### 6.7 Library

No charting library is installed. Use **Recharts** — it composes with React 19,
renders SVG, and lets every spec above be set explicitly. Do not accept its
defaults: they violate half of §6.4. Wrap it once in a `Chart` component that
applies the tokens, and let no feature import Recharts directly.

---

## 7. The dashboards

### Super admin — charts and figures

```
┌───────────────────────────────────────────────────────────┐
│  Date range ▾   Branch: All ▾   Compare: Last month ▾     │  filter row
├───────────────────────────────────────────────────────────┤
│                                                           │
│   Rs 4,28,500        ↑ 12% vs yesterday                   │  hero
│   Sales today                                             │
│                                                           │
├──────────┬──────────┬──────────┬──────────┬───────────────┤
│ MTD      │ Branch   │ Receiv-  │ Stock    │ Warranty      │  KPI row
│ sales    │ dues     │ ables    │ value    │ open          │
│ ▁▂▄▆█    │ ▁▂▄▆█    │ ▁▂▄▆█    │ ▁▂▄▆█    │ ▁▂▄▆█         │
├──────────┴──────────┴──────────┼───────────────────────────┤
│  Sales — 12 months             │  Sales by branch          │
│  (line, 1 hue)                 │  (sorted bar, sequential) │
├────────────────────────────────┼───────────────────────────┤
│  Aged receivables              │  Production and damage    │
│  (stacked, ordinal)            │  (column + status line)   │
└────────────────────────────────┴───────────────────────────┘
```

**Exactly one hero figure.** The temptation is to make five numbers big; then
nothing is big.

### Branch — figures only

The same filter row, the same KPI row, then plain tables. No charts. Its numbers:
today's sales, this month, stock at its own selling prices, this month's
expenses, cash and bank, credit customers outstanding, owed to warehouse. Profit
appears only where the super admin granted it.

### Rules for both

1. Every figure clicks through to the list behind it.
2. Every panel obeys the one filter row.
3. Nothing on a branch dashboard reveals another branch — not in a total, not in
   an axis.
4. Cost-derived figures are absent, not greyed, when the viewer may not see cost.

---

## 8. Print

Thirteen document layouts already run through the `@media print` block. Hold them
to one shape:

- **A5** for customer invoices — matching the old shop app, which the shops'
  printers are already set up for. A4 for statements, reports and dispatch notes.
- **The masthead heads every printed document** — the mark on the left, then the
  four lines of §2 exactly as worded, then the branch's own address and phone
  beneath. This is the one place Jost appears at full size, and it is what makes
  an invoice from Multan look like an invoice from head office.
- Document number and date top right.
- Table with full borders — a printed invoice is read in bad light by someone who
  did not create it.
- Totals block bottom right. Amount in words beneath the figure on anything a
  customer signs.
- Everything interactive carries `.no-print`.

---

## 9. Accessibility

- Contrast: 4.5:1 body text, 3:1 UI and chart marks. The palettes above are
  validated against both surfaces.
- **Never colour alone.** Status is colour + icon + word. Chart identity is
  colour + legend + direct label + table view.
- Full keyboard operation on the sale screen and every document grid — that is
  the speed requirement and the accessibility requirement at once.
- Visible focus ring: 2px, `brand-500`, 2px offset. Already in `.btn`.
- Charts get `role="img"` and a summary `aria-label`; the table view is the
  accessible equivalent, not an afterthought.

---

## 10. Dark mode

Defined, not scheduled. The dark palette above is *selected* — the same hues
re-stepped for a dark surface and re-validated — not an automatic inversion.

Worth building when someone asks. Warehouse and counter screens are in daylight;
this is a convenience, not a need.

---

## 11. Tokens to add

Append to `web/src/index.css`, inside `@theme`:

Correct the brand hue from 250 to **261.5**, then append the rest:

```css
/* Brand — hue taken from the website's own accent #3d78e6 */
--color-brand-50:  oklch(0.97  0.02  261.5);
--color-brand-100: oklch(0.94  0.045 261.5);
--color-brand-200: oklch(0.88  0.08  261.5);
--color-brand-300: oklch(0.80  0.12  261.5);
--color-brand-400: oklch(0.72  0.155 261.5);
--color-brand-500: oklch(0.635 0.175 261.5);
--color-brand-600: oklch(0.555 0.175 261.5);   /* #346dd7 — interactive */
--color-brand-700: oklch(0.47  0.155 261.5);
--color-brand-800: oklch(0.38  0.125 261.5);
--color-brand-900: oklch(0.30  0.095 261.5);

/* Identity — the masthead bar, exactly as the website sets it */
--color-brand-identity: #3d78e6;
--color-brand-red:      #dc2626;

/* Chart surfaces */
--color-chart-surface: #ffffff;
--color-chart-grid:    #e2e8f0;   /* slate-200 */
--color-chart-axis:    #94a3b8;   /* slate-400 */

/* Categorical — 4 slots for bars/lines/stacks, first 3 for scatter */
--color-series-1: #346dd7;        /* = brand-600 */
--color-series-2: #c57800;
--color-series-3: #009d89;
--color-series-4: #6f3bb2;

/* De-emphasis, for the emphasis pattern */
--color-series-muted: #cbd5e1;    /* slate-300 */

/* Status — reserved, never a series */
--color-status-good:     #1c882d;
--color-status-warning:  #d78d00;
--color-status-critical: #dc2626; /* the brand red */

/* Sequential — the brand ramp, so charts and UI share one blue */
--color-seq-100: #dbecff;
--color-seq-200: #bad9ff;
--color-seq-300: #92beff;
--color-seq-400: #6ca2ff;
--color-seq-500: #4b86f3;
--color-seq-600: #346dd7;
--color-seq-700: #2455b0;
--color-seq-800: #193e84;

/* Dashboard type */
--text-stat: 1.5rem;
--text-hero: 3rem;

/* Masthead only — never on data */
--font-display: 'Jost', var(--font-sans);
```

---

## 12. Open

1. **Language.** English only, or Urdu on printed documents? It changes the
   typeface, and Urdu would change the layout direction of the print templates.
2. **Barcode scanning.** The legacy schema carries a barcode column. If scanners
   are in use, the sale screen's search field needs scanner-first focus handling.
3. **Logo as SVG.** `logo-mark.png` is 694×699 raster. At A5 masthead size it
   will do, but an SVG would print sharply and scale to any document. Ask
   whoever drew it.
4. **The invocation strip.** The website opens with rotating Quranic
   invocations in Noto Naskh Arabic. Should printed invoices carry one too? Many
   Pakistani trading documents do, and it is a decision for you, not for me.
5. **Receipt printer.** A5 PDF as specified, or thermal roll at the counter? They
   are different templates.

---

*Answers to [PRINCIPLES.md](PRINCIPLES.md) and [SPECS.md](SPECS.md). Chart
palettes were validated with the dataviz skill's `validate_palette.js`; re-run it
before changing any colour.*
