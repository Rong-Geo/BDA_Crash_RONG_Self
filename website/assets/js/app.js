/*
 * San Diego police-beat collision dashboard.
 * Interactive spatiotemporal view: Leaflet choropleth + year slider/animation + Chart.js trend charts.
 * All metric definitions and class breaks come from data/map_properties.json (built by code/build_website_data.py).
 * Public API: window.CollisionDashboard.initialize(options) -> Promise
 */
(function () {
  "use strict";

  const NO_SUMMARY = "No collision summary";
  const NOT_ELIGIBLE = "Not eligible";
  const STATUS_COLORS = { [NOT_ELIGIBLE]: "#E8D9AE", [NO_SUMMARY]: "#D9DEE3" };
  const PLAY_INTERVAL_MS = 1400;
  const CAUTION_YEARS = {};

  const DEFAULTS = {
    root: "#collision-dashboard", // dashboard shell (controls, map, legend, charts)
    insights: "#findings", // optional: findings list target
    dataUrl: "data/",
    metric: "frequency",
    year: null, // null = latest year
  };

  // ponytail: one dashboard per page; turn this into a class if several instances are ever needed.
  const state = {
    metric: null, year: null, beat: null, timer: null,
    data: null, index: null, map: null, layer: null, charts: {}, els: {},
  };

  // ---------- data ----------

  async function loadData(dataUrl) {
    const base = dataUrl.endsWith("/") ? dataUrl : dataUrl + "/";
    const names = ["police_beats_web.geojson", "map_properties.json", "annual_trends.json", "insights.json"];
    const [beats, props, trends, insights] = await Promise.all(
      names.map(async (name) => {
        const res = await fetch(base + name);
        if (!res.ok) throw new Error(`Could not load ${name} (HTTP ${res.status})`);
        return res.json();
      })
    );
    const index = new Map(props.records.map((r) => [`${r.year}|${r.police_beat}`, r]));
    const metrics = Object.fromEntries(props.metrics.map((m) => [m.key, m]));
    return { data: { beats, props, trends, insights, metrics }, index };
  }

  // ---------- value and class helpers ----------

  const fmtInt = (n) => Number(n).toLocaleString("en-US");
  const fmtPct = (x) => (x * 100).toFixed(2) + "%";
  const metricDef = (key) => state.data.metrics[key || state.metric];
  const fmtValue = (m, v) => (m.rate ? fmtPct(v) : fmtInt(v));
  const getRecord = (beat, year) => state.index.get(`${year}|${beat}`);
  const isEligible = (r) => r.known_injury_records >= state.data.props.min_known_injury_records;

  /** Metric value for a record, or null when the metric is undefined/not eligible. */
  function valueOf(r, m) {
    if (!r || (m.rate && !isEligible(r))) return null;
    return r[m.field];
  }

  /** Returns { label, color } for a record under a metric. */
  function classOf(r, m) {
    if (!r) return { label: NO_SUMMARY, color: STATUS_COLORS[NO_SUMMARY] };
    const v = valueOf(r, m);
    if (v === null) return { label: NOT_ELIGIBLE, color: STATUS_COLORS[NOT_ELIGIBLE] };
    const c = m.classes.find((k) => k.max === null || v <= k.max);
    return { label: c.name, color: c.color };
  }

  // ---------- map ----------

  function styleFeature(feature) {
    const beat = feature.properties.police_beat;
    const selected = beat === state.beat;
    return {
      fillColor: classOf(getRecord(beat, state.year), metricDef()).color,
      fillOpacity: 0.82,
      color: selected ? "#E8A317" : "#4A5A66",
      weight: selected ? 3.5 : 0.6,
      opacity: selected ? 1 : 0.7,
    };
  }

  function popupContent(feature) {
    const beat = feature.properties.police_beat;
    const r = getRecord(beat, state.year);
    const head = `<div class="cd-popup__head"><span>Police beat ${beat}</span><span>${state.year}</span></div>`;
    if (!r) return `${head}<p class="cd-popup__empty">${NO_SUMMARY}</p>`;

    const min = state.data.props.min_known_injury_records;
    const eligible = isEligible(r);
    const rate = (field) => (eligible && r[field] !== null ? fmtPct(r[field]) : NOT_ELIGIBLE);
    const rows = [
      ["Unique collisions", fmtInt(r.unique_collisions)],
      ["Participant records", fmtInt(r.participant_records)],
      ["Known injury records", fmtInt(r.known_injury_records)],
      ["Serious/fatal records", fmtInt(r.serious_fatal_records)],
      ["Fatal records", fmtInt(r.fatal_records)],
      ["Serious/fatal rate", rate("serious_fatal_rate")],
      ["Fatal rate", rate("fatal_rate")],
      ["Frequency class", classOf(r, metricDef("frequency")).label],
      ["Severity class", classOf(r, metricDef("severity")).label],
      ["Analysis status", eligible ? "Frequency and severity analysed" : `Frequency only; severity needs ≥ ${min} known injury records`],
    ];
    const body = rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join("");
    return `${head}<table class="cd-popup__table">${body}</table>`;
  }

  function renderMap() {
    if (!state.map) {
      state.map = L.map(state.els.map, { scrollWheelZoom: false, zoomSnap: 0.25 });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(state.map);

      state.layer = L.geoJSON(state.data.beats, {
        style: styleFeature,
        onEachFeature: (feature, layer) => {
          layer.bindPopup(() => popupContent(feature), { maxWidth: 320 });
          layer.on({
            mouseover: (e) => {
              e.target.setStyle({ weight: 2.5, color: "#14202A", opacity: 1, fillOpacity: 0.95 });
              e.target.bringToFront();
            },
            mouseout: (e) => state.layer.resetStyle(e.target),
            click: () => selectBeat(feature.properties.police_beat, false),
          });
        },
      }).addTo(state.map);
      state.map.fitBounds(state.layer.getBounds(), { padding: [8, 8] });
      return;
    }
    state.layer.setStyle(styleFeature);
    state.layer.eachLayer((l) => l.isPopupOpen() && l.setPopupContent(popupContent(l.feature)));
  }

  function layerFor(beat) {
    return state.layer.getLayers().find((l) => l.feature.properties.police_beat === beat);
  }

  // ---------- side panel: legend and ranking ----------

  function renderLegend() {
    const m = metricDef();
    const counts = {};
    state.data.beats.features.forEach((f) => {
      const label = classOf(getRecord(f.properties.police_beat, state.year), m).label;
      counts[label] = (counts[label] || 0) + 1;
    });
    const items = m.classes.map((c) => [c.name, c.range, c.color])
      .concat(m.rate ? [[NOT_ELIGIBLE, "", STATUS_COLORS[NOT_ELIGIBLE]]] : [])
      .concat([[NO_SUMMARY, "", STATUS_COLORS[NO_SUMMARY]]]);
    state.els.legend.innerHTML =
      `<h3 class="cd-panel__title">${m.label}, ${state.year}</h3><ul class="cd-legend__list">` +
      items.map(([name, range, color]) =>
        `<li><span class="cd-swatch" style="background:${color}"></span>` +
        `<span class="cd-legend__label">${name}${range ? ` <small>${range}</small>` : ""}</span>` +
        `<span class="cd-legend__count">${counts[name] || 0}</span></li>`).join("") +
      `</ul><p class="cd-note">${m.note} Classes are relative, pooled over all years.` +
      `${m.rate ? ` Rates need ≥ ${state.data.props.min_known_injury_records} known injury records.` : ""} Right column: beats on the map.</p>`;
  }

  function renderRanking() {
    const m = metricDef();
    const rows = state.data.props.records
      .filter((r) => r.year === state.year && valueOf(r, m) && layerFor(r.police_beat))
      .sort((a, b) => valueOf(b, m) - valueOf(a, m))
      .slice(0, 10);
    const top = rows.length ? valueOf(rows[0], m) : 1;
    state.els.ranking.innerHTML =
      `<h3 class="cd-panel__title">Top beats, ${state.year}</h3>` +
      (rows.length
        ? `<ol class="cd-rank">` + rows.map((r) =>
            `<li><button type="button" data-beat="${r.police_beat}" class="${r.police_beat === state.beat ? "is-active" : ""}">` +
            `<span class="cd-rank__beat">Beat ${r.police_beat}</span>` +
            `<span class="cd-rank__bar"><i style="width:${(100 * valueOf(r, m)) / top}%;background:${classOf(r, m).color}"></i></span>` +
            `<span class="cd-rank__val">${fmtValue(m, valueOf(r, m))}</span></button></li>`).join("") + `</ol>`
        : `<p class="cd-note">No beat has a value for this metric in ${state.year}.</p>`);
  }

  // ---------- charts ----------

  function makeChart(canvas, onPickYear) {
    return new Chart(canvas, {
      type: "bar", // base type gives a category year axis; datasets override with their own type
      data: { labels: state.data.props.years, datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        interaction: { mode: "index", intersect: false },
        onClick: (evt, els, chart) => {
          const i = chart.scales.x.getValueForPixel(evt.x);
          if (i >= 0 && i < state.data.props.years.length) onPickYear(state.data.props.years[i]);
        },
        plugins: { legend: { labels: { boxWidth: 12, font: { family: "Public Sans" } } } },
        scales: { y: { beginAtZero: true, grid: { color: "#ECE8DF" } }, x: { grid: { display: false } } },
      },
    });
  }

  function setChartAxis(chart, m) {
    chart.options.scales.y.ticks = { callback: (v) => (m.rate ? (v * 100).toFixed(1) + "%" : fmtInt(v)) };
    chart.options.plugins.tooltip = { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw === null ? "n/a" : fmtValue(m, c.raw)}` } };
  }

  function renderCharts() {
    const m = metricDef();
    const years = state.data.props.years;
    const accent = m.classes[m.classes.length - 1].color;
    const city = years.map((y) => (state.data.trends.find((t) => t.year === y) || {})[m.field] ?? null);

    const cityChart = state.charts.city;
    cityChart.data.datasets = [{
      type: "bar", label: `City-wide ${m.label.toLowerCase()}`, data: city,
      backgroundColor: years.map((y) => (y === state.year ? accent : m.classes[1].color)),
      borderRadius: 3,
    }];
    setChartAxis(cityChart, m);
    cityChart.update();

    const beatChart = state.charts.beat;
    state.els.beatTitle.textContent = state.beat === null ? "Beat trend: click a beat on the map" : `Beat ${state.beat}: ${m.label.toLowerCase()} over time`;
    const beatSeries = years.map((y) => valueOf(getRecord(state.beat, y), m));
    beatChart.data.datasets = state.beat === null ? [] : [
      {
        type: "line", label: `Beat ${state.beat}`, data: beatSeries, borderColor: accent, backgroundColor: accent,
        pointRadius: years.map((y) => (y === state.year ? 6 : 3)), spanGaps: false, tension: 0.2,
      },
    ].concat(m.rate ? [{
      type: "line", label: "City-wide", data: city, borderColor: "#8996A0", borderDash: [5, 4], pointRadius: 0,
    }] : []);
    setChartAxis(beatChart, m);
    beatChart.update();
  }

  // ---------- controls and state changes ----------

  function buildShell(root) {
    const { years, metrics } = state.data.props;
    root.classList.add("cd");
    root.innerHTML = `
      <div class="cd__bar">
        <fieldset class="cd-seg"><legend>Metric</legend><div class="cd-seg__row">${metrics.map((m) =>
          `<label class="cd-seg__opt"><input type="radio" name="cd-metric" value="${m.key}"${m.key === state.metric ? " checked" : ""}><span>${m.label}</span></label>`).join("")}</div></fieldset>
        <div class="cd-time">
          <span class="cd-time__legend">Year</span>
          <div class="cd-time__row">
            <button type="button" class="cd-play" aria-label="Play years">▶</button>
            <input type="range" class="cd-slider" min="0" max="${years.length - 1}" step="1" value="${years.indexOf(state.year)}" aria-label="Year">
            <output class="cd-year"></output>
          </div>
          <div class="cd-ticks">${years.map((y) => `<span>${y}</span>`).join("")}</div>
        </div>
      </div>
      <p class="cd-caution" hidden></p>
      <div class="cd__main">
        <div class="cd__map" role="region" aria-label="Police-beat map"></div>
        <aside class="cd__panel"><div class="cd-legend" aria-live="polite"></div><div class="cd-ranking"></div></aside>
      </div>
      <div class="cd__charts">
        <figure class="cd-chart"><figcaption>City-wide trend · click a year to show it on the map</figcaption><div class="cd-chart__box"><canvas></canvas></div></figure>
        <figure class="cd-chart"><figcaption class="cd-beat-title"></figcaption><div class="cd-chart__box"><canvas></canvas></div></figure>
      </div>`;
    const q = (s) => root.querySelector(s);
    const canvases = root.querySelectorAll("canvas");
    state.els = {
      map: q(".cd__map"), legend: q(".cd-legend"), ranking: q(".cd-ranking"), slider: q(".cd-slider"),
      year: q(".cd-year"), play: q(".cd-play"), caution: q(".cd-caution"), beatTitle: q(".cd-beat-title"),
    };
    state.charts = { city: makeChart(canvases[0], setYear), beat: makeChart(canvases[1], setYear) };

    root.addEventListener("change", (e) => {
      if (e.target.name === "cd-metric") { state.metric = e.target.value; update(); }
    });
    state.els.slider.addEventListener("input", (e) => setYear(years[Number(e.target.value)]));
    state.els.play.addEventListener("click", togglePlay);
    state.els.ranking.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-beat]");
      if (btn) selectBeat(Number(btn.dataset.beat), true);
    });
  }

  function setYear(year) {
    state.year = year;
    update();
  }

  function selectBeat(beat, focus) {
    state.beat = beat;
    update();
    const layer = layerFor(beat);
    if (focus && layer) {
      state.map.fitBounds(layer.getBounds(), { maxZoom: 13, padding: [40, 40] });
      layer.openPopup();
    }
  }

  function togglePlay() {
    const years = state.data.props.years;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    } else {
      if (state.year === years[years.length - 1]) setYear(years[0]);
      state.timer = setInterval(() => {
        const i = years.indexOf(state.year) + 1;
        if (i >= years.length) return togglePlay();
        setYear(years[i]);
      }, PLAY_INTERVAL_MS);
    }
    state.els.play.textContent = state.timer ? "❚❚" : "▶";
    state.els.play.setAttribute("aria-label", state.timer ? "Pause" : "Play years");
  }

  function update() {
    const years = state.data.props.years;
    state.els.slider.value = years.indexOf(state.year);
    state.els.year.textContent = state.year;
    state.els.caution.hidden = !CAUTION_YEARS[state.year];
    state.els.caution.textContent = CAUTION_YEARS[state.year] || "";
    renderMap();
    renderLegend();
    renderRanking();
    renderCharts();
  }

  function renderInsights(target) {
    const el = target && document.querySelector(target);
    if (!el) return;
    el.replaceChildren(...state.data.insights.sections.map((section) => {
      const wrap = document.createElement("div");
      wrap.className = "cd-insights__section";
      const h = document.createElement("h3");
      h.textContent = section.title;
      const ul = document.createElement("ul");
      section.bullets.forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        ul.appendChild(li);
      });
      wrap.append(h, ul);
      return wrap;
    }));
  }

  // ---------- public API ----------

  async function initialize(options) {
    const opts = Object.assign({}, DEFAULTS, options);
    const root = typeof opts.root === "string" ? document.querySelector(opts.root) : opts.root;
    if (!root) throw new Error(`CollisionDashboard: root element ${opts.root} not found`);
    if (typeof L === "undefined" || typeof Chart === "undefined") {
      throw new Error("CollisionDashboard: Leaflet and Chart.js must be loaded first");
    }
    try {
      Object.assign(state, await loadData(opts.dataUrl));
    } catch (err) {
      root.innerHTML = `<p class="cd-error">Dashboard data could not be loaded: ${err.message}. ` +
        `If you opened the file directly, serve the folder over HTTP (see README).</p>`;
      throw err;
    }
    const years = state.data.props.years;
    state.metric = state.data.metrics[opts.metric] ? opts.metric : state.data.props.metrics[0].key;
    state.year = years.includes(Number(opts.year)) ? Number(opts.year) : years[years.length - 1];

    buildShell(root);
    update();
    renderInsights(opts.insights);
    return { map: state.map, setYear, selectBeat: (beat) => selectBeat(beat, true) };
  }

  window.CollisionDashboard = { initialize };
})();
