# ClimateChat — Project Plan

> Based on `initial-prompt.md`. Review and confirm before any code is written.
> Updated: iOS native app (Swift/SwiftUI) replaces the web frontend.

---

## 1. Recommended Tech Stack

| Layer | Choice | Justification |
|---|---|---|
| **iOS app** | Swift + SwiftUI (iOS 16+) | Native performance; iOS 16 is the Swift Charts floor and covers the vast majority of active devices |
| **Charts** | Swift Charts (Apple framework) | Native iOS charting, zero dependencies, first-class SwiftUI integration, introduced iOS 16 |
| **Backend runtime** | Cloudflare Worker (JS) | Free tier, holds the API key securely, stateless request handler |
| **Rate limiting + cache** | Cloudflare KV | Included in free tier; used for per-IP request counters and cached Claude responses |
| **AI SDK** | Anthropic SDK (`@anthropic-ai/sdk`) in the Worker | Tool use is first-class; the Worker does the Claude agentic loop |
| **Claude model** | `claude-sonnet-5` | Current-generation Sonnet — best balance of reasoning quality and cost/speed for tool-use loops. `claude-sonnet-4-6` (previous gen) is still active but not the current model; verify the exact string at docs.anthropic.com before coding starts, since model IDs shift over time |
| **Greenhouse gas data** | NOAA GML (`gml.noaa.gov/ccgg`) | CO2/CH4/N2O only — official US government source, flat CSV files, no key required. GML does **not** publish temperature, sea ice, or ocean heat data |
| **Temperature + ocean data** | NOAA NCEI (`ncei.noaa.gov`) | Surface temperature anomaly (NOAAGlobalTemp) and ocean heat content — a different NOAA division from GML, with its own API |
| **Sea ice data** | NSIDC (`noaadata.apps.nsidc.org`) | Arctic sea ice extent — distributed jointly with NOAA under the Sea Ice Index, not part of GML |
| **City-level data source** | Open-Meteo | City-level historical weather; free tier for non-commercial use only (see R8) |
| **Distribution** | TestFlight | Requires Apple Developer account ($99/yr); no App Review needed for internal testing |
| **Xcode version** | Xcode 26.3 | Installed version; targets iOS 16+ deployment |

