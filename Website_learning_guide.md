# Website 学习指南：San Diego Police-Beat Collision Dashboard

这份文件只用来学习，不改动任何代码。读完后你应该能回答三个问题：这个网站由哪几块组成、数据怎么从 CSV 走到浏览器、改东西时要避开哪些坑。

---

## 1. 一句话总结架构

**Python 离线算好一切 → 生成 4 个静态 JSON/GeoJSON → 浏览器里的纯 JS 读取并画图。**

没有后端、没有数据库、没有 React/Vite 构建步骤。这叫 **static site + build-time data pipeline**（构建期数据管线）。

```
code/outputs/tables/*.csv  ─┐
code/data/processed/spatial/*.geojson ─┤
                            ▼
          code/build_website_data.py   (Python: pandas + geopandas + shapely)
                            ▼
website/data/
 ├── police_beats_web.geojson   地图多边形（428 个 beat）
 ├── map_properties.json        每个 beat-year 的数值 + 指标定义 + 分级断点 + 颜色
 ├── annual_trends.json         全市每年总数
 └── insights.json              Findings 文字（由 Python 计算生成）
                            ▼
website/index.html  ── 加载 Leaflet + Chart.js (CDN) + assets/js/app.js
                            ▼
app.js: fetch 4 个文件 → 建 UI → 地图 / 图例 / 排名 / 两张图表
```

**核心设计思想：所有“业务逻辑”（分级、颜色、文字结论）都在 Python 里决定，JS 只负责显示。** 所以改指标、改颜色、改 Findings 措辞，都改 Python，不改 JS。

---

## 2. 文件逐个讲解

### 2.1 `website/index.html`（79 行）——页面骨架

| 位置 | 作用 | 学习点 |
|---|---|---|
| L5 `<meta name="viewport">` | 手机端正确缩放 | Responsive design 的第一步 |
| L10–12 | Google Fonts，`preconnect` 提前建连接 | 性能优化：preconnect |
| L13–14 | Leaflet CSS，带 `integrity` 和 `crossorigin` | **SRI (Subresource Integrity)**：防止 CDN 文件被篡改 |
| L33 `<div id="collision-dashboard">` | 空容器，JS 会往里填满所有控件 | “mount point” 模式 |
| L36–56 | Findings 和 Methods 区块 | `<section aria-labelledby>`、`<dl>/<dt>/<dd>` 语义化 HTML |
| L32 `.visually-hidden` | 视觉隐藏但屏幕阅读器能读的标题 | Accessibility (a11y) |
| L66–69 | 先加载 Leaflet、Chart.js，再加载 app.js | **脚本顺序很重要**：app.js 依赖全局变量 `L` 和 `Chart` |
| L70–77 | 调用 `CollisionDashboard.initialize({...})` | 配置与代码分离：页面只传参数 |

### 2.2 `website/assets/js/app.js`（376 行）——全部交互逻辑

整体结构是一个 **IIFE**（立即执行函数）：

```js
(function () {
  "use strict";
  ...
  window.CollisionDashboard = { initialize };
})();
```

IIFE 把内部变量关在函数作用域里，只对外暴露一个 `initialize`。这是在没有 ES modules / 打包工具时最常用的封装方式。

按区块读（文件里有 `// ---------- xxx ----------` 分隔）：

| 区块 | 关键函数 | 你该学会的 |
|---|---|---|
| 常量与状态 L10–28 | `DEFAULTS`, `state` | **单一状态对象**：metric / year / beat / timer 全放在 `state` 里 |
| data L32–45 | `loadData()` | `async/await`、`fetch`、`Promise.all` 并行加载；`res.ok` 检查 HTTP 错误；用 `Map` 建 `"year|beat"` 索引实现 O(1) 查找 |
| helpers L47–69 | `valueOf`, `classOf` | 三种状态：**无记录 → 灰色**、**样本不足 → Not eligible**、**正常 → 按断点分级**。`classes.find(k => k.max === null \|\| v <= k.max)` 是分级规则 |
| map L73–141 | `styleFeature`, `popupContent`, `renderMap` | Leaflet 基础：`L.map`、`L.tileLayer`、`L.geoJSON(data, {style, onEachFeature})`、hover 高亮、`bindPopup`、`fitBounds`。**首次创建、之后只 `setStyle`**，不重建图层 |
| side panel L145–181 | `renderLegend`, `renderRanking` | 用模板字符串生成 HTML；ranking 用 `filter → sort → slice(0,10)` |
| charts L185–237 | `makeChart`, `renderCharts` | Chart.js：混合类型图表、`onClick` 里用 `scales.x.getValueForPixel` 把点击位置换成年份；更新时改 `chart.data.datasets` 再 `chart.update()` |
| controls L241–328 | `buildShell`, `setYear`, `selectBeat`, `togglePlay`, `update` | **事件委托**（在 root 上监听 `change`、在 ranking 上用 `closest("button[data-beat]")`）；`setInterval` 做播放动画 |
| public API L351–376 | `initialize` | 参数合并 `Object.assign({}, DEFAULTS, options)`；依赖检查；加载失败时给用户可读的错误提示 |

