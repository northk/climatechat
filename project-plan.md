# ClimateChat — Project Plan

> Based on `initial-prompt.md`. Review and confirm before any code is written.
> Updated: iOS native app (Swift/SwiftUI) replaces the web frontend.

---

## 1. Recommended Tech Stack

| Layer | Choice | Justification |
|---|---|---|
| **iOS app** | Swift + SwiftUI (iOS 16+) | Native performance; iOS 16 is the Swift Charts floor and covers the vast majority of active devices |
| **Charts** | Swift Charts (Apple framework) | Native iOS charting, zero dependencies, first-class SwiftUI integration, introduced iOS 16 |
| **Backend runtime** | Cloudflare Worker (TypeScript) | Free tier, holds the API key securely, stateless request handler; static typing catches response-envelope and tool-schema mistakes at compile time instead of at runtime |
| **Rate limiting + cache** | Cloudflare KV | Included in free tier; used for per-IP request counters and cached Claude responses |
| **AI SDK** | Anthropic SDK (`@anthropic-ai/sdk`) in the Worker | Tool use is first-class; the Worker does the Claude agentic loop |
| **Claude model** | `claude-sonnet-5` | Current-generation Sonnet — best balance of reasoning quality and cost/speed for tool-use loops. `claude-sonnet-4-6` (previous gen) is still active but not the current model; verify the exact string at docs.anthropic.com before coding starts, since model IDs shift over time. Note: `claude-sonnet-5` rejects non-default `temperature`/`top_p`/`top_k` with a 400 error — see Phase 3, step 16 |
| **Greenhouse gas data** | NOAA GML (`gml.noaa.gov/ccgg`) | CO2/CH4/N2O only — official US government source, flat CSV files, no key required. GML does **not** publish temperature, sea ice, or ocean heat data |
| **Temperature + ocean data** | NOAA NCEI (`ncei.noaa.gov`) | Surface temperature anomaly (NOAAGlobalTemp) and ocean heat content — a different NOAA division from GML, with its own API |
| **Sea ice data** | NSIDC (`noaadata.apps.nsidc.org`) | Arctic sea ice extent — distributed jointly with NOAA under the Sea Ice Index, not part of GML |
| **City-level data source** | Open-Meteo | City-level historical weather; free tier for non-commercial use only (see R8) |
| **Distribution** | TestFlight | Requires Apple Developer account ($99/yr); no App Review needed for internal testing |
| **Xcode version** | Xcode 27.0 | Installed version (build 27A266a, confirmed 2026-09-21); targets iOS 16+ deployment |
| **Worker tests** | Vitest + `@cloudflare/vitest-pool-workers` | Runs tests inside the actual Workers runtime with local KV simulation, so rate limiting and caching are tested realistically rather than against mocks |
| **iOS tests** | XCTest unit target | Runs headless via Xcode (Cmd+U) or `xcodebuild test -scheme ClimateChat -destination 'platform=iOS Simulator,name=iPhone 16'` from the terminal, so tests are runnable from Claude Code without the Xcode GUI |
| **Worker lint/format** | TypeScript `"strict": true` + ESLint (typescript-eslint recommended config) + Prettier | Strict mode makes the `types.ts` envelope-type split (Section 4) load-bearing; ESLint's `no-floating-promises` catches forgotten `await`s on KV writes and fetches — the most likely silent bug in this async-heavy Worker; Prettier ends formatting drift between coding sessions |
| **iOS lint** | SwiftLint, default ruleset, run as an Xcode build phase | Warnings surface in build output, and it's CLI-runnable (`swiftlint lint`) so it works headless from the terminal |

**What's intentionally excluded:**
- No CloudKit/iCloud sync — conversation history lives in memory for the session only (v1)
- No Siri/App Intents, no WidgetKit — out of scope for v1
- No third-party networking library (URLSession is sufficient for a simple JSON API client)
- No third-party charting library — Swift Charts handles everything needed
- No XCUITest UI automation in v1 (slow, brittle, lowest value for a chat UI; revisit post-launch if warranted)
- No pre-commit hook frameworks (Husky/lint-staged) and no custom lint rule configs — those coordinate humans on shared codebases; a solo project with stock configs run at build/deploy time doesn't need the machinery

---

## 2. Architecture Overview

```
┌─────────────────────────────────┐
│         iOS App (SwiftUI)        │
│                                  │
│  ChatView → sends question       │
│  ResponseView → renders text     │
│  ChartView → renders Swift Chart │
└────────────┬────────────────────┘
             │ HTTPS POST /ask
             │ (JSON: messages array)
┌────────────▼──────────────────────────────┐
│         Cloudflare Worker                  │
│                                            │
│  1. verifyClient(request) → check          │
│     X-App-Secret header (see R10)          │
│  2. Cache lookup    → KV (question hash;   │
│     single-turn requests only)             │
│     └─ HIT: return immediately —           │
│        no rate-limit charge, no extra      │
│        KV write                            │
│  3. Rate limit check → KV (IP counter)     │
│     (runs on cache miss or any             │
│     multi-turn request)                    │
│  4. Call Claude (Anthropic SDK)            │
│     └─ Tool-use loop (≤7 rounds)           │
│        └─ Fetch climate data               │
│  5. Cache write     → KV (with TTL;        │
│     single-turn, non-refusal only)         │
│  6. Return structured JSON                 │
└────────────┬──────────────┬───────────────┘
             │ fetch()      │ KV read/write
┌────────────▼────────────┐ │
│  NOAA GML (ghg trends)  │ ▼
│  NOAA NCEI (temp + OHC) │ ┌─────────────────┐
│  NSIDC (sea ice)        │ │  Cloudflare KV   │
│  Open-Meteo (city data) │ │  • Rate counters │
│  (+ NASA POWER, future) │ │  • Answer cache  │
└─────────────────────────┘ └─────────────────┘
```

**Key principle:** All intelligence and data fetching lives in the Worker. The iOS app is a thin client — it sends the user's message, receives a structured JSON response, and renders it.

---

## 3. Folder and File Structure

```
climatechat/
│
├── ClimateChat/                     # Xcode project (iOS app)
│   ├── ClimateChat.xcodeproj
│   └── ClimateChat/
│       ├── App/
│       │   ├── ClimateChatApp.swift        # @main entry point
│       │   └── ContentView.swift           # Root view
│       ├── Views/
│       │   ├── ChatView.swift              # Main chat thread UI
│       │   ├── MessageBubble.swift         # Single message rendering
│       │   ├── ClimateChartView.swift      # Swift Charts wrapper
│       │   ├── ErrorView.swift             # Error state: network / Worker / rate-limit / malformed response
│       │   └── InputBar.swift              # Text field + send button
│       ├── Models/
│       │   ├── Message.swift               # Chat message model (role, content, chartData?)
│       │   └── ClimateChartData.swift      # Decoded chart payload from Worker
│       ├── Services/
│       │   └── ClimateAPIService.swift     # URLSession wrapper — POST /ask, decode response
│       ├── Config.swift                    # Worker base URL + reads APP_SECRET from Info.plist
│       ├── Secrets.xcconfig                 # APP_SECRET value — gitignored, never committed (see R10)
│       └── Secrets.xcconfig.example         # Committed template: key name + placeholder value, no real secret
│
├── worker/                          # Cloudflare Worker (TypeScript)
│   ├── wrangler.jsonc               # Wrangler config — JSON is Cloudflare's current recommended format (TOML is legacy)
│   ├── package.json
│   ├── tsconfig.json                 # Targets the Workers runtime via the generated worker-configuration.d.ts (see step 2)
│   └── src/
│       ├── index.ts                 # Entry point — no CORS headers (see R10), routes POST /ask
│       ├── types.ts                  # Shared types: TextResponse, RefusalResponse, ChartResponse, WorkerResponse union (Section 4)
│       ├── claude.ts                # Anthropic SDK, tool-use loop
│       ├── prompts.ts               # System prompt (anti-hallucination)
│       ├── rateLimit.ts             # Per-IP KV counter (5 req/day free tier)
│       ├── cache.ts                 # KV answer cache (get/set with TTL)
│       └── tools/
│           ├── registry.ts          # Exports full tool list + dispatcher
│           ├── noaaGml.ts           # 3 tools — greenhouse gases (CO2, CH4, N2O), gml.noaa.gov/ccgg
│           ├── noaaNcei.ts          # 2 tools — surface temp anomaly + ocean heat content, ncei.noaa.gov
│           ├── seaIceIndex.ts       # 1 tool — Arctic sea ice extent, NSIDC/NOAA Sea Ice Index
│           └── openMeteo.ts         # City-level historical weather (active in Phase 2)
│
├── initial-prompt.md
└── project-plan.md
```

---

## 4. Response Envelope (Worker → iOS)

The Worker always returns one of three JSON shapes. The iOS app decodes whichever it receives:

**Plain text answer:**
```json
{
  "type": "text",
  "answer": "Global CO2 levels reached 424 ppm in May 2024, according to NOAA GML..."
}
```

**Refusal answer** (off-topic questions — see Section 7):
```json
{
  "type": "refusal",
  "answer": "ClimateChat only answers questions about climate change and climate data. Try asking something like: \"How has global CO2 changed since 1960?\""
}
```
Same shape as the plain text answer — `type` and `answer` only. No tool call was made (see Section 7), so there's nothing to inject and no second construction stage, unlike the chart flow below. `RefusalResponse` is defined in `types.ts` alongside `TextResponse` and the chart types, and included in the `WorkerResponse` union the iOS app decodes against.

The iOS app renders this distinctly from a normal text answer (see Phase 4) and shows 2–3 tappable example climate questions below the refusal message — a small fixed set baked into the iOS view (e.g. "What's the current CO2 level?", "Is Arctic sea ice shrinking?", "How much have oceans warmed?"), not parsed out of Claude's `answer` text. Tapping one submits that question through the same send path as manually typed input, giving a fast way back into a climate question after a refusal.

**Chart answer — two-stage construction:**

Claude's own JSON output names *which* dataset to chart; it never re-types the data points themselves. A 140-year annual series alone is ~140 `{x, y}` pairs — well over budget for a token-limited response, and asking Claude to retype numbers it already fetched via tool call is also a needless hallucination risk. Claude returns:

```json
{
  "type": "chart",
  "chartType": "line",
  "title": "Global Temperature Anomaly (1880–2024)",
  "xLabel": "Year",
  "yLabel": "°C anomaly vs. 1901–2000 average",
  "datasets": [
    { "label": "Temperature anomaly", "sourceToolCallId": "toolu_01Abc..." }
  ],
  "explanation": "The chart shows Earth has warmed approximately 1.2°C since the late 19th century."
}
```

Before returning the response to the iOS app, the Worker (in `claude.ts`) resolves each `sourceToolCallId` against the matching `tool_result` already in the conversation, extracts the already-parsed data points from that tool's structured output (see Phase 2 — tool handlers never return raw CSV, so there's no re-parsing to do here), and replaces `sourceToolCallId` with a `data` array in the outgoing envelope:

