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
| **Claude model** | `claude-sonnet-5` | Current-generation Sonnet — best balance of reasoning quality and cost/speed for tool-use loops. `claude-sonnet-4-6` (previous gen) is still active but not the current model; verify the exact string at docs.anthropic.com before coding starts, since model IDs shift over time |
| **Greenhouse gas data** | NOAA GML (`gml.noaa.gov/ccgg`) | CO2/CH4/N2O only — official US government source, flat CSV files, no key required. GML does **not** publish temperature, sea ice, or ocean heat data |
| **Temperature + ocean data** | NOAA NCEI (`ncei.noaa.gov`) | Surface temperature anomaly (NOAAGlobalTemp) and ocean heat content — a different NOAA division from GML, with its own API |
| **Sea ice data** | NSIDC (`noaadata.apps.nsidc.org`) | Arctic sea ice extent — distributed jointly with NOAA under the Sea Ice Index, not part of GML |
| **City-level data source** | Open-Meteo | City-level historical weather; free tier for non-commercial use only (see R8) |
| **Distribution** | TestFlight | Requires Apple Developer account ($99/yr); no App Review needed for internal testing |
| **Xcode version** | Xcode 26.3 | Installed version; targets iOS 16+ deployment |
| **Worker tests** | Vitest + `@cloudflare/vitest-pool-workers` | Runs tests inside the actual Workers runtime with local KV simulation, so rate limiting and caching are tested realistically rather than against mocks |
| **iOS tests** | XCTest unit target | Runs headless via Xcode (Cmd+U) or `xcodebuild test -scheme ClimateChat -destination 'platform=iOS Simulator,name=iPhone 16'` from the terminal, so tests are runnable from Claude Code without the Xcode GUI |

**What's intentionally excluded:**
- No CloudKit/iCloud sync — conversation history lives in memory for the session only (v1)
- No Siri/App Intents, no WidgetKit — out of scope for v1
- No third-party networking library (URLSession is sufficient for a simple JSON API client)
- No third-party charting library — Swift Charts handles everything needed
- No XCUITest UI automation in v1 (slow, brittle, lowest value for a chat UI; revisit post-launch if warranted)

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
│     └─ Tool-use loop (≤5 rounds)           │
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
│   ├── wrangler.toml
│   ├── package.json
│   ├── tsconfig.json                 # Targets the Workers runtime via @cloudflare/workers-types
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

**Refusal answer** (off-topic questions — see Section 6):
```json
{
  "type": "refusal",
  "answer": "ClimateChat only answers questions about climate change and climate data. Try asking something like: \"How has global CO2 changed since 1960?\""
}
```
Same shape as the plain text answer — `type` and `answer` only. No tool call was made (see Section 6), so there's nothing to inject and no second construction stage, unlike the chart flow below. `RefusalResponse` is defined in `types.ts` alongside `TextResponse` and the chart types, and included in the `WorkerResponse` union the iOS app decodes against.

The iOS app renders this distinctly from a normal text answer (see Phase 4) and shows 2–3 tappable example climate questions below the refusal message — a small fixed set baked into the iOS view (e.g. "What's the current CO2 level?", "Is Arctic sea ice shrinking?", "How much have oceans warmed?"), not parsed out of Claude's `answer` text. Tapping one submits that question through the same send path as manually typed input, giving a fast way back into a climate question after a refusal.

**Chart answer — two-stage construction:**

Claude's own JSON output names *which* dataset to chart; it never re-types the data points themselves. A 140-year annual series alone is ~140 `{x, y}` pairs — well over budget for a token-limited response, and asking Claude to retype numbers it already fetched via tool call is also a needless hallucination risk. Claude returns:

```json
{
  "type": "chart",
  "chartType": "line",
  "title": "Global Temperature Anomaly (1880–2024)",
  "xLabel": "Year",
  "yLabel": "°C anomaly vs. 1951–1980 average",
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
  "yLabel": "°C anomaly vs. 1951–1980 average",
  "datasets": [
    {
      "label": "Temperature anomaly",
      "data": [{ "x": 1880, "y": -0.16 }, { "x": 1881, "y": -0.08 }]
    }
  ],
  "explanation": "The chart shows Earth has warmed approximately 1.2°C since the late 19th century."
}
```