**最重要的一个模式：单向数据流**

```
用户操作（选指标 / 拖滑块 / 点 beat / 点图表）
        ↓
修改 state（state.metric / state.year / state.beat）
        ↓
update()  →  renderMap() + renderLegend() + renderRanking() + renderCharts()
```

每个交互都只改 state，然后统一调用 `update()` 重画全部。这就是 React 的核心思想（state → render），只是这里手写。好处：不会出现“地图更新了但图例没更新”的不同步问题。

### 2.3 `website/assets/css/style.css`（283 行）——样式

| 学习点 | 例子 |
|---|---|
| **CSS 自定义属性（变量）** | `:root { --paper; --ink; --freq; --sev; ... }`，全站颜色字体集中管理 |
| **类名前缀 `cd-`** | 嵌入别人页面时不会和对方的 CSS 冲突 |
| **BEM 风格命名** | `.cd__map`（元素）、`.cd-rank__bar`、`.is-active`（状态） |
| **CSS Grid 布局** | `.cd__main { grid-template-columns: minmax(0,1fr) 320px }`：地图自适应 + 固定宽侧栏 |
| `minmax(0, 1fr)` | 防止 grid 子元素被长内容撑破，这是常见坑 |
| `clamp()` 响应式字号 | `h1 { font: ... clamp(2rem, 4.6vw, 3.4rem) }` |
| 媒体查询 | 文件后半段在窄屏把侧栏移到地图下方 |
| 字体分工 | Serif 标题（Newsreader）、Sans 正文（Public Sans）、Mono 标签/数字（IBM Plex Mono） |

### 2.4 `code/build_website_data.py`（249 行）——数据管线

| 函数 | 做什么 | 学习点 |
|---|---|---|
| 顶部常量 | `MIN_KNOWN_INJURY = 30`、`FIRST_YEAR = 2018`、`METRICS` 列表 | **配置驱动**：加一个指标只需在 `METRICS` 里加一项 |
| `class_thresholds` | quintile 或 zero + quartile 断点 | `pandas.quantile`；稀疏数据（大多数为 0）要单独处理 0 |
| `classify` | `np.searchsorted(..., side="left")` | 注释写明要和 JS 的 `v <= max` **规则一致** |
| `build_metric` | 生成每类的 name / range / max / color / count，`assert` 没有空类 | 用 assert 做数据自检 |
| `build_geometry` | dissolve → simplify(≈20 m) → set_precision → make_valid → 转 WGS84 | GIS 基础：**几何简化减小文件体积**、坐标系 EPSG:4326 |
| `build_map_properties` | `NaN → null` 后写 JSON | JSON 标准不支持 NaN；`allow_nan=False` 让错误立刻暴露 |
| `annual_insights` / `beat_insights` | 用数据算出 Findings 句子 | **文字跟数据走**：数据更新后结论自动更新，不会出现文字和图不一致 |

---

## 3. 设计决策（为什么这样设计）

1. **静态网站而不是后端**：数据量小（约 1 MB），不需要实时查询；可以免费放在 GitHub Pages；没有服务器要维护。
2. **预先聚合，只发布 beat-year 汇总**：隐私保护。原始 collision-level / participant-level 记录永远不进 `website/`。
3. **分级断点在 Python 里算、跨所有年份统一（pooled）**：同一颜色在 2018 和 2025 代表同一数值区间，年份之间可以直接比较。如果每年单独分级，颜色就不可比。
4. **Rate 需要 ≥ 30 条已知伤情记录**：小样本比率噪声很大（1/2 = 50%），设门槛避免误导。
5. **“无记录”和“0”分开**：表里没有 0 行，所以缺失行显示为灰色 gap，而不是假装是 0。
6. **元数据驱动 UI**：指标按钮、图例、颜色全部从 `map_properties.json` 读，JS 里没有写死任何指标名。
7. **可嵌入 API**：`initialize(options)` 返回 `{ map, setYear, selectBeat }`，队友可以在自己的页面里调用或用 iframe。
8. **无框架**：376 行 JS 就够用；引入 React + 构建工具对这个规模是负担。

---

## 4. 你应该学习的知识点（按优先级）

### P0 必须懂（否则改不动这个网站）
- **HTML 语义标签**：`section`、`header`、`main`、`figure`、`fieldset/legend`、`dl`
- **CSS**：变量、Grid、Flexbox、媒体查询、选择器优先级
- **JavaScript 基础**：箭头函数、模板字符串、解构、`Array.map/filter/sort/find`、`Map`、`Object.fromEntries`
- **异步**：`Promise`、`async/await`、`fetch`、`Promise.all`
- **DOM**：`querySelector`、`addEventListener`、事件委托、`innerHTML` vs `textContent`
- **JSON 和 GeoJSON 格式**：`FeatureCollection → features[] → { geometry, properties }`