```json
{
  "type": "chart",
  "chartType": "line",
  "title": "Global Temperature Anomaly (1880–2024)",
  "xLabel": "Year",
  "yLabel": "°C anomaly vs. 1901–2000 average",
  "datasets": [
    {
      "label": "Temperature anomaly",
      "source": "NOAA NCEI (NOAAGlobalTemp)",
      "description": "Global land+ocean surface temperature anomaly vs. 1901–2000 average (annual)",
      "unit": "°C",
      "data": [{ "x": 1880, "y": -0.16 }, { "x": 1881, "y": -0.08 }]
    }
  ],
  "explanation": "The chart shows Earth has warmed approximately 1.2°C since the late 19th century."
}
```

**Authoritative metadata vs. Claude's wording (Codex review, 2026-09-24).** Each public dataset carries `source`, `description` and `unit`, which the Worker copies from the referenced tool result. Claude never writes them. Claude's own fields (`title`, `xLabel`, `yLabel`, each dataset's `label`, `explanation`) are free text and can be wrong: an earlier version of this very example had Claude's `yLabel` claim a 1951–1980 baseline for data that's really relative to 1901–2000. So the iOS chart card must:
- show **attribution from each dataset's `source`** (and `description`), never by parsing Claude's prose
- take the **axis unit from the datasets' `unit`**, treating `yLabel` as a descriptive title only
- keep `label` as the short legend name, with `description` available as the authoritative "what is this series"

The Worker doesn't try to validate Claude's `yLabel` text against the unit, because matching free text like "°C anomaly vs. …" against "°C" is fragile. Making the app read units from the datasets makes the check unnecessary.

**Mixed units** (e.g. CO2 in ppm and methane in ppb on one chart) are possible, since Claude may chart two tools' results together. The datasets' `unit` fields make that detectable. How to *render* it (two axes, separate charts, or units in the legend) is a UI Design Spec decision (Section 5 (b)).

`validate.ts` requires `source`, `description` and `unit` to be non-empty. That also turns any cached chart from before this change into a cache miss (R2).

Only this expanded shape ever reaches the iOS app — `sourceToolCallId` is an internal Claude↔Worker contract, not part of the public API. If a series needs downsampling for chart rendering (see R6), the Worker does that here too, after resolving the raw data and before injecting it into the envelope.

Both shapes are typed in `types.ts`: a `ClaudeChartResponse` (the metadata-only shape Claude is allowed to emit) and the public `ChartResponse` (post-injection, with `data` arrays) are distinct types, so a build accidentally sending the Claude-facing shape to the iOS app fails to compile rather than failing at runtime.

Swift `Codable` structs will decode the expanded shape directly. `ClimateChartData.swift` owns the models; `ClimateChartView.swift` renders them using Swift Charts.

---

## 5. UI Design Spec

⏳ **NOT YET WRITTEN — Phase 4 must not begin until this section is complete.** Do not invent UI design details not specified here; if this section is still a placeholder when Phase 4 is reached, stop and ask.

**What's already decided — standard iOS chat conventions:** user messages right-aligned in accent-color bubbles, assistant messages left-aligned in secondary-background bubbles, input bar pinned to bottom with send button, auto-scroll on new message. Follow Apple HIG. Dark mode and Dynamic Type support are non-negotiable and must be built in from the first view, not retrofitted.

**What the completed spec will contain (all TBD):**
- (a) Empty state / first launch — TBD, including tappable example questions
- (b) Chart card treatment — TBD (title, plot, source attribution, insets). Attribution and units must come from each dataset's Worker-injected `source` / `description` / `unit`, never from Claude's `yLabel` or prose (Section 4). Must also decide how a chart whose datasets have **different units** is drawn (two axes, separate charts, or units in the legend)
- (c) Refusal and error state visual treatment — TBD
- (d) Semantic color palette — TBD (semantic names only, e.g. `accent` / `secondaryBackground` — no hex values, so dark mode works)
- (e) App icon and identity — TBD
- (f) About / Credits screen — TBD. Must credit **Open-Meteo** and **GeoNames** (both CC BY 4.0, which requires attribution) with licence links; per-answer citations name Open-Meteo but not GeoNames. See R13

**Workflow:** These TBD subsections get filled in from a design iteration done in Claude Design. Its web-based output is visual direction to spec from, not code to port — Phase 4 implements the finished spec idiomatically in SwiftUI, not by porting web markup. The design iteration has no dependency on Phases 1–3 (Worker work) and can run in parallel with them; timebox it to 1–2 evenings.

---

## 6. Sequence of Build Steps

**Testing philosophy:** Tests here map to specific documented risks, not a coverage percentage. R2 (JSON envelope reliability) is covered by the chart-injection and Codable-decoding tests; R9 (cache correctness) by the cache tests; R10 (client verification) by the `verifyClient` tests; the anti-hallucination rules (Section 7) are covered by the unanswerable-data smoke-test case in step 41. The fixture-based parser tests in Phase 2 exist because the NCEI and NSIDC endpoints are explicitly flagged as unstable there — a small, sharp set of tests aimed at real failure modes, not exhaustive boilerplate or a coverage target.

Worker tests run via `npx vitest run` (or `npx vitest` in watch mode during development); iOS tests run via `xcodebuild test -scheme ClimateChat -destination 'platform=iOS Simulator,name=iPhone 16'` (or Cmd+U in Xcode). Both suites must pass before the Phase 5 `wrangler deploy` step — a regression caught after deploy is a live regression. Lint has the same teeth: `npm run lint` (Worker) and `swiftlint lint` (iOS) must also pass before that same deploy step.

### Phase 1 — Worker skeleton
1. `npm create cloudflare@latest worker` in `worker/`, selecting the **TypeScript** "Hello World" Worker template when prompted; confirm Wrangler works. Add `vitest` and `@cloudflare/vitest-pool-workers` as dev dependencies and configure `vitest.config.ts` per the pool-workers setup (see Section 1) — tests then run inside the actual Workers runtime, with local KV simulation, rather than against mocks. Write one trivial passing test (e.g. `expect(1 + 1).toBe(2)`) and confirm it runs via `npx vitest run` — this only proves the harness itself works; real tests get added alongside each subsequent implementation step. Also enable `"strict": true` in `tsconfig.json`; add ESLint (typescript-eslint recommended config — confirm `no-floating-promises` is active) and Prettier as dev dependencies with stock configs, no custom rules; add `"lint"` and `"format"` scripts to `package.json`; confirm `npm run lint` passes on the scaffold before moving on
2. Add `@anthropic-ai/sdk` as a dependency (the SDK ships its own types). Do **not** add `@cloudflare/workers-types` — that package is the legacy route to the Workers runtime types; with wrangler v4 the generated `worker-configuration.d.ts` (from `npm run cf-typegen` / `wrangler types`) fully replaces it, covers the runtime globals like `Fetcher` and `KVNamespace`, and tracks the exact `compatibility_date` in `wrangler.jsonc`; installing both risks duplicate-declaration conflicts. Rerun `npm run cf-typegen` after any `wrangler.jsonc` bindings change. Create `src/types.ts` defining the response envelope types referenced in Section 4 (`TextResponse`, `RefusalResponse`, `ChartResponse`, `ClaudeChartResponse`, and the `WorkerResponse` union)
3. Set `ANTHROPIC_API_KEY` as a Worker secret via `wrangler secret put`
4. Create a KV namespace via Cloudflare dashboard, bind it in `wrangler.jsonc` as `CLIMATE_KV`
5. Set a monthly hard spend cap in the Anthropic account dashboard (e.g. $20) before any live traffic
6. Do **not** add CORS headers — the iOS app is a native URLSession client, not a browser, so CORS (a browser-only mechanism) never applied to it. Omitting CORS entirely, rather than setting a permissive `Access-Control-Allow-Origin: *`, is the deliberate choice: it makes a naive browser-JS abuse attempt (e.g. someone pasting a `fetch()` call into a page or console) fail at the CORS preflight stage, before the request even reaches the Worker (see R10)
7. Stub `POST /ask` that echoes the body — smoke test with `curl`
8. Start the Apple Developer Program signup at developer.apple.com **now**, in parallel with everything else. Activation takes 24–48 hours and doesn't block Phases 1–4, but it must be done well before Phase 5 (see R5) — don't wait until Phase 5 to start it.

### Phase 2 — Data tools
Every tool handler below must return structured JSON as its `tool_result` — parsed `{x, y}` data points plus metadata (units, source) — never the raw CSV/response body verbatim. This is what makes the Section 4 chart injection work: `claude.ts` pulls data straight out of the `tool_result` by `sourceToolCallId` without re-parsing it, and Claude itself reads structured JSON far more reliably than raw CSV text.

Every tool handler is also paired with fixture-based parser tests, written once its real-response fixture is captured in step 14 below — no live network calls in the test suite itself. Test each parser against its saved fixture rather than the live URL. This serves two purposes: it verifies the parsing logic, and later, when an upstream format changes (e.g. NSIDC's hardcoded `v4.0` becoming `v5.0` — see step 11), re-downloading just that one fixture and re-running the tests pinpoints exactly which parser broke, instead of debugging a live failure blind.

**Parse upstream numbers strictly (Codex review, 2026-09-23).** Every parser reads numeric fields through `parseNumber` in `tools/parse.ts`, never bare `Number()`. `Number()` turns `null`, `""`, blanks and `[]` into `0`, so a missing value would silently become a real measurement: a 0.00 °C anomaly, or a data point at year 0. `parseNumber` accepts only a finite number, or a non-blank string that `Number()` converts *in full* to a finite number. It's built from the built-ins with no regex: the blank-string check is the piece `Number()` lacks. `parseFloat()` is avoided because it reads a numeric prefix (`"1.2C"` → 1.2). It filters by the input's *form*, not its value, because genuine zeros occur (NCEI reports 0 anomalies). It inherits `Number()`'s acceptance of hex, binary and octal strings (`"0x10"` → 16). That's harmless: no upstream sends them, and one that did would still be a real value, not a missing one turned into zero. Whitespace-delimited files (NCEI ocean heat content) also skip any row whose column count doesn't match the header: a missing field there shifts every later column instead of leaving a blank. As of 2026-09-23, NCEI *omits* months without data rather than sending `null`, so this guards against a future format change, not a current bug.

9. Implement `noaaGml.ts` — NOAA Global Monitoring Laboratory, greenhouse gases only. Flat CSV files, no API key, no query parameters (fetch the file, parse the CSV, return parsed points — not the CSV text):
   - `get_co2_levels(granularity: "monthly" | "annual")` — atmospheric CO2 (ppm)
     - monthly: `https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_gl.csv` (global network) or `co2_mm_mlo.csv` (Mauna Loa only)
     - annual: `https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_gl.csv`
     - cite as **"NOAA GML"**
   - `get_methane_levels(granularity: "monthly" | "annual")` — atmospheric CH4 (ppb)
     - monthly: `https://gml.noaa.gov/webdata/ccgg/trends/ch4/ch4_mm_gl.csv`
     - annual: `https://gml.noaa.gov/webdata/ccgg/trends/ch4/ch4_annmean_gl.csv`
     - cite as **"NOAA GML"**
   - `get_nitrous_oxide_levels(granularity: "monthly" | "annual")` — atmospheric N₂O (ppb)
     - monthly: `https://gml.noaa.gov/webdata/ccgg/trends/n2o/n2o_mm_gl.csv`
     - annual: `https://gml.noaa.gov/webdata/ccgg/trends/n2o/n2o_annmean_gl.csv`
     - cite as **"NOAA GML"**
10. Implement `noaaNcei.ts` — NOAA National Centers for Environmental Information. **Not GML** — a different agency division with its own API; do not cite this data as "NOAA GML":
   - `get_surface_temperature(start_year, end_year, scale: "monthly" | "annual")` — global land+ocean temperature anomaly (°C vs. 20th-century average), served via the Climate at a Glance API: `https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/land_ocean/{month-scale}/{month}/{start}-{end}.json`. **Year ceiling (Codex review, 2026-09-24):** `end_year` can be at most the current year for monthly and the last complete year for annual. NCEI returns HTTP 404 for any range ending in a future year, and for an annual range made up only of the in-progress year (verified live). That 404 would read to Claude like an outage and be logged as `tool_fetch_failed`, so such ranges are rejected up front as `tool_input_invalid`, naming the allowed maximum.
     - ⚠️ The exact path/query format isn't exposed in NCEI's static docs — confirm it with a live request against `ncei.noaa.gov/support/access-data-service-api-user-documentation` before writing the parser
     - cite as **"NOAA NCEI (NOAAGlobalTemp)"**
   - `get_ocean_heat_content(basin: "world" | "pacific" | "atlantic" | "indian", depth: "700m" | "2000m")` — ocean heat content anomaly (10²² J), annual
     - `https://www.ncei.noaa.gov/data/oceans/woa/DATA_ANALYSIS/3M_HEAT_CONTENT/DATA/basin/yearly/h22-{w|p|a|i}0-{700|2000}m.dat` — whitespace-delimited yearly files, one per basin×depth; first data column (WO/PO/AO/IO) is the basin anomaly, remaining columns are hemispheric splits and standard errors. Record runs 1955–present
     - (Confirmed live 2026-08-07. The originally planned climdash monthly CSVs — `onemonth/ohc_levitus_climdash_monthly.csv` / `ohc2000m_...` — turned out to be **world-only** with no per-basin variants, and start in 2005; the yearly .dat files are the only path that honors the basin parameter, and their 1955-start record is better for trend questions anyway. Annual resolution is sufficient for OHC.)
     - cite as **"NOAA NCEI"**
11. Implement `seaIceIndex.ts`:
    - `get_arctic_sea_ice(month: 1-12)` — monthly Arctic sea ice extent (million km²)
      - `https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data/N_{MM}_extent_v4.0.csv` (MM = zero-padded month)
      - ⚠️ Same caveat as the two NCEI endpoints above — confirm this URL still resolves and the CSV column layout hasn't changed with a live request before writing the parser. The hardcoded `v4.0` in the path is a versioned file name, not a stable API contract; NSIDC has bumped this version before (v1 → v2 → v3 → v4) and will again
      - cite as **"NSIDC/NOAA Sea Ice Index"**
12. Implement `openMeteo.ts` — city-level historical weather:
    - `get_city_temperature_history(city, granularity: "annual" | "monthly" | "weekly", start_year?, end_year?)` — average temperature for a named city (geocoded via Open-Meteo's geocoding endpoint, then the archive API). The Worker fetches daily means and aggregates to the requested granularity — a raw multi-decade daily series is too large for a tool_result. Span caps keep responses bounded instead of forcing everything to annual: weekly ≤ 3-year span (~157 points), monthly ≤ 30 years (360 points), annual = full record since 1940 (~85 points); a too-wide request throws, and Claude narrows the range via the is_error path (step 16). Weekly/monthly ranges may include the current year — each complete week/month stands alone, which is what makes "this year vs last year so far" answerable — while annual uses complete years only; incomplete trailing periods are dropped by per-bucket completeness thresholds so a partial season never skews a mean
    - **Per-city series cache (added 2026-09-23, R12).** Annual and monthly requests are served from two KV segments per geocoded city, each aggregated to both series. Every later annual or monthly request for that city takes a slice of the combined series, however the question is worded, and in multi-turn conversations too:
      - **history** (`om:v2:hist:{year}:{lat},{lon}`): 1940 through the end of the year before last. Fetched once per city per year, about 2,190 calls. The year in the key makes the boundary move at New Year. The 400-day TTL only cleans up cities nobody asks about.
      - **recent** (`om:v2:recent:{year}:{lat},{lon}`): last year through today, with a 24h TTL, about 52 calls per refresh. Last year stays here, not in history, because the archive runs a few days behind and its newest data is preliminary, revised for a couple of months afterward. Freezing late December into history in early January would keep incomplete or superseded values cached for a year.

      The two segments are fetched in parallel, and both must finish before the tool returns or fails, so no fetch or KV write is left running. Weekly requests (≤3 years) stay uncached. A failed KV write only costs a refetch.
13. Register all 7 tools (3 GML + 2 NCEI + 1 NSIDC + 1 Open-Meteo) in `registry.ts` as Claude tool definitions
14. Curl each upstream endpoint to confirm it responds, saving each response as the fixture the tests above run against (`worker/test/fixtures/`) — the same one-time check this step already called for, now captured to disk instead of thrown away:
    - `curl -o worker/test/fixtures/co2_mm_gl.csv https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_gl.csv` (one representative NOAA GML CSV — CH4/N2O share the same shape, no separate fixture needed)
    - `curl -o worker/test/fixtures/ncei_surface_temp.json <resolved Climate at a Glance URL>` — this curl doubles as the live check step 10 already calls for to pin down the exact path/query format
    - `curl -o worker/test/fixtures/ncei_ohc_700m.dat https://www.ncei.noaa.gov/data/oceans/woa/DATA_ANALYSIS/3M_HEAT_CONTENT/DATA/basin/yearly/h22-w0-700m.dat` (world file; the p0/a0/i0 basin files share the same layout with their own column names, no separate fixtures needed)
    - `curl -o worker/test/fixtures/nsidc_sea_ice.csv https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data/N_01_extent_v4.0.csv`
    - `curl -o worker/test/fixtures/open_meteo_geocode.json <a real Open-Meteo geocoding API response for one test city>` and `curl -o worker/test/fixtures/open_meteo_archive.json <a real Open-Meteo archive API response for that same city>` — two separate fixtures, since `openMeteo.ts` parses two different API shapes (geocoding, then archive) and each stage needs its own fixture, not one file covering both

### Phase 3 — Claude tool-use loop, rate limiting, and caching
15. Write `prompts.ts` — system prompt with anti-hallucination rules (see Section 7)
16. Write `claude.ts` — agentic loop: send → check for tool calls → execute → repeat → final response. When a round has more than one `tool_use` block, execute the handlers **concurrently** (`Promise.all` over an async map, each call wrapped in its own try/catch so one failure yields an `is_error` result rather than rejecting the batch) — the calls are independent, and all results go back in one `tool_result` message keyed by `tool_use_id` regardless of order, so serial execution just sums the upstream latencies against the R4 budget for no benefit. For `type: "chart"` responses, resolve each dataset's `sourceToolCallId` against the matching `tool_result` already in the conversation and inject the real data points before returning the envelope (see Section 4) — Claude never generates the data array itself. The Anthropic API call must never set `temperature`, `top_p`, or `top_k`: on `claude-sonnet-5`, non-default values for these return a 400 error on every request. Do not add `temperature: 0` as a JSON-determinism reflex — that habit is from older models and breaks this one. Determinism is steered through the system prompt (Section 7), which already enforces the JSON envelope.
    **Round cap:** the loop runs at most `MAX_ROUNDS` Claude round-trips — **7** (raised from 5 on 2026-09-03). Step 25 smoke testing showed Sonnet 5 occasionally emits a stray/hallucinated `tool_use` (e.g. a nonexistent chart-rendering tool — see Section 7 rule 9); the loop absorbs each as an `is_error` `tool_result` and recovers, but the stray call still consumes a round. 7 gives headroom before a legitimate multi-tool question runs out of rounds. Exceeding the cap logs `{class: "unhandled"}` and returns the R2 fallback text envelope.
    **Prompt caching:** mark two `cache_control: {type: "ephemeral"}` breakpoints per request — the last system block (covers tools + system) and the last message of each round (covers the conversation including large tool results) — and log each round's `usage` fields. See Section 8.5 for the sizing rationale, minimum-prefix caveat, and verification plan. Keep tool ordering deterministic (registry order), or the cache silently never hits.
    **Tool-failure handling:** the Phase 2 tool handlers throw on upstream failure (fetch error, unparseable CSV, invalid tool input) — deliberately; the loop, not the handlers, owns failure *policy* (whether to retry, how to surface it to Claude). But the failure *class* is a fact known only at the throw site, so each handler throws a `ToolError` (`worker/src/tools/errors.ts`) that carries its `toolErrorClass` explicitly — the loop classifies by `error instanceof ToolError` + the field, never by pattern-matching the message string (that scheme silently reclassified any reworded validation message and mislabelled hallucinated tool names as upstream drift). Wrap each handler call in try/catch and return the error message to Claude as a `tool_result` with `is_error: true` (the Anthropic protocol's error channel) rather than crashing the request. Claude then answers per Section 7's "if no tool returned data, say so plainly" rule — a normal `type: "text"` answer telling the user the data couldn't be retrieved, with no numbers from training knowledge. The handlers' error messages stay descriptive (e.g. "NOAA GML fetch failed: 503") so Claude can tailor that answer. Every handler's upstream call goes through the shared `fetchOk` / `fetchJson` helpers in `tools/errors.ts` — `fetchOk` raises `tool_fetch_failed` (with the status) on a non-OK response, `fetchJson` also converts a `SyntaxError` from an HTTP-200-but-not-JSON body into `tool_parse_failed`. An unwrapped `response.json()` would otherwise reach the loop as a non-`ToolError` and be misfiled as `unhandled` rather than the drift class. A non-`ToolError` exception escaping a handler (a genuine bug) logs as `unhandled`. Anything that escapes the loop itself is caught at the `/ask` handler's top level and becomes the R2 fallback/5xx JSON error, which the iOS app maps to a typed `APIError` (step 36).
    **Structured error logging:** every catch point above also emits a `console.error` with a structured object — `{class, tool?, upstreamStatus?, message}` where `class` is one of `tool_fetch_failed` / `tool_parse_failed` / `tool_input_invalid` / `unknown_tool` / `claude_malformed_json` / `chart_injection_mismatch` / `claude_timeout` / `kv_cache_failed` / `unhandled`. `kv_cache_failed` covers a failed KV read or write, or a corrupt or invalid entry, in a cache: the Open-Meteo city cache (R12), and answer-cache entries that fail validation (R2). It never fails the answer, only costs a refetch, but it's logged because it's the early sign that KV's daily write budget (R4) has run out. The logger lives in `src/log.ts` so tool modules can use it without an import cycle through `claude.ts`. `tool_fetch_failed` covers every way an upstream can be *unavailable*: a non-OK status, a rejected `fetch()` (DNS, connection reset, TLS), a timeout, or the body read dying mid-stream. A network failure must never escape as a native exception and get filed as `unhandled` (Codex review, 2026-09-23). `observability.enabled` is already on in `wrangler.jsonc`, so these land in Workers Logs (dashboard-viewable, free tier) with no extra infrastructure. This is the *production* detection mechanism for the upstream drift the fixture tests only catch when re-run — an NSIDC v4→v5 bump shows up as a spike of `tool_parse_failed` logs instead of weeks of silent "couldn't retrieve data" answers. `unknown_tool` (Claude called a tool name not in the registry — see Section 7 rule 9) is deliberately its own class so those hallucinations never inflate the `tool_parse_failed` drift signal. Never log the user's question text or IP in error logs — the failure class + tool name + upstream status carry the diagnosis; user content stays out. Built here, not deferred to Phase 6: the catch blocks are written in this step, so the log calls are born with them
17. Write chart-injection tests for `claude.ts` (Vitest): given a mocked Claude chart response containing a `sourceToolCallId` and a mocked structured `tool_result`, assert the Worker emits the correctly expanded `ChartResponse` with real `{x, y}` data points; include a case where the `sourceToolCallId` doesn't match any `tool_result` in the conversation — this should produce the R2 fallback text envelope, not a crash. Also test the tool-failure path from step 16: a handler that throws must produce an `is_error: true` `tool_result` sent back to Claude (assert the loop continues rather than crashing, and the error text is passed through), not an unhandled exception. Spy on `console.error` and assert the logged `class` for each `ToolError` category — `tool_input_invalid` (bad tool input), `tool_fetch_failed` (with `upstreamStatus`), `tool_parse_failed` (upstream shape wrong, including an invalid-JSON body), and `unknown_tool` (Claude names a tool not in the registry) — so a future reworded message or misfiled throw is caught by the suite, not in production. Also assert that two `tool_use` blocks in one round are dispatched concurrently (e.g. both handlers' `fetch` calls are in flight before either resolves) and that both results come back in a single `tool_result` message
18. Implement `rateLimit.ts` — KV counter keyed by IP, limit 5 requests/day; return 429 with a friendly JSON error if exceeded. Build the KV key from the current UTC date (e.g. `rl:{ip}:{YYYY-MM-DD}`) rather than an `expirationTtl`-based rolling window — "reset" then just means "a new day means a new key," which is trivially testable by injecting a date rather than simulating 24 hours of elapsed time. This is a launch prerequisite, not later polish — the Worker cannot go live without it, since `rateLimit.ts` and the KV binding already exist in the Phase 1 setup and the architecture diagram treats it as step 3 of every request that isn't served from cache
19. Write `rateLimit.ts` tests: the counter increments once per request, a 429 is returned once the daily limit is reached, and the counter resets for a new date-keyed day (assert against two different injected dates — no need to simulate real elapsed time)
20. Implement `cache.ts` — KV answer cache keyed by normalized question hash, **single-turn questions only**: skip the cache read/write whenever the request's `messages` array has more than one entry, since a hash of question text alone can't distinguish two different follow-ups with identical wording in different conversations (see R9). Also skip the cache write whenever Claude's response is `type: "refusal"` — refusals are cheap to regenerate (no tool calls were made), and caching them would waste one of the 1,000 daily KV writes (see R4) on every unique off-topic question someone happens to ask. Also skip the write for a **degraded answer** — `response.type === "text" && response.answer === FALLBACK_ANSWER` (exported from `claude.ts`) — so a transient failure isn't served from cache for up to 24h (see 8.2). TTL 1 hour for current-data questions, 24 hours for long-term trend questions
21. Write `cache.ts` tests: the single-turn-only rule (a multi-turn request skips both the cache read and the cache write), refusal responses are never written to the cache, a degraded answer (`FALLBACK_ANSWER`) is never written to the cache, and the TTL-selection logic picks the right TTL by phrasing: trend wording → 24h, everything else → 1h, **including a city question with trend wording** ("How has Portland changed since 1980?" → 24h), so the city case can't drift from 8.2 again
22. Implement `verifyClient(request)` in `index.ts` — checks the `X-App-Secret` header against the `APP_SECRET` Worker secret (`wrangler secret put APP_SECRET`, same mechanism as `ANTHROPIC_API_KEY`); returns 401 if missing or wrong. Compare with a constant-time equality check, not `===` — the latter short-circuits on the first mismatched character, a remote timing oracle on the secret (small, given the header is friction not access control, but free to close: a manual char-XOR loop, no crypto dependency). Kept as its own function, not inlined, so swapping in Apple App Attest later (see R10, and `app-attest-design.md` for the full design — App Attest is now a decided direction, not a hypothetical) has a clear seam. Built in here, not deferred to Phase 6 hardening — adding this check only after the Phase 5 TestFlight upload would mean the Worker starts rejecting every already-installed build the moment the check ships, since those builds never sent the header
23. Write `verifyClient` tests: a missing header returns 401, a wrong header returns 401 (both a wrong-length one and a same-length one, so the constant-time compare's body is exercised, not just its length check), and a correct header passes the request through to the next stage
24. Wire it all into the `POST /ask` handler in this order: `verifyClient(request)` first — reject immediately if the header is missing or wrong, before touching KV at all. Body validation (`parseMessages`) also rejects a history whose first turn isn't `role: "user"` — the Anthropic API 400s on that, and catching it here saves a rate-limit slot and a Claude round-trip (consecutive same-role turns are fine, though — the API merges them, so no alternation check). Then check cache (single-turn questions only) — on a hit, return immediately without touching the rate limiter or writing to KV; on a miss (or any multi-turn request), check rate limit → call Claude (enforcing the JSON response envelope in the system prompt) → write cache (same single-turn-only condition). Checking cache before rate limit means a fully cached answer never costs the user one of their 5 daily questions. The handler's top-level catch logs `{class: "unhandled", message}` per the step 16 logging scheme before returning the 5xx envelope
25. Smoke test end-to-end with `curl` — including one request with a missing/incorrect `X-App-Secret` to confirm it's rejected. Also confirm prompt caching is live (Section 8.5): ask one multi-round tool question and check the logged `usage` shows nonzero `cache_read_input_tokens` on rounds 2+. Also confirm error logging is live (step 16): trigger one failure deliberately (e.g. temporarily point a tool at a bad URL in `wrangler dev`, or ask a question that exercises a tool while offline) and verify the structured `console.error` appears in the logs with the right failure class — a logging scheme that's never been seen firing is not yet a detection mechanism

### Phase 4 — iOS app
**Entry gate:** the UI Design Spec (Section 5) must be complete — no TBD items — before any Phase 4 step begins. Same pattern as the Apple Developer account gate for Phase 5 (see R5): a prerequisite resolved ahead of time, not discovered mid-phase.

26. Create Xcode project: iOS, SwiftUI, Swift, iOS 16 minimum deployment target. Add SwiftLint (default ruleset, no custom rules) as a Run Script build phase so lint warnings appear in every build; it must also pass via `swiftlint lint` from the CLI, so it's checkable headless without opening Xcode
27. **Before creating the file**, confirm `.gitignore` already excludes `Secrets.xcconfig` — never create the file first and add the ignore rule after; a stray `git add -A` in the gap between the two is enough to commit a real secret to this public repo (see R11). Then create `Secrets.xcconfig` with an `APP_SECRET` value matching the Worker's secret from Phase 3, plus a committed `Secrets.xcconfig.example` placeholder (see Section 3, R3, R10); wire it into the target's `Info.plist` as `$(APP_SECRET)`. Built in here, not as later hardening, so the very first TestFlight build already sends the header the Worker expects
28. Build `ClimateAPIService.swift` — async/await URLSession POST, Codable response decoding against the `WorkerResponse` union (`text` / `refusal` / `chart`), attaches the `X-App-Secret` header (read via `Bundle.main.infoDictionary`) on every request
29. Build `Message.swift` and `ClimateChartData.swift` models
30. Build `ChatView.swift` — scrollable message thread, auto-scroll to latest
31. Build `MessageBubble.swift` — user message (right-aligned) and assistant message (left-aligned)
32. Build `InputBar.swift` — text field, send button, disabled state while loading
33. Add a loading indicator (skeleton or spinner) shown while awaiting the Worker's response — without it, the app freezes silently during the 3–8 second API call, which is unusable. Wire it into `ChatView`/`InputBar`, not deferred to hardening
34. Build `ClimateChartView.swift` — Swift Charts line and bar chart from decoded payload
35. Build a refusal view (either a dedicated `RefusalView.swift` or a variant rendered by `MessageBubble.swift`) for `type: "refusal"` responses, implementing the tappable example-question behavior specified in Section 4 (Response Envelope). Visual treatment — bubble style, spacing, button appearance — comes from the UI Design Spec (Section 5c), not invented here. Wire each button's tap action to submit that example question through the same send path as manually typed input
36. Build `ErrorView.swift` — inline error state shown in the chat thread, covering network failure, Worker 5xx, 429 rate-limit, and malformed-response cases, each with a distinct user-facing message. `ClimateAPIService.swift` surfaces these as a typed `APIError` enum so `ChatView` can switch on it
37. Build `ContentView.swift` — wires all views together
38. Set the Worker URL in `Config.swift`
39. Add an XCTest unit test target to the Xcode project, covering: Codable decoding of all three `WorkerResponse` envelope types (text/refusal/chart) from sample JSON fixtures; malformed/truncated JSON mapping to the correct `APIError` case; and `ClimateAPIService` tested against a stubbed `URLProtocol` — asserting the `X-App-Secret` header is attached on every request and that HTTP error codes (401, 429, 5xx) map to the right `APIError` cases. Runs headless via `xcodebuild test -scheme ClimateChat -destination 'platform=iOS Simulator,name=iPhone 16'` (see Section 1), so it's runnable from Claude Code without opening the Xcode GUI

### Phase 5 — Deploy and test
40. `wrangler deploy` — Worker live on `*.workers.dev`

    **Model-choice gate (per the deferral in 8.1).** Pick the model here, against the prices and models that actually exist at deploy time, and set the spend cap to match. `MODEL` in `claude.ts` is a single constant used in one place, and the tests reference the constant rather than the literal, so they follow automatically — but **the code change is one line and the validation is a smoke test.** If `MODEL` changes from `claude-sonnet-5`, re-run step 41 before trusting the deploy, because four things are tuned to the specific model and three of them fail *silently*:
    - **`MAX_TOKENS = 1536`** is sized for Sonnet 5's tokenizer (~30% more tokens per text than 4.6). Too small on another model and responses truncate mid-JSON — the R2 malformed-envelope failure, which surfaces as the fallback answer, not an error.
    - **Prompt-cache minimum prefix (8.5).** Our tools+system prefix is *borderline* against the ~2,048-token minimum. Drop below it and the `cache_control` marker is silently ignored: no error, no warning, costs simply rise. Step 25's check for nonzero `cache_read_input_tokens` on rounds 2+ is what catches this.
    - **Section 7 rule 9** exists because Sonnet 5 intermittently emitted a `tool_use` for a nonexistent chart tool. A different model may not need it, or may have different quirks entirely. Step 41's explicit chart question is the regression test.
    - **No `temperature`/`top_p`/`top_k`** — Sonnet 5 returns 400 on non-default values. Omitting them is safe on any model, so this one carries over unchanged.

    Step 41 already covers the first three: it asserts a `type:"chart"` envelope (rule 9), and its unanswerable-data question catches a model answering from training knowledge instead of tool data. That is the validation a model swap needs — it exists, it just has to be re-run rather than assumed.
41. Write `scripts/smoke-test.sh` — a curl-based script against the deployed Worker's live URL. Reads the app secret from an environment variable (`APP_SECRET=xxx ./scripts/smoke-test.sh`) and fails loudly with a usage message if it's unset — never hardcode the secret in the script itself. This script is committed to a public repo; a hardcoded secret would leak on the very first push, which is arguably a more likely leak path than the `Secrets.xcconfig` scenario R11 already covers, since it's easy to assume a "test script" is low-stakes. Covers, in this order:
    - One question per data source, **each with a unique nonce appended** so every run is a fresh cache miss regardless of whether the script (or a user) already asked the bare version that day — e.g. `"What will atmospheric CO2 levels be in 2040? [test-$(date +%s)]"` (NOAA GML — also the future-year check, see the bullet after the unanswerable-data question), `"Show me a line chart of how global temperature has changed since 1950 [test-$(date +%s)]"` (NOAA NCEI), `"Is Portland getting hotter? [test-$(date +%s)]"` (Open-Meteo city lookup), `"How much have oceans warmed? [test-$(date +%s)]"` (NOAA NCEI) — expect 200 with a valid envelope for each. The temperature question explicitly asks for a chart, so assert its envelope is `type: "chart"` specifically — this is the smoke-test case for Section 7 rule 9 (no chart-rendering tool): a regression there surfaces as burned rounds and a `type: "text"` or fallback answer instead of a chart. Claude answers the nonce'd question normally; the anti-hallucination system prompt (Section 7) has nothing to object to in a trailing tag it's not asked to cite. Each nonce'd question is a genuine cache miss, so it's also a genuine cache *write* — four extra KV writes per run, negligible against the 1,000/day budget (R4) — and since the next run's nonce differs, none of these entries is ever read again; harmless one-off pollution, not a growing footprint
    - An unanswerable-data question, nonce'd like the data-source questions above — e.g. `"What was the atmospheric CO2 level in the year 1650? [test-$(date +%s)]"`. No tool covers pre-industrial data (GML's records begin in the modern instrumental era). This is the fifth uncached Claude call of the run, still within the 5/day limit, so expect 200 with a `type: "text"` envelope whose answer states the data isn't available from the app's sources. The assertion is a negative one: the answer must NOT contain a confident numeric CO2 value — a simple grep for a ppm-like number pattern (e.g. 2-3 digits followed by an optional decimal) is sufficient; document in a script comment that this is a heuristic tripwire, not a proof. A response citing a specific figure like "280 ppm" means Claude answered from training knowledge — the exact silent regression this test exists to catch, violating Section 7's second rule
    - **The future-year check rides on the GML question above, not a separate call** (added 2026-09-24). The five uncached questions already use the whole daily limit, and the pizza asks depend on being the sixth and seventh calls. A separate future question would itself get a 429 and test nothing. The GML question is therefore phrased about 2040. It checks the *other* half of Section 7's second rule: the 1650 question catches answers from training knowledge, and this one catches **extrapolation** ("do not estimate, extrapolate…"). Only two tools accept a year, and both reject future years up front (step 10's ceiling and the city tool's). The other five (GML ×3, sea ice, ocean heat) take no year at all and always return the full observed record, so for them only the prompt rule stands between a trend line and a made-up 2040 figure. The assertion differs from the 1650 one: Claude may *legitimately* quote today's measured CO2 in ppm, so "no ppm number anywhere" would fail a correct answer. Instead, the script fails if any sentence contains both "2040" and a ppm-like number, as a heuristic tripwire, not a proof: phrasing like "by then ~470 ppm" slips past it. It also **always prints the answer** for a manual read. The pass condition is observed figures only, plus a plain statement that the app can't project future levels.
    - The off-topic refusal case ("Write me a haiku about pizza" — no nonce needed, refusals are never cached regardless per step 20) asked twice — now the sixth and seventh rate-limited calls of the run, so expect `429` on **both** asks rather than `200` with `type: "refusal"` on the first
    - **Both pizza asks are expected to return 429, not 200 — deterministically, on every run.** Without the nonces above, this assertion only holds the *first* time the script runs: on a second run within the cache TTLs (1–24h), the four data-source questions and the unanswerable-data question would already be cache hits and bypass the rate limiter entirely, leaving only two rate-limited requests (the pizza asks) instead of seven — the first pizza ask would return 200, not 429, and that 200 would look exactly like the caching bug this assertion is supposed to catch, with no way to tell the two apart. The nonces remove the ambiguity: every data-source question and the unanswerable-data question are fresh cache misses on every run, so all seven rate-limited calls happen every time — the sixth call (the first pizza ask) reliably trips the daily limit (8.3) no matter how recently the script last ran, and the seventh (second pizza ask) stays over the limit too. Treat both 429s as a deliberate assertion that 8.3 fires at the correct boundary, not a bug to work around — reordering or adding a bypass header would be more machinery for no real benefit. It also doubles as an indirect check that the first refusal wasn't cached (see step 21): with the nonces accounting for the data and unanswerable-data questions' cache state, an unexpected 200 on the first pizza ask can now only mean the refusal was wrongly cached
    - A request with a missing or wrong `X-App-Secret` — expect 401. This one doesn't consume rate-limit quota, since `verifyClient` runs before the rate limiter (see step 24)

    **Manual checks after the script (added 2026-09-24): Earth-only city lookups.** The city tool's description says the city must be a place on Earth: planets and moons are out, but same-named towns like Jupiter, Florida or Mercury, Nevada are explicitly fine. That's Claude's judgment steered by wording, so it can't be unit-tested (the unit test only guards the wording). The script's 5-question budget is already fully used, so ask these three by hand from the app or with curl, and read the answers:
    - *"What was the temperature change over the last two years in Jupiter, Florida?"*: expect real Open-Meteo figures for a place labeled **"Jupiter, Florida, US"**. A refusal or a "no data" answer means the Earth-only wording is being over-applied.
    - *"What is the annual temperature change over the last two years on Jupiter?"*: expect **no figures**, just a statement that the app only has Earth data (a `text` or `refusal` response both pass). Fail it if it quotes a temperature for the planet (training knowledge, violating Section 7 rules 1–2) or gives Jupiter, Florida's data as if it were the planet's.
    - *"How hot has it been in Jupiter lately?"* (bare name): either reading passes, but if it gives figures, the answer must name **Jupiter, Florida** so the user can see which Jupiter they got.

    Tool calls aren't logged by name (only failures are), so judge from the answer text: the city label is the evidence that the city tool ran. These are cache misses and count against the daily limit, so run them from a different network than the smoke test, or on another day, since the script uses up that IP's quota.

    Running this script consumes the full daily quota for whatever IP runs it — that's inherent to using the limit itself as the test, not a side effect to avoid. Run it deliberately (e.g., right after a deploy), and expect manual testing from the same IP/network to be rate-limited until the next day's window resets
42. Update `Config.swift` with the live Worker URL
43. Run on iOS Simulator to confirm the full request/response cycle renders correctly in the app itself: a text answer, a chart, a refusal with its tappable example questions, and at least one error state. Trigger the error state deliberately rather than waiting for one to occur naturally, then revert afterward: temporarily set a wrong value in `Secrets.xcconfig` and rebuild to exercise the 401 → `APIError` path end-to-end, and turn off your Mac's Wi-Fi to exercise the network-failure path — the Simulator shares the host machine's network, so its own in-Settings Airplane Mode toggle is cosmetic and won't actually cut connectivity. `scripts/smoke-test.sh` (step 41) already validated the Worker's behavior independently and has likely exhausted this IP's daily rate limit in the process — expect this pass to need a fresh day's quota, or a question already served from cache, to get past a text/chart response. The refusal check needs quota too: refusals are never cached (step 20), so unlike the text/chart checks there's no cached fallback for it — if the daily limit is already exhausted, this part of the check has to wait for a fresh window
44. Run on a real device via Xcode
45. Upload to TestFlight via Xcode Organizer → App Store Connect

### Phase 6 — Hardening
46. ~~Add a 5-second timeout on Worker fetch calls to NOAA GML, NOAA NCEI, NSIDC, and Open-Meteo~~ — **done early** (2026-09-23, Codex review). A stalled provider would otherwise recreate the silent hang this app exists to avoid. `FETCH_TIMEOUT_MS = 5000` in `tools/errors.ts` covers each data fetch, body read included, and reports a timeout as `tool_fetch_failed`, which Claude tells the user about under Section 7 rule 2. The Claude call is covered too. `LOOP_BUDGET_MS = 45000` in `claude.ts` is one deadline for the whole agent loop, passed to every `messages.create` as an abort signal. The SDK's default is a 10-minute timeout per attempt. 45s is under iOS URLSession's 60s default request timeout, so the app gets the Worker's answer instead of its own timeout. Running out of budget logs `claude_timeout` and returns the never-cached `FALLBACK_ANSWER`, the same result as running out of tool rounds. If Phase 4 sets a shorter URLSession timeout, lower `LOOP_BUDGET_MS` to match.
47. ~~Reject user inputs over 500 characters at the Worker before reaching Claude~~ — **done early** (2026-09-16, Codex review): a caller holding the extractable app secret (R10) could otherwise submit unbounded messages/history before any client existed to stop it, risking Anthropic context-window failures, a wasted rate-limit slot on a request that was always going to fail, and — with enough distinct IPs — a real denial-of-wallet path against the R4/8.1 backstops. Implemented in `index.ts`: `MAX_USER_MESSAGE_LENGTH` (500, this rule) applies only to `role: "user"` content, since a prior assistant turn echoed back in history can legitimately run longer; `MAX_MESSAGE_LENGTH` (8000) is a hard ceiling on any message regardless of role, closing the gap where a forged `assistant` turn in a direct API call would otherwise be unbounded; `MAX_MESSAGES` (21) pulls step 49 forward as a Worker-side check (see below); `MAX_BODY_LENGTH` (120,000 chars) rejects an oversized body with 413 before `JSON.parse` even runs, checked against the actual received text rather than a spoofable `Content-Length` header.
48. Refine the iOS error states built in Phase 4 (`ErrorView.swift`): add a retry affordance and cover remaining edge cases (e.g. request timeout vs. no connection) beyond the four core cases already handled
49. Cap conversation history at 10 exchanges before sending to Worker (iOS-side, still TBD in Phase 4) — **partially done early**: `index.ts`'s `MAX_MESSAGES` (21 = 10 exchanges + the new question) already enforces this Worker-side as of the same 2026-09-16 fix, since the Worker can't rely on a client-side trim it can't verify. The iOS-side trim is still worth building in Phase 4 so a long-running conversation degrades gracefully (a clear local trim) instead of eventually hitting the Worker's hard 400/413 reject.

---

## 7. Anti-Hallucination System Prompt Rules

These go in `prompts.ts` and are non-negotiable:

- "You may only cite specific numbers, statistics, or measurements if they came directly from a tool call in this conversation."
- "If no tool returned data relevant to the question, say so plainly. Do not estimate, extrapolate, or use training knowledge for factual climate figures."
- "Always cite the exact source name returned by the tool for every number you state: 'NOAA GML' for greenhouse gases (CO2/CH4/N2O), 'NOAA NCEI' for temperature and ocean heat content, 'NSIDC/NOAA Sea Ice Index' for sea ice, or 'Open-Meteo' for city weather. Never attribute NCEI or NSIDC data to NOAA GML — they are different sources."
- "If two sources return different values for the same measurement, present both and name each source."
- "Always return a valid JSON object matching one of the three response formats specified. Never return plain text or markdown."
- "For chart responses, identify each dataset by `sourceToolCallId` referencing the tool call that produced its data. Never re-type the data points yourself — the Worker injects the actual values from the tool result."
- "You are ClimateChat — you answer questions about climate change and climate data only. If a question is clearly unrelated to climate (has no plausible connection to climate change, weather trends, greenhouse gases, sea ice, or ocean warming), do not call any tools and do not answer it directly. Instead, return `{\"type\": \"refusal\", \"answer\": \"...\"}`, where the answer briefly explains that ClimateChat only answers climate questions and suggests one example climate question the user could ask instead. Skipping tool calls on refusals keeps them to a single, cheap round-trip."
- "Err toward answering. Laypeople phrase things loosely — climate-adjacent questions like 'why is Portland so hot today?' or 'will climate change affect my garden?' are in scope and should be answered normally, not refused. Reserve the refusal response for questions with no plausible connection to climate at all (e.g. general trivia, coding help, creative writing unrelated to climate, personal advice)."
- "There is no tool for creating, plotting, or rendering charts — the available tools only fetch data. To produce a chart, return the chart-format JSON directly; never call a tool to build one."

(Rule 9 added 2026-09-03 after step 25 smoke testing: Sonnet 5 intermittently emitted a `tool_use` block for a nonexistent chart-rendering tool on ordinary chart-worthy questions. The loop absorbs the unknown-tool error as an `is_error` result and recovers, but each stray call burns a round toward `MAX_ROUNDS`.)

These rules have no loud failure mode — a refactor that weakens or drops one produces no error, only silently degraded answers: no failed test, no 500, just Claude quietly citing training knowledge instead of tool data. Two guards exist against that: CLAUDE.md instructs build-time sessions to treat this section as verbatim-required in `prompts.ts`, and the smoke test (Phase 5, step 41) includes an unanswerable-data question that catches the most dangerous regression — answering from training knowledge — on every deploy. If a rule is added to or changed in this section, add or update a corresponding smoke-test case in the same commit.

---

## 8. Cost Controls

Seven layers, in order of impact:

### 8.1 Anthropic hard spend cap (do this first)
Set a monthly dollar limit in the Anthropic account dashboard before any live traffic. The API simply stops responding if you hit it — your Worker catches the error and returns a friendly "service temporarily unavailable" message to the iOS app. Set it to whatever you're comfortable losing in a worst-case month (e.g. $20–$50). Note: `claude-sonnet-5` carried introductory pricing ($2/$10 per MTok input/output) through 2026-08-31, rising to $3/$15 after that — a ~50% jump.

**DECISION 2026-09-23: model choice and its cost assumptions are deliberately deferred to immediately before ship (Phase 5), not settled now.** New Claude models and price changes land frequently enough that any figure pinned months ahead of launch is stale by the time it matters, and the code change is a single constant (`MODEL` in `claude.ts`, used in exactly one place). So the right moment to choose is when we deploy, against the prices and models that exist then.

What that defers, precisely: the spend-cap figure, the per-question cost estimates in this section, and the model string itself. The step-25 measurement (~$0.05–0.07 for a 4-round tool question, ~$0.001 for a refusal) was taken at introductory rates and should be treated as a lower bound, not a current number. Do not quote it as live cost.

**This deferral has a trigger, not a reminder:** see the model-change gate on step 40. Changing `MODEL` is one line of code but four coupled assumptions, three of which fail silently — do not treat it as a free swap.

### 8.2 Answer caching via Cloudflare KV
The single highest-leverage control for this app. Climate data changes slowly — "what is the current CO₂ level?" asked by 500 users today could cost one Anthropic call instead of 500. Cache key = normalized question hash, **single-turn questions only** (see R9 — a question-text hash can't safely represent a follow-up, since the same wording means different things depending on conversation history), and **never for `type: "refusal"` responses** — each unique off-topic question would otherwise waste a KV write on an answer that's cheap to regenerate anyway. Also **never cache a degraded answer** — the R2 `FALLBACK_ANSWER` text that `askClaude` returns when a round-cap is hit, Claude's final JSON is unparseable, or a chart `sourceToolCallId` doesn't resolve. Those are transient failures; writing one to KV serves the generic error string to every user asking that question for up to the TTL (24h for a trend phrasing), long after the underlying hiccup cleared. `cacheSet` recognizes it by identity against the exported `FALLBACK_ANSWER` constant. TTLs:
- **24 hours** — questions *phrased* as a long-term trend ("has temperature risen since 1900?", "how has Portland changed since 1980?"): the answer is the same every day
- **1 hour** — everything else, i.e. current-state questions ("what is the CO₂ level today?", "how hot has Portland been this week?")

**The TTL depends on the phrasing only, not on whether the question is about a city** (corrected 2026-09-24, Codex review). `selectTtl` matches trend wording (`since`, `changed`, `history`, `trend`, `over time`, `last N years`, …) in the question text. An earlier version of this section also listed "city-specific questions → always 1 hour", which the code never did. It can't reliably, because at cache time the Worker has only the question text. It shouldn't either:
- A city *trend* answer comes from annual data through the last complete year, so it's as stable as a global one and changes about once a year.
- The old rule's own reason ("Open-Meteo updates daily at most") argues for caching *longer*, not shorter.
- Current-state city questions already get 1 hour, because they carry no trend wording.

**Accepted weak spot:** trend wording about *recent* data ("how has CO₂ changed this year?", "how has Portland's temperature changed this month?") gets 24 hours, though the underlying monthly or weekly data can update daily. The worst case is an answer up to a day stale. That's bounded by the 24h ceiling, the same for city and global questions, and not worth a smarter classifier.

Implemented in `cache.ts`; wired into `index.ts` before the Claude call.

### 8.3 Per-user rate limiting
Free tier: 5 questions per user per day. The iOS app receives a clear "you've reached your daily limit" message on a 429 response. Checked only *after* the cache lookup misses (see Section 2) — a fully cached answer returns immediately and never counts against the user's daily quota or costs a write. Exercised end-to-end by `scripts/smoke-test.sh` (Phase 5, step 41), which deliberately trips this limit as one of its assertions rather than working around it — see that step for why.

**DECISION 2026-09-23 — the quota key moves from IP to App Attest `keyId` when App Attest ships.** For a mobile app, IP fails in both directions at once: carrier-grade NAT puts thousands of subscribers behind one address, so they collectively share five questions a day with no way to tell why they are throttled; meanwhile the same user walking from wifi to cellular gets a fresh IP and a fresh quota. It is simultaneously too coarse for legitimate users and trivially cycled by anyone who wants more. That is the wrong identity, not a badly tuned one.

`keyId` is one identity per app install on real Apple hardware, stable across network changes and attestation-backed so it cannot be forged without a device. Two further benefits come free because the counter moves into the per-device Durable Object that App Attest already creates:

- **It removes a KV write per request.** A cache miss costs two writes today (rate-limit counter + cache set); afterwards it costs one. Given R4's 1,000 writes/day is this app's binding constraint, that roughly doubles real capacity.
- **It becomes atomic.** The DO already performs an accept-and-advance inside `blockConcurrencyWhile()` for the App Attest replay counter (see `app-attest-design.md` §7 pitfall 6). Incrementing the daily counter in that same guarded transaction costs nothing extra and closes the documented non-atomic race in `rateLimit.ts` — currently accepted as "worst case, a 6th question."

Accepted trade-off: reinstalling the app mints a new key and therefore a fresh quota. Per-IP has the same bypass and it is *easier* (switch networks or use a VPN, versus a reinstall), and the damage is bounded by the hard spend cap (8.1) like every other abuse path. If it ever becomes real, Apple's attestation receipt supports a server-to-server fraud metric counting attested keys per device — that is the escalation path, not something to build up front.

**Enrollment stays per-IP.** `/attest/challenge` and `/attest/register` are pre-authentication — IP is the only identity that exists at that point. See `app-attest-design.md` §5a; the two schemes coexist by design, not as a compromise.

**Transition:** this cannot ship before App Attest, since it depends on `keyId` existing. While `X-App-Secret` is still active and no client sends assertions, rate limiting stays per-IP in `rateLimit.ts` exactly as it is today. Build the per-key counter into the Durable Object as part of the App Attest work, run both until cutover, then retire the IP counter alongside the shared secret.

### 8.4 Token limits
Set `max_tokens: 1536` in the Anthropic API call. This is sufficient *because* chart responses carry only metadata (title, labels, a `sourceToolCallId` per dataset, explanation) — the Worker injects the actual data points after Claude responds (see Section 4). Without that split, a single 140-year annual series (~140 `{x, y}` pairs) already exceeds 800 tokens before any labels or explanation, causing Claude's response to truncate mid-JSON — exactly the malformed-response failure mode R2 warns about. Reject user inputs over 500 characters at the Worker before the request reaches Claude — implemented in `index.ts` per Phase 6 step 47 (done early). Note: `claude-sonnet-5` uses a different tokenizer than `claude-sonnet-4-6` — the same text can run roughly 1.0–1.35x the token count — so a budget sized against 4.6-tokenizer intuition risks truncating an equivalent response on Sonnet 5, and truncation mid-JSON is exactly the R2 failure mode above. 1536 restores the old effective headroom; sanity-check against real responses during Phase 3 smoke testing (step 25) and tighten later if actual usage comes in well under budget.

### 8.5 Anthropic prompt caching inside the tool-use loop
Each round of the Phase 3 agentic loop re-sends the entire conversation so far as input — system prompt, all 7 tool definitions, and every prior tool_use/tool_result. Anthropic prompt caching cuts the re-read cost: cached input reads bill at ~0.1× the normal rate (writes at 1.25×, so caching pays for itself after one reuse). Implementation in `claude.ts` (step 16) uses **two `cache_control: {type: "ephemeral"}` breakpoints**:
- One on the last system-prompt block — covers tools + system (they render first, in that order). This prefix is *borderline* against the model's minimum cacheable-prefix size (~2,048 tokens for the Sonnet 4.6 generation; Sonnet 5's exact figure unverified — its ~1.3× tokenizer helps clear it). If it falls short, the marker is silently ignored: no error, no charge, no benefit — harmless either way.
- One on the last message of each round — covers the growing conversation *including tool results*, which is where the real token mass is (a single fetched data series is 1,000–2,000 tokens re-sent on every subsequent round). By round 2 this prefix is far above any minimum, and loop rounds run seconds apart — well inside the cache's 5-minute TTL.

Verification is empirical, not assumed: `claude.ts` logs each round's `usage` fields, and the Phase 3 smoke test (step 25) checks that `cache_read_input_tokens` is nonzero on rounds 2+ of a multi-round tool question. Zero reads mean the prefix fell short of the minimum or something is invalidating it (e.g. non-deterministic tool ordering) — investigate, don't ignore. Known accepted edge: a single-round request (refusal or no-tool answer) whose prefix does cache pays the 1.25× write premium with no read — negligible.

### 8.6 Scope enforcement (defense in depth, not a hard backstop)
Restricting Claude to climate topics (Section 7) is itself a cost control — it keeps ClimateChat from being usable as a free general-purpose Claude frontend, which would burn through the Anthropic spend cap far faster than climate questions ever would, and would do it under the guise of a legitimate-looking app. This is prompt-based, though, not an enforced boundary: a sufficiently motivated user can likely find phrasing that talks Claude past it. The rate limit (8.3) and the hard spend cap (8.1) remain the actual backstops that can't be argued around — scope enforcement sits on top of them as defense in depth, not a replacement for either.

One deliberate trade-off: a refusal still consumes one of the user's 5 daily questions, since only cache hits bypass the rate limiter (8.3) and refusals are never cached (8.2) — every unique off-topic question is an uncached round-trip to Claude. This is by design: without it, spamming distinct off-topic questions would be a free way around the rate limit entirely. The cost is that a confused legitimate user can burn part of their daily quota on refusals before landing on a question ClimateChat will actually answer.

### 8.7 Future: tiered access via Apple IAP
If the app grows:
- **Free tier:** 5 questions/day
- **Pro tier** (Apple in-app purchase): unlimited questions
- IAP revenue offsets Anthropic costs; Apple takes 15–30%

---

## 9. Risks and Decision Points

### R1 — Four active data-source modules in Phase 2
Global-scale data is split across three separate NOAA/NSIDC sources, not one: NOAA GML (greenhouse gases only — CO2, CH4, N2O), NOAA NCEI (surface temperature anomaly, ocean heat content), and NSIDC (Arctic sea ice extent). GML's API does not carry temperature, sea ice, or ocean heat data — attributing those to GML would violate the anti-hallucination citation rule in Section 7. Open-Meteo handles city-level historical weather. All four files (`noaaGml.ts`, `noaaNcei.ts`, `seaIceIndex.ts`, `openMeteo.ts`) must be fully implemented in Phase 2 — none is a stub.

### R2 — JSON envelope reliability
Getting Claude to return valid JSON on every response — including edge cases and errors — requires careful prompt engineering and a validation layer in the Worker. Plan for iteration. The Worker should catch malformed responses and return a fallback `{"type":"text","answer":"..."}` rather than crashing. **Any** output that isn't a valid envelope gets the generic `FALLBACK_ANSWER`. That includes plain prose and prose wrapped around JSON. The Worker never passes Claude's raw text through (Codex review, 2026-09-23). Output that broke rule 5 can't be trusted to have followed the other Section 7 rules: it may be an off-topic answer that skipped the refusal envelope. It would also be cacheable, while the fallback never is (8.2). Don't reintroduce a "prose is still an answer" or "extract the JSON from the prose" salvage path. A model that breaks rule 5 regularly shows up as `claude_malformed_json` in the logs and should be fixed in the prompt. **Runtime validation (Codex review, 2026-09-23):** `src/validate.ts`'s `isWorkerResponse` is the one strict check on anything sent to iOS. It requires:
- a non-empty answer, title, explanation and dataset label
- a line or bar chart type
- at least one dataset, each with at least one point
- finite numbers only (`JSON.stringify(NaN)` is `null`, which the iOS Codable structs can't decode)

Axis labels only need to be strings. It runs in two places:
- on Claude's result, after chart data is inserted (`parseEnvelope`), where a failure becomes `FALLBACK_ANSWER`
- on every answer-cache read (`cacheGet`), where a failing entry (older schema, bad deploy, manual edit, corrupt JSON) is treated as a miss and logged as `kv_cache_failed`

Bad cache entries are **not deleted**: a delete would spend a KV write (R4), and the `cacheSet` after the miss overwrites the same key anyway.

### R3 — iOS app cannot hold the Anthropic API key
Confirmed: the Cloudflare Worker holds the `ANTHROPIC_API_KEY`. The iOS app only knows the Worker's URL. Do not store the Anthropic key in the Xcode project, `Config.swift`, or any file that touches version control, gitignored or not — it should never be compiled into the app binary at all. This is a stricter, higher-stakes rule than the R10 app-secret header: that value is *expected* to live inside the compiled iOS app (it has to, to be sent on every request) and is friction against casual scraping, not real access control. See R10 for how and where that value is stored — the two secrets are not interchangeable and this rule does not apply to it.

### R4 — Cloudflare Worker free tier
100,000 requests/day, ~10ms CPU time (wall-clock unlimited). A tool-use loop with 2–3 Claude round-trips will take 3–8 seconds wall-clock — well within limits. CPU usage is minimal (mostly network I/O waiting). Cloudflare KV is included in the free tier (1GB storage, 100K reads/day, **1,000 writes/day**) — but the write limit, not the 100K request limit, is the actual daily ceiling. Every request writes to KV at least once (the rate-limit counter increment in `rateLimit.ts`), and every cache miss adds a second write (the cache set in `cache.ts`). That puts real daily capacity at roughly **500–1,000 total requests across all users** — closer to 500 on a cold cache, closer to 1,000 once it's warm — not the 100K Worker request quota this section might otherwise suggest. That's almost certainly fine for a TestFlight-scale rollout, but it's the constraint to watch if usage grows.

**This improves when App Attest ships.** Per the 8.3 decision, the rate-limit counter moves out of KV into the per-device Durable Object, so a cache miss drops from two KV writes to one (the cache set) and a cache hit stays at zero. Real daily capacity roughly doubles, and the remaining write is the one that buys the most — caching is the highest-leverage cost control in this plan (8.2). The Durable Objects escape hatch noted here is therefore the path being taken, just arriving via App Attest rather than as a standalone fix.

**Open issue (found 2026-09-23, not yet fixed): running out of the KV write budget takes the whole app down, not just the caches.** Only the Open-Meteo city cache treats a failed KV write as survivable: it logs `kv_cache_failed` and still answers. The two request-path writes don't:
- `rateLimit.ts`'s counter `put` throws, so every uncached request returns 500 before Claude is called.
- `cache.ts`'s `cacheSet` has no try/catch either, so an answer Claude has already produced (and been paid for, with the user's daily question used) comes back as a 500.

So once the 1,000 daily writes are used up, the app is effectively down until the budget resets at 00:00 UTC. The Open-Meteo city cache adds up to two writes per city per day on top. Decide before any wider release:
- **Answer cache:** make `cacheSet` treat a failed write like the city cache does (log it and still return the answer). This is clearly right.
- **Rate limiter:** decide whether a failed counter write should fail open (serve the question, uncounted) or fail closed (refuse, as today). Fail-open means an attacker who exhausts the write budget also switches off rate limiting; the spend cap (8.1) would then be the only limit.

App Attest's move of the counter into the Durable Object removes the rate-limiter part of this.

### R5 — TestFlight requires Apple Developer account
You need a paid Apple Developer account ($99/yr) to upload to TestFlight, even for internal testing. **Activation takes 24–48 hours after signup** — don't wait until Phase 5 to start this, or it becomes a surprise blocker right when you're ready to ship. Start the signup at developer.apple.com during Phase 1 (see Phase 1, step 8); it doesn't block any earlier work.

### R6 — Swift Charts data volume
Swift Charts handles thousands of points fine in a line chart, but passing 140+ years of monthly temperature data (1,680 points) could cause rendering lag on older devices. If needed, the Worker can downsample to annual averages before returning.

### R7 — Streaming
Non-streaming for v1 (simpler). The iOS app shows a loading indicator until the full response arrives. Streaming can be added later (URLSession supports it; the Worker Anthropic SDK supports it).

### R8 — Open-Meteo free tier is non-commercial only
Open-Meteo's free tier explicitly prohibits commercial use. If ClimateChat ever includes paid features, a subscription, ads, or is sold, a commercial Open-Meteo plan is required (pricing starts at ~€400/yr as of 2024). **Action required before any monetization:** switch to the paid API tier and update the Worker's Open-Meteo base URL. A paid tier does **not** make Open-Meteo unlimited. It removes the per-minute, per-hour and per-day caps but keeps a monthly quota, counted with the same weighting. See R12.

### R9 — Cache is scoped to single-turn questions only
The cache key is a hash of the question text alone, which is only safe when there's no conversation history to disambiguate it. Once history is included, two different follow-ups with identical wording — "how much has it risen?" asked about CO2 in one conversation, about sea ice in another — would hash identically and serve the wrong cached answer to one of them. Fix: only read/write the cache when the incoming `messages` array is a single entry (no prior turns); any multi-turn follow-up always goes straight to Claude. This is the simpler and safer of two options — the alternative, folding conversation history into the cache key, effectively kills the hit rate since history is rarely identical across users, and answer caching is the single highest-leverage cost control in this plan (Section 8.2).

### R10 — A discoverable Worker URL invites freeloading
Anyone who finds the Worker URL could try to call it directly and spend the app's Claude quota — from a browser page, a script, or a tool like Postman. Rate limiting (8.3) caps the damage per IP but doesn't stop it. Two layers address this, cheapest first:
- **No CORS headers (Phase 1, step 6):** the Worker never sets `Access-Control-Allow-Origin`. This is a deliberate choice, not a "tighten later" placeholder — the iOS app is a native URLSession client, not a browser, so CORS (a browser-only mechanism) never applied to it in the first place. Omitting CORS entirely means a naive browser-JS abuse attempt (someone pasting a `fetch()` call into a page or console) fails at the CORS preflight stage, before the request ever reaches the Worker. It does nothing against non-browser clients (curl, scripts, Postman) — that's what the next layer is for.
- **Shared secret header (Phase 3, step 22 — Worker; Phase 4, step 27 — iOS):** the iOS app sends a fixed header (e.g. `X-App-Secret`) that the Worker's `verifyClient(request)` checks before doing anything else. Built in from the start rather than added as later hardening — adding the check only after the Phase 5 TestFlight upload would mean the Worker starts rejecting every already-installed build the moment the check ships, since those builds never sent the header. Stored in a gitignored `Secrets.xcconfig` on the iOS side (see Section 3), never hardcoded directly in committed Swift source — this repo is public, so a value sitting in `Config.swift` would be trivially copyable by anyone browsing GitHub, which would defeat this mitigation before it did anything. Raises the bar against casual scraping and random discovery, though the value still ends up compiled into the shipped app binary and can be extracted by a determined attacker via reverse engineering — not a real access-control boundary, just friction. Distinct from R3: unlike the Anthropic key, this value is *supposed* to live inside the app. Covers what the CORS omission above can't: any client, browser or not, that lacks the app secret.
- **Apple App Attest — DECIDED 2026-09-21, design complete, implementation pending. See `app-attest-design.md`.** Cryptographically proves a request came from a genuine instance of the app running on real Apple hardware, not a browser or script. This was previously logged here as "future, if abuse actually shows up"; that framing is superseded. What moved it: a code review found that the Worker accepts arbitrary client-supplied `role: "assistant"` history and feeds it straight to Claude with no provenance check, which a shared secret fundamentally cannot fix — the header says nothing about whether the request *body* is legitimate. App Attest closes that and subsumes this freeloading/scraping concern at the same time.
  - Alternatives considered and rejected: a chained HMAC over the transcript (bespoke crypto we'd own, and a collage weakness unless the whole ordered transcript is chained) and a server-side conversation store keyed by an opaque ID (reverses the stateless design in Section 2 and burns a KV write per turn against the R4 budget).
  - The "one-function swap" note below turned out to be optimistic: `verifyClient` stays a single seam, but App Attest also needs device enrollment endpoints, a per-device Durable Object, X.509 chain validation and CBOR decoding. Scope is in `app-attest-design.md` §4.
  - **Accepted residual risk — jailbroken devices.** App Attest proves the request came from the genuine app, not that its assistant history was written by the Worker. On a jailbroken device the attested app can be hooked to rewrite history before signing, and nothing practical prevents that. Accepted, not mitigated: the impact is self-only (multi-turn is never cached), forged turns can't inject tool data, and cost stays bounded by the per-keyId rate limit and spend cap. See `app-attest-design.md` §1a.
  - **Do not re-open this decision without reading that document** — it records five empirically verified findings, ten pitfalls, and two documented errors in Apple's own published validation guide.
  - `verifyClient(request)` remains its own function so the cutover has a clear seam. `X-App-Secret` stays active until App Attest is proven end-to-end on a physical device (App Attest does not work in the Simulator — see step 43).

### R11 — A secret committed to this public repo must be rotated, not just removed
Bots scan public GitHub for exposed secrets continuously — typically within minutes of a push, not hours or days. If `ANTHROPIC_API_KEY`, `APP_SECRET`/`Secrets.xcconfig`, or any other secret is ever accidentally committed (a stray `git add -A`, a copy-pasted `.env` value, creating `Secrets.xcconfig` before the `.gitignore` rule is in place — see Phase 4, step 27), treat the exposed value as **compromised the instant it lands**, no matter how quickly it's caught. Deleting the file, amending the commit, or force-pushing a rewritten history does **not** undo the exposure: the value already went out over the wire the moment `git push` finished, and both automated scraper caches and anyone who cloned or forked the repo in that window retain it independent of what the repo's history looks like afterward. The only fix that actually matters is to **rotate the secret** — generate a new `ANTHROPIC_API_KEY` in the Anthropic dashboard and update the Worker secret (`wrangler secret put`), or generate a new `APP_SECRET` and update it in both the Worker and `Secrets.xcconfig` — before doing anything else. Clean up the git history afterward for hygiene if it matters to you, but the rotation, not the cleanup, is what actually closes the exposure.

### R12 — Open-Meteo's quota counts data volume, not requests
Open-Meteo counts every **2 weeks of data for one location as one API call**. The free tier allows 600 calls per minute, 5,000 per hour and 10,000 per day. So the size of the date range decides the cost, not the number of requests. Checked against open-meteo.com/en/pricing on 2026-09-23:
- a default annual city query (1960 through last year) ≈ **1,720 calls**
- annual from 1940 ≈ 2,240
- monthly over 30 years ≈ 780
- weekly over 2 years ≈ 52

About **five default annual city questions use up the free tier's whole day**. After that, every city question fails with 429 (logged as `tool_fetch_failed`, and Claude says the data couldn't be retrieved) until the next day. A test burst of five 86-year requests on 2026-09-23 got 429s immediately. A single 86-year request made on its own succeeded in 2.15s, so one heavy request isn't rejected by itself.

**Paid plans don't remove this (see R8).** Standard is 1M calls/month and Professional 5M/month, and the weighting appears to apply to them too. That's about 580 default annual city questions a month on Standard.

**Unconfirmed:** neither Open-Meteo's pricing page nor its terms say whether the free limits are applied per IP address. If they are, Cloudflare Workers' shared outbound IPs could mean other customers' traffic counts against ours. Watch for 429s from `get_city_temperature_history` in Workers Logs.

**Mitigation (built 2026-09-23):** the per-city series cache in `openMeteo.ts` (step 12). A city's first question fetches its full record once, about 2,240 calls and about 2.3s. After that, the history segment is fetched at most once a year, and the recent segment, about 52 calls, at most once a day. So a known city costs about 52 calls a day at most, however many questions are asked about it. The remaining exposure is many *different* new cities in one day: about four exhaust the free tier. That's acceptable for a small TestFlight group. Reassess before any wider release.

**Future option — NOAA NCEI city time series for US cities.** NOAA NCEI's Climate at a Glance publishes city-level time series. That would take US city questions off Open-Meteo entirely: NOAA data has no quota, and NCEI is already one of our sources. The user tried NCEI's own charting page on 2026-09-23: a US city from 1935 to today came back quickly, as monthly data. Not yet checked:
- which cities are covered
- the API endpoint and response format
- whether it offers annual aggregates or only monthly
- what to cite: it must be "NOAA NCEI", never "NOAA GML", per Section 7

Open-Meteo would stay the source for non-US cities. Consider this before any wider release, or if 429s show up in practice.

### R13 — An ambiguous city name silently resolves to the most populous match
`get_city_temperature_history` geocodes the city name with Open-Meteo's geocoding API and uses the top result. That API is built on **GeoNames** data (geonames.org: compiled from NGA, USGS GNIS, Ordnance Survey, Canadian GeoBase and user wiki edits; CC BY 4.0), and the top match is the most populous. Checked 2026-09-24, plain **"Portland"** returns Portland, Oregon (pop. ~653k) ahead of Portland, Maine (~67k), Portland, Indiana and Portland, Texas. So a user in Maine who types just "Portland" got Oregon's temperatures, and the result was labeled only "Portland, US", so neither Claude nor the user could see which state was used.

A qualified query works: "Portland, Maine" and "Portland, ME" resolve correctly. The **comma is required**: "Portland Maine" returns nothing. There was also a second route to the wrong city: the tool's `city` description gave the bare example `"Portland"`, nudging Claude to drop a state the user *had* typed.

**Status: fixed 2026-09-24 (options A+B).**
- **A. The place is always named, and qualifiers are passed through.** The result description labels the place with its region, from the geocoder's `admin1` field: "Portland, Oregon, US" (`placeLabel`). The `city` parameter tells Claude to include any state, region or country the user gave, after a comma. The tool description tells Claude to say which place it used.
- **A2. A missing comma is repaired automatically.** Users (and Claude) often write "Portland Oregon" or "Kansas City Missouri", which the geocoder rejects. When a multi-word query without a comma finds nothing, the tool retries with a comma before the last word, then before the last two (`qualifierRetries`), and stops at the first match: "Portland Oregon" → "Portland, Oregon", "Portland OR" → "Portland, OR", "Kansas City Missouri" → "Kansas City, Missouri", "Springfield North Carolina" → "Springfield, North Carolina". That's at most 2 extra geocoding calls (~0.7s and 1 quota call each), and only on a miss. Wrong splits don't match, because the qualifier must equal a region or country exactly: "Kansas, City Missouri" and "Springfield North, Carolina" return nothing (checked live). The query that matched counts as qualified, so no "also matches" list is added. If every split fails (e.g. a typo, "Portlnd Oregon"), the error names the query as sent and tells Claude to put any state or country after a comma.
- **B. Ambiguous names list the alternatives.** The geocoder is asked for 10 matches (still one call). When the query has no comma, other places with *exactly* the same name are returned as `alsoMatches` (`ambiguousAlternatives`), and the tool description tells Claude to answer for the place used, name the alternatives, and suggest asking again with the state. A place qualifies if it's at least **5% of the top match's population, or at least 100,000** people. At most **3** are listed, largest first. The percentage keeps Paris, Texas (25k vs. 2.1M) out of every Paris answer. The 100k floor keeps London, Ontario (422k, under 5% of London, England). Exact-name matching drops the geocoder's prefix and alternate-name hits ("Portland Point", "Paris 15 Vaugirard", and Blue Island, IL for "Portland"). Results checked live: Portland → +Maine; London → +Ontario; Birmingham → +Alabama; Columbus → +Georgia, Indiana; Kansas City → +Kansas; Paris and Seattle → none.
- **Deliberately not built:**
  - **Asking the user before answering.** Every ambiguous question would cost an extra exchange, which uses a daily question because follow-ups aren't cached, even though most users mean the largest place.
  - **Preferring the user's own state based on IP location** (Cloudflare `request.cf.region`). It's unreliable on mobile networks and VPNs, makes answers depend on where you are, and would be a privacy-label change.
  - **An iOS city picker.** That's a Phase 4 UI decision for Section 5.

  Revisit these only if real use shows the wrong city keeps getting through.

The city cache (R12) is keyed on the geocoded coordinates, so it's unaffected: each place's data is cached as that place's.

**Attribution (action for Phase 4).** Both data layers here are **CC BY 4.0**, which requires credit: Open-Meteo's weather data (its terms), and GeoNames' place data (geonames.org, surfaced through Open-Meteo's geocoder). Per-answer citations name "Open-Meteo" (Section 7), but that doesn't credit GeoNames. The iOS app needs an About or Credits screen crediting both, with licence links. Add this to the UI Design Spec (Section 5) when it's written.

---

## 10. Decisions

1. **Data sources:** NOAA GML (greenhouse gases), NOAA NCEI (surface temperature, ocean heat content), NSIDC (Arctic sea ice), and Open-Meteo (city-level data) — all four active in Phase 2. global-warming.org dropped — no ToS, no SLA, no contact path.
2. **Apple Developer account:** Sign up at developer.apple.com during **Phase 1**, not Phase 5 (see Phase 1, step 8). Activation takes 24–48 hours and doesn't block Phases 1–4, but starting late turns it into a surprise delay right before the TestFlight upload.
3. **App name:** **ClimateChat**
