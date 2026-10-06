# Website session context (handoff for the next Claude window)

Paste or attach this file at the start of a new session. It records what was built and the rules to keep.

## Project

- Folder: `D:\desktop\BDA\Groupproject` (not a git repo yet).
- Goal: a static, interactive web dashboard of San Diego police-beat collisions, **2018–2025**.
- Stack: plain HTML/CSS/JS + Leaflet 1.9.4 + Chart.js 4.4.1 from CDNs. No React, Vite, TypeScript, or backend.
- The user writes in Chinese; answer in Chinese. Keep all code comments in English.

## User rules (must keep)

1. Publish **aggregated data only**. Never copy collision-level or participant-level files (`Datasets/`, `code/data/raw/`, `code/data/processed/*.csv`, `code/data/processed/yearly/`) into `website/`.
2. **Never delete files.** Everything else may be changed without asking for approval.
3. English-only comments. No Chinese variable names, no duplicated functions.
4. Do not touch the ArcGIS Pro folder `Spatial_Rong/`.
5. When the user says "其他不需要改动", change only what was asked.

## File layout

```
code/build_website_data.py       Generates everything in website/data/ from aggregated tables
website/
├── index.html                   Header, dashboard mount, 01 Findings, 02 Methods and limitations
├── README.md                    Full docs: run, fields, metrics, update, embed API, GitHub Pages
├── assets/css/style.css         Styles ("cd-" prefix)
├── assets/js/app.js             Dashboard; exposes window.CollisionDashboard = { initialize }
├── data/                        Generated, aggregated only (4 files)
│   ├── police_beats_web.geojson   428 beat polygons, property police_beat, beat 0 excluded
│   ├── map_properties.json        years, metrics + class breaks, beat-year records
│   ├── annual_trends.json         city-wide totals per year
│   └── insights.json              Findings text (generated; hand edits are overwritten)
└── images/                      Obsolete static PNGs from v1; unreferenced; not deleted (user rule)
Website_session_context.md       This file
```

Inputs of the build script:
- `code/outputs/tables/police_beat_year_summary_2016_2025.csv`
- `code/outputs/tables/annual_trends_2016_2025.csv`
- `code/data/processed/spatial/police_beats_2016_analysis.geojson` (geometry only)

## Commands

```powershell
# Rebuild data after changing the script or tables
.venv\Scripts\python.exe code\build_website_data.py
# Run locally, then open http://localhost:8000 (double-clicking index.html does not work)
python -m http.server 8000 --directory website
```

## Key design facts

- `FIRST_YEAR = 2018` in the build script filters both tables; 2016–2017 are excluded as incomplete.
- Five metrics (`METRICS` list in the script): `frequency` (unique_collisions), `severity` (serious_fatal_rate), `fatal_rate`, `serious_fatal` (records), `fatal` (records).
- Classes are pooled over all 2018–2025 beat-years: quintiles for frequency and serious/fatal rate; for sparse metrics, zero is its own class and non-zero values are split into quartiles. Rule: value <= upper bound, the same in Python and JS.
- Rates are shown only when `known_injury_records >= 30`; otherwise "Not eligible".
- A beat-year with no table row is shown as "No collision summary" (grey). The table has no zero rows, so a missing row is shown as a gap, not as 0.
- 287 of the 428 polygons never have records: all are `div = 0` areas, apparently outside SDPD patrol divisions. Beat codes 71, 200, 600, 760, 904, 999 have records but no polygon.
- Findings are computed in `annual_insights()` and `beat_insights()` of the build script. Edit wording there, not in `insights.json`.
- In `app.js`, `CAUTION_YEARS = {}`, so no year shows the caution banner now.

## What was done in this session (in order)

1. Built v1 of the website: GeoJSON, data JSON, findings, methods, and README.
2. Per the user, removed all static figures and the annual table. Rebuilt it as an interactive spatiotemporal dashboard: metric chips, year slider and play button, Leaflet map with hover and popups, dynamic legend, top-10 ranking, city-wide chart (click a year to jump to it), and per-beat trend chart.
3. Explained why some beats have empty trend charts (no table rows, as described above). No changes.
4. Cut "01 Findings" to 5 bullets (2 city-wide + 3 beat-level) and "02 Methods and limitations" to 5 items (2 definitions + 3 limits).
5. Gave step-by-step instructions for submitting to a teammate's GitHub: clone their repo, branch, copy only `website/` (minus `images/`) and `code/build_website_data.py`, commit, push, open a PR. No git action was taken.
6. Changed the time range to 2018–2025: filtered the script, rewrote the city-wide findings, updated the year text in `index.html`, and emptied `CAUTION_YEARS`. Class breaks were recomputed (frequency classes are now 1–22, 23–38, 39–57, 58–94, 95–537).
7. Updated `website/README.md` to 2018–2025 and wrote this file.

## Current Findings (2018–2025)

- Frequency peaks at 10,174 reports in 2019 and reaches 7,543 in 2024 and 7,576 in 2025, a 25.5% decrease from the peak.
- Serious/fatal records fall only 5.0% from 2019 to 2025 (peak 272 in 2021; fatal records peak at 63 in 2021). The serious/fatal rate stays between 4.93% and 5.77%.
- Beat 122 has the highest frequency in 8 of 8 years: 3,409 reports, 1.7 times the next beat (242).
- 21 beats are in the Very high frequency class in at least 6 of 8 years: persistent hotspots.
- The rank correlation between frequency and serious/fatal rate across 463 eligible beat-years is −0.01. Only 9 beats reach Very high severity in 3 or more years.

## Verification used

- Browser test with playwright-core@1.40 (Node 18) and Edge (`channel: "msedge"`), using scripts in the session scratchpad (not in the project).
- Last check: slider 2018–2025 (8 years), chart labels 2018–2025, 428 polygons, 5 findings, 5 methods items, no console errors.

## Open items (not done)

- `website/images/` can be deleted by the user.
- Optionally host CDN assets and fonts locally if the site must work in mainland China.
