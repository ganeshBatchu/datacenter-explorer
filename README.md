# Global Data-Centre Infrastructure Explorer

An interactive explorer for a geopolitical research dataset on global data-centre
infrastructure — 194 facilities, 17 countries, 73 operators — built to examine
**capacity and jurisdictional control** rather than raw facility counts.

Unit of analysis is the facility; aggregation to the country is done in the app.

The dataset is **not committed here**. GitHub Actions downloads it from its
public OneDrive share link on every deploy and publishes it beside the site, so
the browser reads it same-origin — no CORS, no proxy, no sign-in, and no research
data in git history.

```bash
node scripts/fetch-workbook.mjs   # pull the workbook down once
node scripts/serve.mjs            # → http://localhost:4173
```

`?local=1` is a dev shortcut that reads the local copy explicitly; without it the
app reads `data/master_dataset_1_values_2.xlsx` either way.

> **The dataset is effectively public.** The published site serves the workbook to
> anyone who opens it. This was a deliberate trade for near-live data with no
> sign-in, no consent and no tenant administrator. See
> [Access, and why it works this way](#access-and-why-it-works-this-way).

No build step, no bundler, no framework. Three runtime dependencies (Leaflet,
Leaflet.markercluster, SheetJS), all from CDN with SRI hashes.

---

## Read this first: capacity is coded for 30% of the dataset

`Capacity (MW)` is free text in the workbook, and only **59 of 194 facilities**
carry a usable number (7,076 MW total). The rest are `→`, `→ to verify`,
`region`, `site (MW n/p)`, or — for two rows — a **floor area in m²**, which is
not power and is never read as MW.

The gaps are unevenly distributed, so a naive `SUM` by country measures *how much
has been sourced* as much as real capacity:

| Country | Facilities | Capacity coded for | Summed MW |
|---|---|---|---|
| United States | 56 | 11 | 2,652 |
| China | 19 | 5 | 833 |
| Malaysia | 11 | 7 | 908 |
| Netherlands | 7 | **0** | **0** |
| United Kingdom | 7 | 1 | 80 |

The workbook's own README says these were left blank deliberately, because
operator IT load is proprietary. The app therefore never silently treats a blank
as zero. Instead:

- **Coded only** (default) — aggregates the 59 real figures, with a live
  "*n* of *m* coded" badge on every capacity view and a coverage banner pinned
  to the top of the page.
- **Estimated** — fills the 135 gaps from the median of coded facilities sharing
  the same operator, then operator class, then the global median. Every imputed
  value is flagged (dashed marker outline, italic table cell, warning banner) and
  **excluded from the CSV export's main capacity column**. These numbers are not
  in your workbook. Treat them as indicative structure, never as findings.
- **Strict basis** — an additional switch that drops coded figures which don't
  describe this building's current load: `~1,289 (campus)` (whole campus),
  `300+ (planned campus)` (a floor on a future build), `~150 (early phase)`.
  With it on, only `reported` and `approximate` figures count.

## Other data-quality caveats the app surfaces

- **Coordinates are city/area centroids at 2 decimal places** (~1.1 km), 16 rows
  at 1 dp (~11 km) — not site locations. Many facilities share a point exactly:
  6 at Ashburn, 6 at Dublin, 5 at Frankfurt, 4 each at Johor, Singapore, Mumbai
  and Chennai. Marker clustering with spiderfy-on-max-zoom is what makes those
  individually clickable. Coordinate coverage is 194/194.
- **`Environmental risk tier` is derived, not observed** — 3 values, and the
  workbook README describes it as *inferred* from operator class. The WRI
  water-stress tier (6 levels) is the better environmental axis and is the
  scatter's default y.
- **`Internet freedom` is missing for 34 facilities** whose host country is
  absent from Freedom House's FOTN (Malaysia, UAE, Sweden, Ireland …). That is a
  real category — `Not rated (absent from FOTN)` — not a zero.
- **Operator nationality is a composite string**, parsed into
  `operatorCountry` / `nChineseOperators`, and owner origin additionally yields
  `domicile` so Cayman/VIE structures are a first-class filter. Multi-country
  cells (`United States / Canada`, `Australia / US PE`) are **kept whole**, which
  is why the dimension has 21 values rather than ~15. Splitting them to a single
  "primary" nationality is an analytical choice the app deliberately does not
  make for you.
- **DC-0001 is the workbook's placeholder example row** (`(example) Equinix SG3`).
  It is excluded by default, which is why the app reports 193 where the workbook
  has 194.
- **Category labels are inconsistent upstream** — `Service model` has 18 labels
  for ~4 real classes, `Operator type` 22 for ~6, `Facility status` 6 for 2,
  `Water-stress` 10 for 6 tiers plus appended basin notes. The **Grouped / Raw**
  switch toggles between collapsed labels and the verbatim strings; the exact
  original is always shown in the facility detail panel.
- All four sheet joins are clean: 194/194 facility IDs match across `Facilities`
  and `Consolidated (all layers)`, 194/194 operator cells match `Operators`
  exactly, every facility country is present in `Jurisdictions`. Any future
  breakage shows as a "join warnings" badge in the header rather than silent nulls.

---

## Where the data comes from

`master_dataset_1_values_2.xlsx`, fetched at load time from a public OneDrive
link. **This is the file matching the project's stated scale (194 / 17 / 73);**
the similarly-named `master_dataset_1_values.xlsx` has only 104 facilities and
`master_dataset_1_values_1.xlsx` 134.

The workbook is **not committed**. `.gitignore` blocks `data/*.xlsx`,
`data/consolidated.json` and `data/consolidated.csv`, so it cannot be added by
accident; the only tracked file in `data/` is `countries.geo.json` (public
Natural Earth polygons). A local copy at `data/master_dataset_1_values_2.xlsx` is
still useful — `export_data.py`, `refresh.py` and `?local=1` all use it — but it
never enters git.

The app reads **four sheets and joins them**, because the consolidated sheet
alone cannot support the map:

| Sheet | Header row | Provides |
|---|---|---|
| `Facilities` | 1 | **Lat, Long, facility name, city, water-stress, service model, Include? flag** — none of which exist on the consolidated sheet |
| `Consolidated (all layers)` | **2** (row 1 is merged layer bands) | Layers 0–5: ownership, supply chain, regulatory / sovereignty |
| `Operators` | 1 | Ultimate parent, parent HQ, BIS Entity List, OFAC / NS-CMIC, LEI, legal domicile |
| `Jurisdictions` | 1 | WGI rule of law, grid carbon, FOTN score (the `EU (bloc)` row is excluded from country joins) |

Column names are read from the real header strings and centralised in
`COLS` at the top of [`src/normalize.js`](src/normalize.js) — the single place to
edit if a header is renamed upstream.

### Updating the data

The app parses the `.xlsx` directly in the browser, so replacing the file is all
that's needed. Use the refresh script rather than `cp` — it guards against the
one mistake this dataset invites, picking the wrong version:

```bash
python3 scripts/refresh.py --list   # show every candidate with its row counts
python3 scripts/refresh.py          # inspect, confirm, install, re-export
```

It scans `~/Downloads` for `master_dataset*.xlsx`, counts facilities/countries/
operators in each, flags any workbook missing the consolidated sheet, and
**refuses to install a file with fewer facilities than the current one** unless
you confirm interactively. It then regenerates the JSON/CSV exports and prints
the data-quality report, so a refresh can't quietly change capacity coverage
without you seeing it.

```
currently bundled:
  master_dataset_1_values_2.xlsx    194 facilities · 17 countries ·  66 operators

candidates in /Users/you/Downloads:
    master_dataset.xlsx                 1 facilities ·  1 countries ·   1 operators  [!] no consolidated sheet
    master_dataset_1_values.xlsx      104 facilities · 17 countries ·  35 operators
    master_dataset_1_values_1.xlsx    134 facilities · 17 countries ·  47 operators
  → master_dataset_1_values_2.xlsx    194 facilities · 17 countries ·  66 operators
```

Then reload the app. No export step is required for the app itself to work.

### The export script

`scripts/export_data.py` produces flat files for *other* consumers — pandas, R,
Stata, a co-author who wants a CSV, or diffing two workbook revisions:

```bash
python3 -m pip install openpyxl        # once
python3 scripts/export_data.py         # → data/consolidated.json + .csv
python3 scripts/export_data.py --check # schema + data-quality report, writes nothing
```

`--check` prints the same coverage figures the app displays, which is how you
confirm the Python and JS normalizers still agree. They deliberately mirror each
other; **if you change a parsing rule, change it in both.**

The CSV contains only what the workbook contains — imputed capacity is never
written to it. The in-app **Export CSV** button exports the current filtered
slice, keeping estimated values in a separate `capacity_estimated_mw` column so
a generated number can never be mistaken for source data.

---

## What's in the app

One filter row scopes **every** view simultaneously — there are no per-chart
filters. Click any bar, segment, legend swatch, treemap cell or country to
cross-filter; click again to clear. `Esc` unpins a selection, then clears filters.

**Geography** — one marker per facility, area ∝ MW, colour by a selectable
dimension, with clustering and spiderfy. Toggle to a **country choropleth** of
aggregate capacity or facility count on a single-hue sequential ramp.

**Distributions** — capacity histogram (click a bar to filter to that MW range),
water-stress tiers, environmental-risk tiers.

**Rankings** — total capacity or facility count by host country, by operator, and
by operator nationality, each switchable between MW and site count.

**Composition** — stacked shares of ownership structure, service model, Freedom
House band, WGI regulatory quality, WGI political stability, operator type,
data-localization regime, FDI screening.

**Scatter** — any two axes from five numeric measures (MW, FOTN score, WGI rule of
law, grid carbon, year RFS) and five ordinal ones (water stress, environmental
risk, WGI bands, FOTN band). Capacity defaults to a log x-axis because coded
values span 6–1,289 MW. Ordinal axes are deterministically jittered.

**Treemap** — capacity by country → operator.

**Facility detail** — all 35+ fields grouped by the workbook's own Layer 0–5
bands, showing raw values, plus status flags for BIS / OFAC listing, offshore
domicile, service-model exclusion and estimated capacity.

**Table view** — sortable, the WCAG-clean twin of every chart, with CSV export.

### Design notes

Categorical colours are assigned from a validated palette in two sets, because
the two chart families have different colourblind-safety gates: bars and stacks
use all 8 documented slots (only neighbouring pairs touch), while **map markers
and scatter dots are capped at 4 hues** — a brute-force search over every subset
found that no 5-hue subset clears the all-pairs CVD and normal-vision floors in
both light and dark mode. Categories past the cap fold into a desaturated
"Other". Hues are assigned from the *unfiltered* dataset, so filtering never
repaints the survivors. Details in [`src/colors.js`](src/colors.js).

Light and dark are both selected palettes, not an inverted flip. The theme
follows the OS by default; the ◐ button overrides and persists.

Everything is keyboard-reachable — bars, stack segments, histogram columns,
scatter dots and markers are real focusable controls, and focus shows the same
tooltip as hover.

---

## The live site

**https://ganeshbatchu.github.io/datacenter-explorer/**

Send that link to anyone. They open it and see the dashboard — no install, no
account, no sign-in, on desktop or phone.

Deployment is [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml),
which on every push, hourly, and on demand:

1. downloads the workbook from OneDrive (`scripts/fetch-workbook.mjs`),
2. validates its schema and regenerates the CSV/JSON exports,
3. publishes the whole directory — code plus the freshly downloaded workbook — to
   GitHub Pages.

Because the workbook is downloaded into the build and never committed, it appears
on the published site but not in git history.

## Access, and why it works this way

The dataset is reachable by anyone who has either the site URL or the share link.
That is the consequence of an "Anyone with the link" OneDrive URL being embedded
in client-side JavaScript, and it is a deliberate choice, arrived at by
elimination:

- **Anonymous sharing from the university account** — blocked by the tenant. The
  link returns `403` with `X-Forms_Based_Auth_Required` to any anonymous caller.
- **Per-viewer sign-in (Entra + Graph, reading the file as each viewer)** — built
  and then removed. It needs an app registration, and the tenant blocks
  non-admins from creating one. The code is in git history if that ever changes.
- **Gating the site instead** (Cloudflare Access on an `@northeastern.edu` email
  policy, dataset bundled, repo private) — still viable and needs no
  administrator. It costs live updates and requires a private repo. Outlined in
  [`docs/onedrive.md`](docs/onedrive.md#fallback-gate-the-site) if the data ever
  needs restricting.

So: **treat the share link as public.** If something in the workbook should not
be, remove it from the workbook rather than relying on the link being obscure.

## Refreshing what viewers see

**Save the file in Excel.** The deploy workflow re-downloads the workbook every
hour, so edits reach viewers on the next run — no export, no commit, no redeploy.

For an immediate refresh, trigger it by hand: repository **Actions → Deploy site →
Run workflow**. Or:

```bash
gh workflow run "Deploy site" --repo ganeshBatchu/datacenter-explorer
```

Each run prints the dataset's coverage summary to the run summary page, and
**fails rather than publishing** if a required header cell has gone missing — so a
stray edit in Excel breaks the build loudly instead of silently emptying the
dashboard.

### Genuinely live, if you want it

The hourly rebuild is a compromise: a browser cannot read a personal OneDrive
share link directly. The link must first be *redeemed* server-side to mint a
`FedAuth` cookie, and its response carries no `Access-Control-Allow-Origin`.
[`worker/worker.js`](worker/worker.js) is a Cloudflare Worker that does both; set
`oneDriveShareUrl` **and** `corsProxy` in `src/config.js` to switch the app to
per-load fetching. It needs a free Cloudflare account, which is the only reason
it is not the default.

## Why there is no Excel add-in

An earlier plan included an Office task-pane add-in. Office resolves add-ins only
from AppSource (public, requires Microsoft validation), Microsoft 365 centralized
deployment or a SharePoint app catalog (both organisation-only and
admin-provisioned), or per-user sideloading — a shared OneDrive link conveys the
*workbook*, not the add-in. Since the same tenant restrictions that ruled out
per-viewer sign-in also rule out centralized deployment, sideloading would be the
only route, and it has to be repeated by every viewer on every machine.

The hosted site reaches everyone with one link, no install and no admin. If you
ever want the add-in anyway, the whole visualization layer is host-agnostic: only
a manifest and an `Excel.run` reader in `src/adapter/` would be new.

## Project layout

```
index.html                  entry point
  .github/workflows/deploy.yml   fetch data → validate → publish to Pages
worker/worker.js               optional Cloudflare Worker for per-load live data
src/
  config.js                 where the data comes from
  app.js                    bootstrap, gate routing, render loop
  normalize.js              COLS map, parsers, category grouping, the join   ← start here
  store.js                  one filter state, cross-filtering, capacity mode
  colors.js                 validated palettes, stable hue assignment
  style.css                 design tokens, wide ⇄ ~350px reflow
  adapter/
    index.js                source routing → SheetJS → raw sheets
    onedrive.js             anonymous share-link fetch, with URL-form fallbacks
  views/
    gate.js                 setup + error screens (with per-failure remedies)
    util.js                 DOM/SVG helpers, tooltip, aggregation
    filters.js              the single filter row, stat tiles, coverage banner
    map.js                  markers, clustering, choropleth
    bars.js                 ranked bars, tier bars, composition, treemap
    plots.js                capacity histogram, linked scatter
    detail.js               facility detail panel, table view, CSV export
scripts/
  serve.mjs                 static dev server
  fetch-workbook.mjs        download the workbook from OneDrive (used by CI)
  refresh.py                safely swap in a newer local workbook
  export_data.py            xlsx → JSON/CSV, and --check schema/quality report
docs/
  onedrive.md               share-link setup, what was tested, the gated fallback
data/
  countries.geo.json               Natural Earth 110m, trimmed to 17 countries (tracked)
  master_dataset_1_values_2.xlsx   local copy — gitignored, never committed
  consolidated.json / .csv         generated exports — gitignored
```

`countries.geo.json` is Natural Earth 1:110m admin-0, trimmed to the 17 host
countries and rounded to 2 dp (39 KB). Natural Earth omits Singapore at that
scale, so its polygon is an **approximated** island outline — flagged
`"approx": true` in the file and in the choropleth tooltip.

## Troubleshooting

**"No data source configured"** — `workbookUrl` is empty in `src/config.js`.

**"the deploy workflow may not have published the workbook yet"** — the site is up
but the workbook is missing. Check the latest **Deploy site** run in the Actions
tab; the download or schema-validation step probably failed.

**"missing required header cells"** — a header cell in the source workbook was
cleared or renamed. In Excel, **File → Version history** undoes an accidental
edit; then re-run the deploy.

**"work or university OneDrive" error** — the link is a `*.sharepoint.com`
address. Those refuse anonymous requests and no proxy can fix it; move the
workbook to a personal Microsoft account.

**"not an .xlsx — got a sign-in page"** — the link isn't shared as *Anyone with
the link*. Re-share it and copy the new URL.

**"Failed to fetch" on a personal-account link** — the response is missing
`Access-Control-Allow-Origin`. Set `CONFIG.corsProxy`; see
[`docs/onedrive.md`](docs/onedrive.md) for a locked-down Cloudflare Worker.

**A "join warnings" badge in the header** — a facility ID, operator name or
country stopped matching across sheets. Hover it for the list, or run
`python3 scripts/export_data.py --check`.

**Charts empty but the map has markers** — you're in *Coded only* mode with a
filter selecting no facility that has a capacity figure. Switch to Estimated or
widen the filter.

**Opened `index.html` from disk** — ES modules and `fetch` need a real HTTP
origin. Run `node scripts/serve.mjs`.

The app's own error screen is more specific than this list: it inspects both the
failure and your configured link, and prints the matching remedy inline.
