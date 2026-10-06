"""Build the public, aggregated-only data files for the interactive dashboard in ../website.

Inputs (aggregated tables and processed beat polygons produced by the analysis):
    code/outputs/tables/police_beat_year_summary_2016_2025.csv
    code/outputs/tables/annual_trends_2016_2025.csv
    code/data/processed/spatial/police_beats_2016_analysis.geojson  (geometry only is used)

Outputs:
    website/data/police_beats_web.geojson   one simplified polygon per police beat
    website/data/map_properties.json        beat-year summaries, metric definitions and class breaks
    website/data/annual_trends.json         city-wide annual totals
    website/data/insights.json              findings computed from the tables

Run from the project root:
    .venv/Scripts/python.exe code/build_website_data.py

No collision-level or participant-level record is written to the website.
"""

import json
import logging
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[1]
TABLES = ROOT / "code" / "outputs" / "tables"
BEATS_SRC = ROOT / "code" / "data" / "processed" / "spatial" / "police_beats_2016_analysis.geojson"
WEB = ROOT / "website"

MIN_KNOWN_INJURY = 30
FIRST_YEAR = 2018  # 2016 and 2017 are incompletely covered and are excluded from the website
# ~0.0002 degrees is roughly 20 m; enough detail for beat-level choropleths.
SIMPLIFY_TOLERANCE = 0.0002
COORD_GRID = 1e-5

RECORD_FIELDS = [
    "year", "police_beat", "unique_collisions", "participant_records", "known_injury_records",
    "serious_fatal_records", "fatal_records", "serious_fatal_rate", "fatal_rate",
]
FIVE_NAMES = ["Very low", "Low", "Medium", "High", "Very high"]

# Map metrics. "quintile": five relative classes; "zero_quartile": a separate zero class plus
# quartiles of the non-zero values, for sparse metrics where most beat-years are zero.
METRICS = [
    {
        "key": "frequency", "label": "Collision frequency", "field": "unique_collisions", "kind": "count",
        "rate": False, "scheme": "quintile",
        "colors": ["#DCE8EF", "#A9C2D3", "#7FA6BE", "#5B8DB3", "#294B66"],
        "note": "Unique collision reports (distinct report_id) per beat-year.",
    },
    {
        "key": "severity", "label": "Serious/fatal injury rate", "field": "serious_fatal_rate", "kind": "rate",
        "rate": True, "scheme": "quintile",
        "colors": ["#F1D9D9", "#E5B7B8", "#D78F92", "#C96D72", "#B95055"],
        "note": "Serious/severe/fatal participants divided by participants with known injury status.",
    },
    {
        "key": "fatal_rate", "label": "Fatal injury rate", "field": "fatal_rate", "kind": "rate",
        "rate": True, "scheme": "zero_quartile",
        "colors": ["#EFE4EA", "#D9B3C4", "#BC7F9C", "#934E74", "#5E2349"],
        "note": "Fatal participants divided by participants with known injury status.",
    },
    {
        "key": "serious_fatal", "label": "Serious/fatal records", "field": "serious_fatal_records", "kind": "count",
        "rate": False, "scheme": "zero_quartile",
        "colors": ["#F4E7D7", "#E7C49C", "#D49A62", "#B36D36", "#7A4419"],
        "note": "Participants with serious/severe or fatal injuries per beat-year.",
    },
    {
        "key": "fatal", "label": "Fatal records", "field": "fatal_records", "kind": "count",
        "rate": False, "scheme": "zero_quartile",
        "colors": ["#ECE6F0", "#C6B4D4", "#9A7FB4", "#6E4E8E", "#422860"],
        "note": "Participants with fatal injuries per beat-year.",
    },
]


def write_json(path: Path, obj: object) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    logger.info("wrote %s (%.1f KB)", path.relative_to(ROOT), path.stat().st_size / 1024)


def pct(x: float) -> str:
    return f"{x * 100:.2f}%"


def fmt_value(x: float, rate: bool) -> str:
    return pct(x) if rate else f"{x:,.0f}"


def eligible_values(m: pd.DataFrame, metric: dict) -> pd.Series:
    """Values that enter the classification pool: rates only for beat-years above the threshold."""
    rows = m[m["known_injury_records"] >= MIN_KNOWN_INJURY] if metric["rate"] else m
    return rows[metric["field"]].dropna()