Only this expanded shape ever reaches the iOS app — `sourceToolCallId` is an internal Claude↔Worker contract, not part of the public API. If a series needs downsampling for chart rendering (see R6), the Worker does that here too, after resolving the raw data and before injecting it into the envelope.

Both shapes are typed in `types.ts`: a `ClaudeChartResponse` (the metadata-only shape Claude is allowed to emit) and the public `ChartResponse` (post-injection, with `data` arrays) are distinct types, so a build accidentally sending the Claude-facing shape to the iOS app fails to compile rather than failing at runtime.

Swift `Codable` structs will decode the expanded shape directly. `ClimateChartData.swift` owns the models; `ClimateChartView.swift` renders them using Swift Charts.

---

## 5. Sequence of Build Steps

**Testing philosophy:** Tests here map to specific documented risks, not a coverage percentage. R2 (JSON envelope reliability) is covered by the chart-injection and Codable-decoding tests; R9 (cache correctness) by the cache tests; R10 (client verification) by the `verifyClient` tests. The fixture-based parser tests in Phase 2 exist because the NCEI and NSIDC endpoints are explicitly flagged as unstable there — a small, sharp set of tests aimed at real failure modes, not exhaustive boilerplate or a coverage target.

Worker tests run via `npx vitest run` (or `npx vitest` in watch mode during development); iOS tests run via `xcodebuild test -scheme ClimateChat -destination 'platform=iOS Simulator,name=iPhone 16'` (or Cmd+U in Xcode). Both suites must pass before the Phase 5 `wrangler deploy` step — a regression caught after deploy is a live regression.

### Phase 1 — Worker skeleton
1. `npm create cloudflare@latest worker` in `worker/`, selecting the **TypeScript** "Hello World" Worker template when prompted; confirm Wrangler works. Add `vitest` and `@cloudflare/vitest-pool-workers` as dev dependencies and configure `vitest.config.ts` per the pool-workers setup (see Section 1) — tests then run inside the actual Workers runtime, with local KV simulation, rather than against mocks. Write one trivial passing test (e.g. `expect(1 + 1).toBe(2)`) and confirm it runs via `npx vitest run` — this only proves the harness itself works; real tests get added alongside each subsequent implementation step
2. Add `@anthropic-ai/sdk` and `@cloudflare/workers-types` as dependencies (the SDK ships its own types; `@cloudflare/workers-types` covers the Workers runtime globals like `Fetcher` and `KVNamespace`). Confirm the template's `tsconfig.json` includes it. Create `src/types.ts` defining the response envelope types referenced in Section 4 (`TextResponse`, `RefusalResponse`, `ChartResponse`, `ClaudeChartResponse`, and the `WorkerResponse` union)
3. Set `ANTHROPIC_API_KEY` as a Worker secret via `wrangler secret put`
4. Create a KV namespace via Cloudflare dashboard, bind it in `wrangler.toml` as `CLIMATE_KV`
5. Set a monthly hard spend cap in the Anthropic account dashboard (e.g. $20) before any live traffic
6. Do **not** add CORS headers — the iOS app is a native URLSession client, not a browser, so CORS (a browser-only mechanism) never applied to it. Omitting CORS entirely, rather than setting a permissive `Access-Control-Allow-Origin: *`, is the deliberate choice: it makes a naive browser-JS abuse attempt (e.g. someone pasting a `fetch()` call into a page or console) fail at the CORS preflight stage, before the request even reaches the Worker (see R10)
7. Stub `POST /ask` that echoes the body — smoke test with `curl`
8. Start the Apple Developer Program signup at developer.apple.com **now**, in parallel with everything else. Activation takes 24–48 hours and doesn't block Phases 1–4, but it must be done well before Phase 5 (see R5) — don't wait until Phase 5 to start it.

### Phase 2 — Data tools
Every tool handler below must return structured JSON as its `tool_result` — parsed `{x, y}` data points plus metadata (units, source) — never the raw CSV/response body verbatim. This is what makes the Section 4 chart injection work: `claude.ts` pulls data straight out of the `tool_result` by `sourceToolCallId` without re-parsing it, and Claude itself reads structured JSON far more reliably than raw CSV text.