**What's intentionally excluded:**
- No CloudKit/iCloud sync — conversation history lives in memory for the session only (v1)
- No Siri/App Intents, no WidgetKit — out of scope for v1
- No third-party networking library (URLSession is sufficient for a simple JSON API client)
- No third-party charting library — Swift Charts handles everything needed

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
│  1. Rate limit check → KV (IP counter)     │
│  2. Cache lookup    → KV (question hash)   │
│  3. Call Claude (Anthropic SDK)            │
│     └─ Tool-use loop (≤5 rounds)           │
│        └─ Fetch climate data               │
│  4. Cache write     → KV (with TTL)        │
│  5. Return structured JSON                 │
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
│       └── Config.swift                    # Worker base URL (one place to change)
│
├── worker/                          # Cloudflare Worker (unchanged architecture)
│   ├── wrangler.toml
│   ├── package.json
│   └── src/
│       ├── index.js                 # Entry point — CORS, routes POST /ask
│       ├── claude.js                # Anthropic SDK, tool-use loop
│       ├── prompts.js               # System prompt (anti-hallucination)
│       ├── rateLimit.js             # Per-IP KV counter (5 req/day free tier)
│       ├── cache.js                 # KV answer cache (get/set with TTL)
│       └── tools/
│           ├── registry.js          # Exports full tool list + dispatcher
│           ├── noaaGml.js           # 3 tools — greenhouse gases (CO2, CH4, N2O), gml.noaa.gov/ccgg
│           ├── noaaNcei.js          # 2 tools — surface temp anomaly + ocean heat content, ncei.noaa.gov
│           ├── seaIceIndex.js       # 1 tool — Arctic sea ice extent, NSIDC/NOAA Sea Ice Index
│           └── openMeteo.js         # City-level historical weather (active in Phase 2)
│
├── initial-prompt.md
└── project-plan.md
```

---

## 4. Response Envelope (Worker → iOS)

The Worker always returns one of two JSON shapes. The iOS app decodes whichever it receives:

**Plain text answer:**
```json
{
  "type": "text",
  "answer": "Global CO2 levels reached 424 ppm in May 2024, according to NOAA GML..."
}
```

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

Before returning the response to the iOS app, the Worker (in `claude.js`) resolves each `sourceToolCallId` against the matching `tool_result` already in the conversation, parses the raw data points out of that tool's output, and replaces `sourceToolCallId` with a `data` array in the outgoing envelope:

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

Swift `Codable` structs will decode the expanded shape directly. `ClimateChartData.swift` owns the models; `ClimateChartView.swift` renders them using Swift Charts.

---

## 5. Sequence of Build Steps

### Phase 1 — Worker skeleton
1. `npm create cloudflare@latest worker` in `worker/`, confirm Wrangler works
2. Add `@anthropic-ai/sdk` as a dependency
3. Set `ANTHROPIC_API_KEY` as a Worker secret via `wrangler secret put`
4. Create a KV namespace via Cloudflare dashboard, bind it in `wrangler.toml` as `CLIMATE_KV`
5. Set a monthly hard spend cap in the Anthropic account dashboard (e.g. $20) before any live traffic
6. Add CORS headers for any origin (iOS app doesn't send an `Origin` header, so this is permissive by default — tighten later if needed)
7. Stub `POST /ask` that echoes the body — smoke test with `curl`
8. Start the Apple Developer Program signup at developer.apple.com **now**, in parallel with everything else. Activation takes 24–48 hours and doesn't block Phases 1–4, but it must be done well before Phase 5 (see R5) — don't wait until Phase 5 to start it.

### Phase 2 — Data tools
9. Implement `noaaGml.js` — NOAA Global Monitoring Laboratory, greenhouse gases only. Flat CSV files, no API key, no query parameters (fetch the file, parse the CSV):
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
10. Implement `noaaNcei.js` — NOAA National Centers for Environmental Information. **Not GML** — a different agency division with its own API; do not cite this data as "NOAA GML":
   - `get_surface_temperature(start_year, end_year, scale: "monthly" | "annual")` — global land+ocean temperature anomaly (°C vs. 20th-century average), served via the Climate at a Glance API: `https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/land_ocean/{month-scale}/{month}/{start}-{end}.json`
     - ⚠️ The exact path/query format isn't exposed in NCEI's static docs — confirm it with a live request against `ncei.noaa.gov/support/access-data-service-api-user-documentation` before writing the parser
     - cite as **"NOAA NCEI (NOAAGlobalTemp)"**
   - `get_ocean_heat_content(basin: "world" | "pacific" | "atlantic" | "indian", depth: "700m" | "2000m")` — ocean heat content anomaly (10²² J)
     - `https://www.ncei.noaa.gov/data/oceans/woa/DATA_ANALYSIS/3M_HEAT_CONTENT/DATA/basin/onemonth/ohc_levitus_climdash_monthly.csv` (0-700m) or `ohc2000m_levitus_climdash_monthly.csv` (0-2000m)
     - cite as **"NOAA NCEI"**
11. Implement `seaIceIndex.js`:
    - `get_arctic_sea_ice(month: 1-12)` — monthly Arctic sea ice extent (million km²)
      - `https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data/N_{MM}_extent_v4.0.csv` (MM = zero-padded month)
      - cite as **"NSIDC/NOAA Sea Ice Index"**