def class_thresholds(values: pd.Series, scheme: str) -> list:
    """Upper bounds of every class except the last (value <= bound joins that class)."""
    if scheme == "quintile":
        bounds = values.quantile([0.2, 0.4, 0.6, 0.8]).tolist()
    else:
        bounds = [0.0] + values[values > 0].quantile([0.25, 0.5, 0.75]).tolist()
    return sorted(set(bounds))


def classify(values: pd.Series, bounds: list) -> np.ndarray:
    # side="left": a value equal to a bound belongs to that bound's class, matching the JS rule.
    return np.searchsorted(np.asarray(bounds), values.to_numpy(), side="left")


def build_metric(m: pd.DataFrame, metric: dict) -> dict:
    values = eligible_values(m, metric)
    bounds = class_thresholds(values, metric["scheme"])
    idx = classify(values, bounds)
    n_classes = len(bounds) + 1
    palette = [metric["colors"][i] for i in np.round(np.linspace(0, 4, n_classes)).astype(int)]
    names = FIVE_NAMES if metric["scheme"] == "quintile" else ["Zero"] + FIVE_NAMES[1:n_classes]
    classes = []
    for i in range(n_classes):
        members = values[idx == i]
        assert len(members), f"{metric['key']}: empty class {i}"
        lo, hi = fmt_value(members.min(), metric["rate"]), fmt_value(members.max(), metric["rate"])
        classes.append({
            "name": names[i],
            "range": lo if lo == hi else f"{lo}–{hi}",
            "max": bounds[i] if i < len(bounds) else None,
            "color": palette[i],
            "count": int(len(members)),
        })
    return {k: metric[k] for k in ("key", "label", "field", "kind", "rate", "note")} | {"classes": classes}


def build_geometry(table_beats: set) -> set:
    """Write one simplified polygon feature per police beat, excluding beat 0; return beats without polygons."""
    gdf = gpd.read_file(BEATS_SRC)[["police_beat", "geometry"]]
    gdf["police_beat"] = gdf["police_beat"].astype(int)
    gdf = gdf[gdf["police_beat"] != 0].dissolve(by="police_beat", as_index=False)
    gdf["geometry"] = shapely.set_precision(
        gdf.geometry.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True).values, COORD_GRID
    )
    gdf["geometry"] = shapely.make_valid(gdf.geometry.values)
    gdf = gdf[~gdf.geometry.is_empty]

    assert gdf["police_beat"].is_unique, "duplicate police_beat features"
    assert gdf.geometry.is_valid.all(), "invalid geometry after simplification"
    assert set(gdf.geom_type) <= {"Polygon", "MultiPolygon"}, set(gdf.geom_type)

    out = WEB / "data" / "police_beats_web.geojson"
    gdf.to_crs(4326).to_file(out, driver="GeoJSON")
    logger.info("wrote %s (%d features, %.1f MB)", out.relative_to(ROOT), len(gdf), out.stat().st_size / 1e6)
    return table_beats - set(gdf["police_beat"])


def build_map_properties(m: pd.DataFrame, metrics: list, unmapped: set) -> None:
    assert (m["severity_eligible"] == (m["known_injury_records"] >= MIN_KNOWN_INJURY)).all()
    rec = m[RECORD_FIELDS]
    write_json(WEB / "data" / "map_properties.json", {
        "years": sorted(int(y) for y in m["year"].unique()),
        "min_known_injury_records": MIN_KNOWN_INJURY,
        "beats_without_polygon": sorted(int(b) for b in unmapped),
        "metrics": metrics,
        # A rate is undefined (NaN) when no injury status is known; JSON has no NaN, so write null.
        "records": rec.astype(object).where(rec.notna(), None).to_dict(orient="records"),
    })