Every tool handler is also paired with fixture-based parser tests as it's written — no live network calls in the test suite. Download one real copy of each upstream response into `worker/test/fixtures/` (a NOAA GML CSV, an NCEI temperature JSON response, an NCEI ocean heat content CSV, an NSIDC sea ice CSV, and an Open-Meteo JSON response), and test each parser against its fixture rather than the live URL. This serves two purposes: it verifies the parsing logic now, and later, when an upstream format changes (e.g. NSIDC's hardcoded `v4.0` becoming `v5.0` — see step 11), re-downloading just that one fixture and re-running the tests pinpoints exactly which parser broke, instead of debugging a live failure blind.

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
   - `get_surface_temperature(start_year, end_year, scale: "monthly" | "annual")` — global land+ocean temperature anomaly (°C vs. 20th-century average), served via the Climate at a Glance API: `https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/land_ocean/{month-scale}/{month}/{start}-{end}.json`
     - ⚠️ The exact path/query format isn't exposed in NCEI's static docs — confirm it with a live request against `ncei.noaa.gov/support/access-data-service-api-user-documentation` before writing the parser
     - cite as **"NOAA NCEI (NOAAGlobalTemp)"**
   - `get_ocean_heat_content(basin: "world" | "pacific" | "atlantic" | "indian", depth: "700m" | "2000m")` — ocean heat content anomaly (10²² J)
     - `https://www.ncei.noaa.gov/data/oceans/woa/DATA_ANALYSIS/3M_HEAT_CONTENT/DATA/basin/onemonth/ohc_levitus_climdash_monthly.csv` (0-700m) or `ohc2000m_levitus_climdash_monthly.csv` (0-2000m)
     - ⚠️ Same caveat as the surface-temperature endpoint above — confirm this URL still resolves and the CSV column layout hasn't changed with a live request before writing the parser. NCEI file paths move without notice; this one is no more stable than the Climate at a Glance endpoint just because it looks like a static file
     - cite as **"NOAA NCEI"**
11. Implement `seaIceIndex.ts`:
    - `get_arctic_sea_ice(month: 1-12)` — monthly Arctic sea ice extent (million km²)
      - `https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data/N_{MM}_extent_v4.0.csv` (MM = zero-padded month)
      - ⚠️ Same caveat as the two NCEI endpoints above — confirm this URL still resolves and the CSV column layout hasn't changed with a live request before writing the parser. The hardcoded `v4.0` in the path is a versioned file name, not a stable API contract; NSIDC has bumped this version before (v1 → v2 → v3 → v4) and will again
      - cite as **"NSIDC/NOAA Sea Ice Index"**