### P1 应该懂（理解为什么这样写）
- **Leaflet**：tile layer、GeoJSON layer、style 函数、popup、`fitBounds`
- **Chart.js**：dataset、scales、tooltip callbacks、`update()`
- **Choropleth（分级设色地图）**：quantile 分级、顺序色板、为什么要统一断点
- **pandas / geopandas**：`groupby`、`quantile`、`dissolve`、`simplify`、`to_crs`
- **坐标参考系 CRS**：WGS84 (EPSG:4326) 是 Web 地图的标准输入
- **本地 HTTP 服务器** 和 **CORS / same-origin**：为什么双击 `index.html` 打不开

### P2 进阶（以后再学）
- ES modules 与打包工具（Vite）——项目变大时才需要
- Web accessibility（ARIA、键盘操作、`aria-live`）
- 地图瓦片服务政策与自托管
- GitHub Pages 部署

---

## 5. 注意点 / 常见坑

| # | 坑 | 后果 | 怎么做 |
|---|---|---|---|
| 1 | 双击打开 `index.html`（`file://`） | `fetch` 被浏览器拦截，数据加载失败 | 用 `python -m http.server 8000 --directory website` |
| 2 | 手改 `insights.json` | 下次运行 build 脚本被覆盖 | 改 `annual_insights()` / `beat_insights()` |
| 3 | 只改 Python 分级规则不改 JS（或反过来） | 地图颜色和图例/Findings 不一致 | Python `searchsorted(side="left")` ⇔ JS `v <= max`，必须同时改 |
| 4 | 把原始数据复制进 `website/` | 隐私泄露 | `website/data` 只应有 4 个文件 |
| 5 | JSON 里出现 `NaN` | 浏览器 `res.json()` 解析失败 | 写 JSON 前转 `null`，并保持 `allow_nan=False` |
| 6 | 把“缺失行”当成 0 | 低估、错误排名 | 保持 `NO_SUMMARY` 灰色逻辑 |
| 7 | app.js 在 Leaflet/Chart.js 之前加载 | `L is not defined` | 保持 `<script>` 顺序 |
| 8 | 一页放两个 dashboard | 共用全局 `state`，互相干扰 | 现在只支持一个实例（代码里有 `ponytail:` 注释说明） |
| 9 | 依赖 CDN（unpkg / jsdelivr / Google Fonts / OSM 瓦片） | 断网或某些地区（如中国大陆）加载失败 | 需要时把库和字体放到本地 |
| 10 | Chart.js 的 `<script>` 没有 `integrity` | 少一层防篡改保护（Leaflet 有） | 可以以后补上 SRI hash |
| 11 | 删掉 OSM attribution | 违反 OSM 使用条款 | 地图角落的版权必须保留 |
| 12 | 用 `innerHTML` 插入外部或用户输入的文字 | XSS 风险 | 现在数据是自己生成的，所以安全；Findings 已经用 `textContent`。以后如果接入外部文字，也要用 `textContent` |
| 13 | 文档和数据不一致 | 读者困惑 | 例：`Website_session_context.md` 写 beat 760 没有 polygon，但当前 `map_properties.json` 的 `beats_without_polygon` 是 `[71, 200, 600, 904, 999]`。改了数据后要同步检查文档 |

---

## 6. 建议的学习路线（动手）

1. **跑起来**：启动本地服务器，打开浏览器 DevTools（F12）→ Network 面板，看 4 个数据文件怎么加载。
2. **看数据**：打开 `website/data/map_properties.json`，找到 `metrics[0].classes` 和 `records[0]`，对照 2.4 节理解每个字段。
3. **跟一次点击**：在 `app.js` 的 `setYear` 里打断点（DevTools → Sources），拖动滑块，单步走完 `update()` 的四个 render。
4. **改一个颜色做实验**：在 build 脚本的 `METRICS` 里改一个颜色 → 重新运行脚本 → 刷新页面。体会“改 Python，不改 JS”。
5. **读 Leaflet 官方 choropleth 教程**（leafletjs.com/examples/choropleth），和 `renderMap()` 对照，你会发现结构几乎一样。
6. **最后再读 CSS**：用 DevTools 的 Elements 面板勾选/取消样式，看 Grid 布局怎么变。

---

## 7. 速查：改什么去哪里

| 想改 | 改哪里 |
|---|---|
| 年份范围 | `build_website_data.py` 的 `FIRST_YEAR`，然后重新 build；同时检查 `index.html` 里写死的 “2018–2025” |
| 加/改指标、颜色、分级方式 | `build_website_data.py` 的 `METRICS` |
| Rate 门槛 | `MIN_KNOWN_INJURY` |
| Findings 文字 | `annual_insights()` / `beat_insights()` |
| Methods 文字、标题 | `index.html` |
| 页面配色、字体 | `style.css` 的 `:root` 变量 |
| 播放速度 | `app.js` 的 `PLAY_INTERVAL_MS` |
| 底图 | `app.js` `renderMap()` 里的 `L.tileLayer` URL |
| 某年显示警告横幅 | `app.js` 的 `CAUTION_YEARS` |