def annual_insights(a: pd.DataFrame) -> list:
    a = a.set_index("year")
    c = a.at  # column-typed scalar access keeps integer counts as integers
    peak_year = int(a["unique_collisions"].idxmax())
    last_year = int(a.index.max())
    first_year = int(a.index.min())
    low_year = int(a.loc[peak_year:, "unique_collisions"].idxmin())
    sf_year = int(a["serious_fatal_records"].idxmax())
    fatal_year = int(a["fatal_records"].idxmax())
    drop = 1 - c[last_year, "unique_collisions"] / c[peak_year, "unique_collisions"]
    sf_drop = 1 - c[last_year, "serious_fatal_records"] / c[peak_year, "serious_fatal_records"]
    return [
        f"Collision frequency peaks at {c[peak_year, 'unique_collisions']:,} reports in {peak_year}, then generally "
        f"declines to {c[low_year, 'unique_collisions']:,} in {low_year} and {c[last_year, 'unique_collisions']:,} in "
        f"{last_year}, a {drop:.1%} decrease from the peak.",
        f"Severity does not follow that decline: serious/fatal records fall only {sf_drop:.1%} from {peak_year} to "
        f"{last_year} (peaking at {c[sf_year, 'serious_fatal_records']} in {sf_year}; fatal records peak at "
        f"{c[fatal_year, 'fatal_records']} in {fatal_year}), and the serious/fatal rate stays between "
        f"{pct(a['serious_fatal_rate'].min())} and {pct(a['serious_fatal_rate'].max())} in {first_year}-{last_year}.",
    ]


def beat_insights(m: pd.DataFrame, metrics: dict) -> list:
    n_years = m["year"].nunique()
    e = m[m["known_injury_records"] >= MIN_KNOWN_INJURY]

    top = m.loc[m.groupby("year")["unique_collisions"].idxmax()]
    lead_beat = int(top["police_beat"].mode().iloc[0])
    lead_years = int((top["police_beat"] == lead_beat).sum())
    totals = m.groupby("police_beat")["unique_collisions"].sum().sort_values(ascending=False)

    freq_bounds = [c["max"] for c in metrics["frequency"]["classes"][:-1]]
    vh = m[classify(m["unique_collisions"], freq_bounds) == len(freq_bounds)]
    vh_years = vh.groupby("police_beat").size()
    persistent = sorted(int(b) for b in vh_years[vh_years >= n_years - 2].index)

    sev_bounds = [c["max"] for c in metrics["severity"]["classes"][:-1]]
    e_vh = e[classify(e["serious_fatal_rate"], sev_bounds) == len(sev_bounds)]
    sev_repeat = (e_vh.groupby("police_beat").size() >= 3).sum()
    rank_corr = e["unique_collisions"].rank().corr(e["serious_fatal_rate"].rank())

    return [
        f"Police beat {lead_beat} has the highest collision frequency in {lead_years} of {n_years} years. Its "
        f"{totals.iloc[0]:,} reports over {int(m['year'].min())}-{int(m['year'].max())} are {totals.iloc[0] / totals.iloc[1]:.1f} times those of the "
        f"next beat ({totals.index[1]}).",
        f"{len(persistent)} beats are in the Very high frequency class in at least {n_years - 2} of {n_years} years "
        f"({', '.join(map(str, persistent))}): collision hotspots are spatially persistent.",
        f"High frequency does not mean high severity: across {len(e)} eligible beat-years the rank correlation between "
        f"frequency and serious/fatal rate is {rank_corr:.2f}, and only {sev_repeat} beats reach Very high severity "
        "in three or more years.",
    ]


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    (WEB / "data").mkdir(parents=True, exist_ok=True)

    m = pd.read_csv(TABLES / "police_beat_year_summary_2016_2025.csv")
    m = m[(m["police_beat"] != 0) & (m["year"] >= FIRST_YEAR)].copy()
    m["fatal_rate"] = m["fatal_records"] / m["known_injury_records"].where(m["known_injury_records"] > 0)
    a = pd.read_csv(TABLES / "annual_trends_2016_2025.csv")
    a = a[a["year"] >= FIRST_YEAR].copy()
    a["fatal_rate"] = a["fatal_records"] / a["known_injury_records"]

    metrics = [build_metric(m, spec) for spec in METRICS]
    by_key = {mt["key"]: mt for mt in metrics}
    unmapped = build_geometry(set(m["police_beat"]))
    build_map_properties(m, metrics, unmapped)
    write_json(WEB / "data" / "annual_trends.json", a.to_dict(orient="records"))
    write_json(WEB / "data" / "insights.json", {"sections": [
        {"title": f"City-wide trend, {FIRST_YEAR}-{int(a['year'].max())}", "bullets": annual_insights(a)},
        {"title": "Police-beat patterns over space and time", "bullets": beat_insights(m, by_key)},
    ]})


if __name__ == "__main__":
    main()