12. Implement `openMeteo.ts` — city-level historical weather:
    - `get_city_temperature_history` — annual average temperature for a named city (geocoded via Open-Meteo's geocoding endpoint, then the archive API)
13. Register all 7 tools (3 GML + 2 NCEI + 1 NSIDC + 1 Open-Meteo) in `registry.ts` as Claude tool definitions
14. Test each with `curl` to confirm the upstream APIs respond

### Phase 3 — Claude tool-use loop, rate limiting, and caching
15. Write `prompts.ts` — system prompt with anti-hallucination rules (see Section 6)
16. Write `claude.ts` — agentic loop: send → check for tool calls → execute → repeat → final response. For `type: "chart"` responses, resolve each dataset's `sourceToolCallId` against the matching `tool_result` already in the conversation and inject the real data points before returning the envelope (see Section 4) — Claude never generates the data array itself
17. Write chart-injection tests for `claude.ts` (Vitest): given a mocked Claude chart response containing a `sourceToolCallId` and a mocked structured `tool_result`, assert the Worker emits the correctly expanded `ChartResponse` with real `{x, y}` data points; include a case where the `sourceToolCallId` doesn't match any `tool_result` in the conversation — this should produce the R2 fallback text envelope, not a crash
18. Implement `rateLimit.ts` — KV counter keyed by IP, limit 5 requests/day; return 429 with a friendly JSON error if exceeded. This is a launch prerequisite, not later polish — the Worker cannot go live without it, since `rateLimit.ts` and the KV binding already exist in the Phase 1 setup and the architecture diagram treats it as step 3 of every request that isn't served from cache
19. Write `rateLimit.ts` tests: the counter increments once per request, a 429 is returned once the daily limit is reached, and the counter resets after the daily window elapses
20. Implement `cache.ts` — KV answer cache keyed by normalized question hash, **single-turn questions only**: skip the cache read/write whenever the request's `messages` array has more than one entry, since a hash of question text alone can't distinguish two different follow-ups with identical wording in different conversations (see R9). Also skip the cache write whenever Claude's response is `type: "refusal"` — refusals are cheap to regenerate (no tool calls were made), and caching them would waste one of the 1,000 daily KV writes (see R4) on every unique off-topic question someone happens to ask. TTL 1 hour for current-data questions, 24 hours for long-term trend questions
21. Write `cache.ts` tests: the single-turn-only rule (a multi-turn request skips both the cache read and the cache write), refusal responses are never written to the cache, and the TTL-selection logic picks the right TTL for current-state vs. long-term-trend vs. city-specific questions
22. Implement `verifyClient(request)` in `index.ts` — checks the `X-App-Secret` header against the `APP_SECRET` Worker secret (`wrangler secret put APP_SECRET`, same mechanism as `ANTHROPIC_API_KEY`); returns 401 if missing or wrong. Kept as its own function, not inlined, so swapping in Apple App Attest later (see R10) is a one-function change. Built in here, not deferred to Phase 6 hardening — adding this check only after the Phase 5 TestFlight upload would mean the Worker starts rejecting every already-installed build the moment the check ships, since those builds never sent the header
23. Write `verifyClient` tests: a missing header returns 401, a wrong header returns 401, and a correct header passes the request through to the next stage
24. Wire it all into the `POST /ask` handler in this order: `verifyClient(request)` first — reject immediately if the header is missing or wrong, before touching KV at all; then check cache (single-turn questions only) — on a hit, return immediately without touching the rate limiter or writing to KV; on a miss (or any multi-turn request), check rate limit → call Claude (enforcing the JSON response envelope in the system prompt) → write cache (same single-turn-only condition). Checking cache before rate limit means a fully cached answer never costs the user one of their 5 daily questions
25. Smoke test end-to-end with `curl` — including one request with a missing/incorrect `X-App-Secret` to confirm it's rejected

### Phase 4 — iOS app
26. Create Xcode project: iOS, SwiftUI, Swift, iOS 16 minimum deployment target
27. **Before creating the file**, confirm `.gitignore` already excludes `Secrets.xcconfig` — never create the file first and add the ignore rule after; a stray `git add -A` in the gap between the two is enough to commit a real secret to this public repo (see R11). Then create `Secrets.xcconfig` with an `APP_SECRET` value matching the Worker's secret from Phase 3, plus a committed `Secrets.xcconfig.example` placeholder (see Section 3, R3, R10); wire it into the target's `Info.plist` as `$(APP_SECRET)`. Built in here, not as later hardening, so the very first TestFlight build already sends the header the Worker expects
28. Build `ClimateAPIService.swift` — async/await URLSession POST, Codable response decoding against the `WorkerResponse` union (`text` / `refusal` / `chart`), attaches the `X-App-Secret` header (read via `Bundle.main.infoDictionary`) on every request
29. Build `Message.swift` and `ClimateChartData.swift` models
30. Build `ChatView.swift` — scrollable message thread, auto-scroll to latest
31. Build `MessageBubble.swift` — user message (right-aligned) and assistant message (left-aligned)
32. Build `InputBar.swift` — text field, send button, disabled state while loading
33. Add a loading indicator (skeleton or spinner) shown while awaiting the Worker's response — without it, the app freezes silently during the 3–8 second API call, which is unusable. Wire it into `ChatView`/`InputBar`, not deferred to hardening
34. Build `ClimateChartView.swift` — Swift Charts line and bar chart from decoded payload
35. Build a refusal view (either a dedicated `RefusalView.swift` or a variant rendered by `MessageBubble.swift`) for `type: "refusal"` responses — visually distinct from a normal text answer (e.g. a muted/secondary bubble style), with 2–3 tappable example-question buttons below the message (see Section 4). Wire each button's tap action to submit that example question through the same send path as manually typed input
36. Build `ErrorView.swift` — inline error state shown in the chat thread, covering network failure, Worker 5xx, 429 rate-limit, and malformed-response cases, each with a distinct user-facing message. `ClimateAPIService.swift` surfaces these as a typed `APIError` enum so `ChatView` can switch on it
37. Build `ContentView.swift` — wires all views together
38. Set the Worker URL in `Config.swift`
39. Add an XCTest unit test target to the Xcode project, covering: Codable decoding of all three `WorkerResponse` envelope types (text/refusal/chart) from sample JSON fixtures; malformed/truncated JSON mapping to the correct `APIError` case; and `ClimateAPIService` tested against a stubbed `URLProtocol` — asserting the `X-App-Secret` header is attached on every request and that HTTP error codes (401, 429, 5xx) map to the right `APIError` cases. Runs headless via `xcodebuild test -scheme ClimateChat -destination 'platform=iOS Simulator,name=iPhone 16'` (see Section 1), so it's runnable from Claude Code without opening the Xcode GUI

### Phase 5 — Deploy and test
40. `wrangler deploy` — Worker live on `*.workers.dev`
41. Write `scripts/smoke-test.sh` — a curl-based script against the deployed Worker's live URL, covering: one question per data source ("What is the current atmospheric CO2 level?" — NOAA GML; "Show me how global temperature has changed since 1950" — NOAA NCEI; "Is Portland getting hotter?" — Open-Meteo city lookup; "How much have oceans warmed?" — NOAA NCEI); the off-topic refusal case ("Write me a haiku about pizza") asked twice, with `wrangler tail` confirming both requests reach Claude rather than the second being served from cache (see step 20); and a request with a missing/wrong `X-App-Secret` confirming it's rejected with 401. Run this after every deploy — a repeatable script instead of a one-time manual ritual retyped by hand each time
42. Update `Config.swift` with the live Worker URL
43. Run on iOS Simulator to confirm the full request/response cycle renders correctly in the app itself: a text answer, a chart, a refusal with its tappable example questions, and at least one error state. `scripts/smoke-test.sh` (previous step) already validated the Worker's behavior independently, so this pass is about the iOS rendering layer, not re-checking Worker logic
44. Run on a real device via Xcode
45. Upload to TestFlight via Xcode Organizer → App Store Connect

### Phase 6 — Hardening
46. Add a 5-second timeout on Worker fetch calls to NOAA GML, NOAA NCEI, NSIDC, and Open-Meteo
47. Reject user inputs over 500 characters at the Worker before reaching Claude
48. Refine the iOS error states built in Phase 4 (`ErrorView.swift`): add a retry affordance and cover remaining edge cases (e.g. request timeout vs. no connection) beyond the four core cases already handled
49. Cap conversation history at 10 exchanges before sending to Worker

---

## 6. Anti-Hallucination System Prompt Rules

These go in `prompts.ts` and are non-negotiable:

- "You may only cite specific numbers, statistics, or measurements if they came directly from a tool call in this conversation."
- "If no tool returned data relevant to the question, say so plainly. Do not estimate, extrapolate, or use training knowledge for factual climate figures."
- "Always cite the exact source name returned by the tool for every number you state: 'NOAA GML' for greenhouse gases (CO2/CH4/N2O), 'NOAA NCEI' for temperature and ocean heat content, 'NSIDC/NOAA Sea Ice Index' for sea ice, or 'Open-Meteo' for city weather. Never attribute NCEI or NSIDC data to NOAA GML — they are different sources."
- "If two sources return different values for the same measurement, present both and name each source."
- "Always return a valid JSON object matching one of the three response formats specified. Never return plain text or markdown."
- "For chart responses, identify each dataset by `sourceToolCallId` referencing the tool call that produced its data. Never re-type the data points yourself — the Worker injects the actual values from the tool result."
- "You are ClimateChat — you answer questions about climate change and climate data only. If a question is clearly unrelated to climate (has no plausible connection to climate change, weather trends, greenhouse gases, sea ice, or ocean warming), do not call any tools and do not answer it directly. Instead, return `{\"type\": \"refusal\", \"answer\": \"...\"}`, where the answer briefly explains that ClimateChat only answers climate questions and suggests one example climate question the user could ask instead. Skipping tool calls on refusals keeps them to a single, cheap round-trip."
- "Err toward answering. Laypeople phrase things loosely — climate-adjacent questions like 'why is Portland so hot today?' or 'will climate change affect my garden?' are in scope and should be answered normally, not refused. Reserve the refusal response for questions with no plausible connection to climate at all (e.g. general trivia, coding help, creative writing unrelated to climate, personal advice)."

---

## 7. Cost Controls

Six layers, in order of impact:

### 7.1 Anthropic hard spend cap (do this first)
Set a monthly dollar limit in the Anthropic account dashboard before any live traffic. The API simply stops responding if you hit it — your Worker catches the error and returns a friendly "service temporarily unavailable" message to the iOS app. Set it to whatever you're comfortable losing in a worst-case month (e.g. $20–$50). Note: `claude-sonnet-5` carries introductory pricing ($2/$10 per MTok input/output) through 2026-08-31; it rises to $3/$15 per MTok after that — a ~50% jump. Revisit the spend cap figure and any per-question cost assumptions around that date rather than assuming today's math holds indefinitely.

### 7.2 Answer caching via Cloudflare KV
The single highest-leverage control for this app. Climate data changes slowly — "what is the current CO₂ level?" asked by 500 users today could cost one Anthropic call instead of 500. Cache key = normalized question hash, **single-turn questions only** (see R9 — a question-text hash can't safely represent a follow-up, since the same wording means different things depending on conversation history), and **never for `type: "refusal"` responses** — each unique off-topic question would otherwise waste a KV write on an answer that's cheap to regenerate anyway. TTLs:
- **1 hour** — current-state questions (CO₂ today, current sea ice extent)
- **24 hours** — long-term trend questions ("has temperature risen since 1900?" — the answer is the same every day)
- **1 hour** — city-specific questions (Open-Meteo data updates daily at most)

Implemented in `cache.ts`; wired into `index.ts` before the Claude call.

### 7.3 Per-user rate limiting via Cloudflare KV
Track requests per IP address in KV counters. Free tier: 5 questions per user per day. The iOS app receives a clear "you've reached your daily limit" message on a 429 response. Implemented in `rateLimit.ts`. Checked only *after* the cache lookup misses (see Section 2) — a fully cached answer returns immediately and never counts against the user's daily quota or costs a KV write.

### 7.4 Token limits
Set `max_tokens: 1024` in the Anthropic API call. This is sufficient *because* chart responses carry only metadata (title, labels, a `sourceToolCallId` per dataset, explanation) — the Worker injects the actual data points after Claude responds (see Section 4). Without that split, a single 140-year annual series (~140 `{x, y}` pairs) already exceeds 800 tokens before any labels or explanation, causing Claude's response to truncate mid-JSON — exactly the malformed-response failure mode R2 warns about. Reject user inputs over 500 characters at the Worker before the request reaches Claude. Note: `claude-sonnet-5` uses a different tokenizer than `claude-sonnet-4-6` — the same text can run roughly 1.0–1.35x the token count — so per-question cost estimates and the 1024 figure above should be sanity-checked against real usage rather than assumptions carried over from an older model.

### 7.5 Scope enforcement (defense in depth, not a hard backstop)
Restricting Claude to climate topics (Section 6) is itself a cost control — it keeps ClimateChat from being usable as a free general-purpose Claude frontend, which would burn through the Anthropic spend cap far faster than climate questions ever would, and would do it under the guise of a legitimate-looking app. This is prompt-based, though, not an enforced boundary: a sufficiently motivated user can likely find phrasing that talks Claude past it. The rate limit (7.3) and the hard spend cap (7.1) remain the actual backstops that can't be argued around — scope enforcement sits on top of them as defense in depth, not a replacement for either.

One deliberate trade-off: a refusal still consumes one of the user's 5 daily questions, since only cache hits bypass the rate limiter (7.3) and refusals are never cached (7.2) — every unique off-topic question is an uncached round-trip to Claude. This is by design: without it, spamming distinct off-topic questions would be a free way around the rate limit entirely. The cost is that a confused legitimate user can burn part of their daily quota on refusals before landing on a question ClimateChat will actually answer.

### 7.6 Future: tiered access via Apple IAP
If the app grows:
- **Free tier:** 5 questions/day
- **Pro tier** (Apple in-app purchase): unlimited questions
- IAP revenue offsets Anthropic costs; Apple takes 15–30%

---

## 8. Risks and Decision Points

### R1 — Four active data-source modules in Phase 2
Global-scale data is split across three separate NOAA/NSIDC sources, not one: NOAA GML (greenhouse gases only — CO2, CH4, N2O), NOAA NCEI (surface temperature anomaly, ocean heat content), and NSIDC (Arctic sea ice extent). GML's API does not carry temperature, sea ice, or ocean heat data — attributing those to GML would violate the anti-hallucination citation rule in Section 6. Open-Meteo handles city-level historical weather. All four files (`noaaGml.ts`, `noaaNcei.ts`, `seaIceIndex.ts`, `openMeteo.ts`) must be fully implemented in Phase 2 — none is a stub.

### R2 — JSON envelope reliability
Getting Claude to return valid JSON on every response — including edge cases and errors — requires careful prompt engineering and a validation layer in the Worker. Plan for iteration. The Worker should catch malformed responses and return a fallback `{"type":"text","answer":"..."}` rather than crashing.

### R3 — iOS app cannot hold the Anthropic API key
Confirmed: the Cloudflare Worker holds the `ANTHROPIC_API_KEY`. The iOS app only knows the Worker's URL. Do not store the Anthropic key in the Xcode project, `Config.swift`, or any file that touches version control, gitignored or not — it should never be compiled into the app binary at all. This is a stricter, higher-stakes rule than the R10 app-secret header: that value is *expected* to live inside the compiled iOS app (it has to, to be sent on every request) and is friction against casual scraping, not real access control. See R10 for how and where that value is stored — the two secrets are not interchangeable and this rule does not apply to it.

### R4 — Cloudflare Worker free tier
100,000 requests/day, ~10ms CPU time (wall-clock unlimited). A tool-use loop with 2–3 Claude round-trips will take 3–8 seconds wall-clock — well within limits. CPU usage is minimal (mostly network I/O waiting). Cloudflare KV is included in the free tier (1GB storage, 100K reads/day, **1,000 writes/day**) — but the write limit, not the 100K request limit, is the actual daily ceiling. Every request writes to KV at least once (the rate-limit counter increment in `rateLimit.ts`), and every cache miss adds a second write (the cache set in `cache.ts`). That puts real daily capacity at roughly **500–1,000 total requests across all users** — closer to 500 on a cold cache, closer to 1,000 once it's warm — not the 100K Worker request quota this section might otherwise suggest. That's almost certainly fine for a TestFlight-scale rollout, but it's the constraint to watch if usage grows. If it becomes binding, Cloudflare's dedicated Rate Limiting binding (doesn't consume the KV write quota) or Durable Objects (per-key coordination without it) are the eventual fix.

### R5 — TestFlight requires Apple Developer account
You need a paid Apple Developer account ($99/yr) to upload to TestFlight, even for internal testing. **Activation takes 24–48 hours after signup** — don't wait until Phase 5 to start this, or it becomes a surprise blocker right when you're ready to ship. Start the signup at developer.apple.com during Phase 1 (see Phase 1, step 8); it doesn't block any earlier work.

### R6 — Swift Charts data volume
Swift Charts handles thousands of points fine in a line chart, but passing 140+ years of monthly temperature data (1,680 points) could cause rendering lag on older devices. If needed, the Worker can downsample to annual averages before returning.

### R7 — Streaming
Non-streaming for v1 (simpler). The iOS app shows a loading indicator until the full response arrives. Streaming can be added later (URLSession supports it; the Worker Anthropic SDK supports it).

### R8 — Open-Meteo free tier is non-commercial only
Open-Meteo's free tier explicitly prohibits commercial use. If ClimateChat ever includes paid features, a subscription, ads, or is sold, a commercial Open-Meteo plan is required (pricing starts at ~€400/yr as of 2024). **Action required before any monetization:** switch to the paid API tier and update the Worker's Open-Meteo base URL.

### R9 — Cache is scoped to single-turn questions only
The cache key is a hash of the question text alone, which is only safe when there's no conversation history to disambiguate it. Once history is included, two different follow-ups with identical wording — "how much has it risen?" asked about CO2 in one conversation, about sea ice in another — would hash identically and serve the wrong cached answer to one of them. Fix: only read/write the cache when the incoming `messages` array is a single entry (no prior turns); any multi-turn follow-up always goes straight to Claude. This is the simpler and safer of two options — the alternative, folding conversation history into the cache key, effectively kills the hit rate since history is rarely identical across users, and answer caching is the single highest-leverage cost control in this plan (Section 7.2).

### R10 — A discoverable Worker URL invites freeloading
Anyone who finds the Worker URL could try to call it directly and spend the app's Claude quota — from a browser page, a script, or a tool like Postman. Rate limiting (7.3) caps the damage per IP but doesn't stop it. Two layers address this, cheapest first:
- **No CORS headers (Phase 1, step 6):** the Worker never sets `Access-Control-Allow-Origin`. This is a deliberate choice, not a "tighten later" placeholder — the iOS app is a native URLSession client, not a browser, so CORS (a browser-only mechanism) never applied to it in the first place. Omitting CORS entirely means a naive browser-JS abuse attempt (someone pasting a `fetch()` call into a page or console) fails at the CORS preflight stage, before the request ever reaches the Worker. It does nothing against non-browser clients (curl, scripts, Postman) — that's what the next layer is for.
- **Shared secret header (Phase 3, step 22 — Worker; Phase 4, step 27 — iOS):** the iOS app sends a fixed header (e.g. `X-App-Secret`) that the Worker's `verifyClient(request)` checks before doing anything else. Built in from the start rather than added as later hardening — adding the check only after the Phase 5 TestFlight upload would mean the Worker starts rejecting every already-installed build the moment the check ships, since those builds never sent the header. Stored in a gitignored `Secrets.xcconfig` on the iOS side (see Section 3), never hardcoded directly in committed Swift source — this repo is public, so a value sitting in `Config.swift` would be trivially copyable by anyone browsing GitHub, which would defeat this mitigation before it did anything. Raises the bar against casual scraping and random discovery, though the value still ends up compiled into the shipped app binary and can be extracted by a determined attacker via reverse engineering — not a real access-control boundary, just friction. Distinct from R3: unlike the Anthropic key, this value is *supposed* to live inside the app. Covers what the CORS omission above can't: any client, browser or not, that lacks the app secret.
- **Apple App Attest (future, if abuse actually shows up):** cryptographically proves a request came from a genuine instance of the app running on real Apple hardware, not a browser or script. The correct long-term fix, but meaningfully more setup than this app needs at TestFlight scale — revisit only if the shared-secret header proves insufficient. `verifyClient(request)` is kept as its own function specifically so this swap is a one-function change, not a refactor.

### R11 — A secret committed to this public repo must be rotated, not just removed
Bots scan public GitHub for exposed secrets continuously — typically within minutes of a push, not hours or days. If `ANTHROPIC_API_KEY`, `APP_SECRET`/`Secrets.xcconfig`, or any other secret is ever accidentally committed (a stray `git add -A`, a copy-pasted `.env` value, creating `Secrets.xcconfig` before the `.gitignore` rule is in place — see Phase 4, step 27), treat the exposed value as **compromised the instant it lands**, no matter how quickly it's caught. Deleting the file, amending the commit, or force-pushing a rewritten history does **not** undo the exposure: the value already went out over the wire the moment `git push` finished, and both automated scraper caches and anyone who cloned or forked the repo in that window retain it independent of what the repo's history looks like afterward. The only fix that actually matters is to **rotate the secret** — generate a new `ANTHROPIC_API_KEY` in the Anthropic dashboard and update the Worker secret (`wrangler secret put`), or generate a new `APP_SECRET` and update it in both the Worker and `Secrets.xcconfig` — before doing anything else. Clean up the git history afterward for hygiene if it matters to you, but the rotation, not the cleanup, is what actually closes the exposure.

---

## 9. Decisions

1. **Data sources:** NOAA GML (greenhouse gases), NOAA NCEI (surface temperature, ocean heat content), NSIDC (Arctic sea ice), and Open-Meteo (city-level data) — all four active in Phase 2. global-warming.org dropped — no ToS, no SLA, no contact path.
2. **Apple Developer account:** Sign up at developer.apple.com during **Phase 1**, not Phase 5 (see Phase 1, step 8). Activation takes 24–48 hours and doesn't block Phases 1–4, but starting late turns it into a surprise delay right before the TestFlight upload.
3. **App name:** **ClimateChat**