12. Implement `openMeteo.js` — city-level historical weather:
    - `get_city_temperature_history` — annual average temperature for a named city (geocoded via Open-Meteo's geocoding endpoint, then the archive API)
13. Register all 7 tools (3 GML + 2 NCEI + 1 NSIDC + 1 Open-Meteo) in `registry.js` as Claude tool definitions
14. Test each with `curl` to confirm the upstream APIs respond

### Phase 3 — Claude tool-use loop, rate limiting, and caching
15. Write `prompts.js` — system prompt with anti-hallucination rules (see Section 6)
16. Write `claude.js` — agentic loop: send → check for tool calls → execute → repeat → final response. For `type: "chart"` responses, resolve each dataset's `sourceToolCallId` against the matching `tool_result` already in the conversation and inject the real data points before returning the envelope (see Section 4) — Claude never generates the data array itself
17. Implement `rateLimit.js` — KV counter keyed by IP, limit 5 requests/day; return 429 with a friendly JSON error if exceeded. This is a launch prerequisite, not later polish — the Worker cannot go live without it, since `rateLimit.js` and the KV binding already exist in the Phase 1 setup and the architecture diagram treats it as step 1 of every request
18. Implement `cache.js` — KV answer cache keyed by normalized question hash, **single-turn questions only**: skip the cache read/write whenever the request's `messages` array has more than one entry, since a hash of question text alone can't distinguish two different follow-ups with identical wording in different conversations (see R9). TTL 1 hour for current-data questions, 24 hours for long-term trend questions
19. Wire it all into the `POST /ask` handler: check rate limit → check cache (only when the request is a single-turn question) → call Claude (enforcing the JSON response envelope in the system prompt) → write cache (same single-turn-only condition)
20. Smoke test end-to-end with `curl`

### Phase 4 — iOS app
21. Create Xcode project: iOS, SwiftUI, Swift, iOS 16 minimum deployment target
22. Build `ClimateAPIService.swift` — async/await URLSession POST, Codable response decoding
23. Build `Message.swift` and `ClimateChartData.swift` models
24. Build `ChatView.swift` — scrollable message thread, auto-scroll to latest
25. Build `MessageBubble.swift` — user message (right-aligned) and assistant message (left-aligned)
26. Build `InputBar.swift` — text field, send button, disabled state while loading
27. Add a loading indicator (skeleton or spinner) shown while awaiting the Worker's response — without it, the app freezes silently during the 3–8 second API call, which is unusable. Wire it into `ChatView`/`InputBar`, not deferred to hardening
28. Build `ClimateChartView.swift` — Swift Charts line and bar chart from decoded payload
29. Build `ErrorView.swift` — inline error state shown in the chat thread, covering network failure, Worker 5xx, 429 rate-limit, and malformed-response cases, each with a distinct user-facing message. `ClimateAPIService.swift` surfaces these as a typed `APIError` enum so `ChatView` can switch on it
30. Build `ContentView.swift` — wires all views together
31. Set the Worker URL in `Config.swift`

### Phase 5 — Deploy and test
32. `wrangler deploy` — Worker live on `*.workers.dev`
33. Update `Config.swift` with the live Worker URL
34. Run on iOS Simulator — test with sample questions:
    - "What is the current atmospheric CO2 level?" (NOAA GML)
    - "Show me how global temperature has changed since 1950" (NOAA NCEI)
    - "Is Portland getting hotter?" (Open-Meteo city lookup)
    - "How much have oceans warmed?" (NOAA NCEI)
35. Run on a real device via Xcode
36. Upload to TestFlight via Xcode Organizer → App Store Connect

### Phase 6 — Hardening
37. Add a 5-second timeout on Worker fetch calls to NOAA GML, NOAA NCEI, NSIDC, and Open-Meteo
38. Reject user inputs over 500 characters at the Worker before reaching Claude
39. Refine the iOS error states built in Phase 4 (`ErrorView.swift`): add a retry affordance and cover remaining edge cases (e.g. request timeout vs. no connection) beyond the four core cases already handled
40. Cap conversation history at 10 exchanges before sending to Worker

---

## 6. Anti-Hallucination System Prompt Rules

These go in `prompts.js` and are non-negotiable:

- "You may only cite specific numbers, statistics, or measurements if they came directly from a tool call in this conversation."
- "If no tool returned data relevant to the question, say so plainly. Do not estimate, extrapolate, or use training knowledge for factual climate figures."
- "Always cite the exact source name returned by the tool for every number you state: 'NOAA GML' for greenhouse gases (CO2/CH4/N2O), 'NOAA NCEI' for temperature and ocean heat content, 'NSIDC/NOAA Sea Ice Index' for sea ice, or 'Open-Meteo' for city weather. Never attribute NCEI or NSIDC data to NOAA GML — they are different sources."
- "If two sources return different values for the same measurement, present both and name each source."
- "Always return a valid JSON object matching one of the two response formats specified. Never return plain text or markdown."
- "For chart responses, identify each dataset by `sourceToolCallId` referencing the tool call that produced its data. Never re-type the data points yourself — the Worker injects the actual values from the tool result."

---

## 7. Cost Controls

Four layers, in order of impact:

### 7.1 Anthropic hard spend cap (do this first)
Set a monthly dollar limit in the Anthropic account dashboard before any live traffic. The API simply stops responding if you hit it — your Worker catches the error and returns a friendly "service temporarily unavailable" message to the iOS app. Set it to whatever you're comfortable losing in a worst-case month (e.g. $20–$50).

### 7.2 Answer caching via Cloudflare KV
The single highest-leverage control for this app. Climate data changes slowly — "what is the current CO₂ level?" asked by 500 users today could cost one Anthropic call instead of 500. Cache key = normalized question hash, **single-turn questions only** (see R9 — a question-text hash can't safely represent a follow-up, since the same wording means different things depending on conversation history). TTLs:
- **1 hour** — current-state questions (CO₂ today, current sea ice extent)
- **24 hours** — long-term trend questions ("has temperature risen since 1900?" — the answer is the same every day)
- **1 hour** — city-specific questions (Open-Meteo data updates daily at most)

Implemented in `cache.js`; wired into `index.js` before the Claude call.

### 7.3 Per-user rate limiting via Cloudflare KV
Track requests per IP address in KV counters. Free tier: 5 questions per user per day. The iOS app receives a clear "you've reached your daily limit" message on a 429 response. Implemented in `rateLimit.js`.

### 7.4 Token limits
Set `max_tokens: 1024` in the Anthropic API call. This is sufficient *because* chart responses carry only metadata (title, labels, a `sourceToolCallId` per dataset, explanation) — the Worker injects the actual data points after Claude responds (see Section 4). Without that split, a single 140-year annual series (~140 `{x, y}` pairs) already exceeds 800 tokens before any labels or explanation, causing Claude's response to truncate mid-JSON — exactly the malformed-response failure mode R2 warns about. Reject user inputs over 500 characters at the Worker before the request reaches Claude.

### 7.5 Future: tiered access via Apple IAP
If the app grows:
- **Free tier:** 5 questions/day
- **Pro tier** (Apple in-app purchase): unlimited questions
- IAP revenue offsets Anthropic costs; Apple takes 15–30%

---

## 8. Risks and Decision Points

### R1 — Four active data-source modules in Phase 2
Global-scale data is split across three separate NOAA/NSIDC sources, not one: NOAA GML (greenhouse gases only — CO2, CH4, N2O), NOAA NCEI (surface temperature anomaly, ocean heat content), and NSIDC (Arctic sea ice extent). GML's API does not carry temperature, sea ice, or ocean heat data — attributing those to GML would violate the anti-hallucination citation rule in Section 6. Open-Meteo handles city-level historical weather. All four files (`noaaGml.js`, `noaaNcei.js`, `seaIceIndex.js`, `openMeteo.js`) must be fully implemented in Phase 2 — none is a stub.

### R2 — JSON envelope reliability
Getting Claude to return valid JSON on every response — including edge cases and errors — requires careful prompt engineering and a validation layer in the Worker. Plan for iteration. The Worker should catch malformed responses and return a fallback `{"type":"text","answer":"..."}` rather than crashing.

### R3 — iOS app cannot hold the API key
Confirmed: the Cloudflare Worker holds the `ANTHROPIC_API_KEY`. The iOS app only knows the Worker's URL. Do not store the key in the Xcode project, `Config.swift`, or any file that touches version control.

### R4 — Cloudflare Worker free tier
100,000 requests/day, ~10ms CPU time (wall-clock unlimited). A tool-use loop with 2–3 Claude round-trips will take 3–8 seconds wall-clock — well within limits. CPU usage is minimal (mostly network I/O waiting). Cloudflare KV is included in the free tier (1GB storage, 100K reads/day, **1,000 writes/day**) — but the write limit, not the 100K request limit, is the actual daily ceiling. Every request writes to KV at least once (the rate-limit counter increment in `rateLimit.js`), and every cache miss adds a second write (the cache set in `cache.js`). That puts real daily capacity at roughly **500–1,000 total requests across all users** — closer to 500 on a cold cache, closer to 1,000 once it's warm — not the 100K Worker request quota this section might otherwise suggest. That's almost certainly fine for a TestFlight-scale rollout, but it's the constraint to watch if usage grows. If it becomes binding, Cloudflare's dedicated Rate Limiting binding (doesn't consume the KV write quota) or Durable Objects (per-key coordination without it) are the eventual fix.

### R9 — Cache is scoped to single-turn questions only
The cache key is a hash of the question text alone, which is only safe when there's no conversation history to disambiguate it. Once history is included, two different follow-ups with identical wording — "how much has it risen?" asked about CO2 in one conversation, about sea ice in another — would hash identically and serve the wrong cached answer to one of them. Fix: only read/write the cache when the incoming `messages` array is a single entry (no prior turns); any multi-turn follow-up always goes straight to Claude. This is the simpler and safer of two options — the alternative, folding conversation history into the cache key, effectively kills the hit rate since history is rarely identical across users, and answer caching is the single highest-leverage cost control in this plan (Section 7.2).

### R5 — TestFlight requires Apple Developer account
You need a paid Apple Developer account ($99/yr) to upload to TestFlight, even for internal testing. **Activation takes 24–48 hours after signup** — don't wait until Phase 5 to start this, or it becomes a surprise blocker right when you're ready to ship. Start the signup at developer.apple.com during Phase 1 (see Phase 1, step 8); it doesn't block any earlier work.

### R6 — Swift Charts data volume
Swift Charts handles thousands of points fine in a line chart, but passing 140+ years of monthly temperature data (1,680 points) could cause rendering lag on older devices. If needed, the Worker can downsample to annual averages before returning.

### R7 — Streaming
Non-streaming for v1 (simpler). The iOS app shows a loading indicator until the full response arrives. Streaming can be added later (URLSession supports it; the Worker Anthropic SDK supports it).

### R8 — Open-Meteo free tier is non-commercial only
Open-Meteo's free tier explicitly prohibits commercial use. If ClimateChat ever includes paid features, a subscription, ads, or is sold, a commercial Open-Meteo plan is required (pricing starts at ~€400/yr as of 2024). **Action required before any monetization:** switch to the paid API tier and update the Worker's Open-Meteo base URL.

---

## 9. Decisions

1. **Data sources:** NOAA GML (greenhouse gases), NOAA NCEI (surface temperature, ocean heat content), NSIDC (Arctic sea ice), and Open-Meteo (city-level data) — all four active in Phase 2. global-warming.org dropped — no ToS, no SLA, no contact path.
2. **Apple Developer account:** Sign up at developer.apple.com during **Phase 1**, not Phase 5 (see Phase 1, step 8). Activation takes 24–48 hours and doesn't block Phases 1–4, but starting late turns it into a surprise delay right before the TestFlight upload.
3. **App name:** **ClimateChat**
