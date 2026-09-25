# ClimateChat — UI Design Brief

> Input for the Claude Design iteration (plan Section 5 workflow). The behavior and
> content decisions below were settled on 2026-09-24 and are **fixed**: explore the
> visual treatment around them, don't change them. The output of the design session is
> visual direction, not code: the app is implemented natively in SwiftUI afterwards.

## The app in one paragraph

ClimateChat is an iPhone app (iOS 16+) where you ask questions about climate change in
plain language and get answers built from real measurements: NOAA (greenhouse gases,
global temperature, ocean heat), NSIDC (Arctic sea ice) and Open-Meteo (city weather
history). Answers are short text, sometimes with a line or bar chart. The AI is not
allowed to quote figures from memory, so it sometimes says "that data isn't available"
instead of guessing. That honesty is the product's identity. The design should feel
trustworthy and calm, not alarmist and not playful.

## Follow Apple's Human Interface Guidelines

**Every part of this design must follow Apple's Human Interface Guidelines (HIG) for
iOS:** <https://developer.apple.com/design/human-interface-guidelines/>. Where this brief
and the HIG seem to conflict, follow the HIG and flag the conflict rather than working
around it. Use standard iOS components (navigation bar, sheets, buttons, text field)
in their system style rather than custom-drawn replacements, so they pick up the current
system appearance automatically. The most relevant HIG pages: Charts, Charting data,
Accessibility, Color, Typography, Layout, Buttons, Alerts, App icons.

## Fixed platform conventions

- Standard iOS chat layout: user messages right-aligned in accent-colour bubbles,
  assistant messages left-aligned in secondary-background bubbles, input bar pinned to
  the bottom with a send button, auto-scroll to the newest message.
- **Dark mode and Dynamic Type are required from the first screen.** Every layout must
  work at the largest accessibility text sizes.
- **Colours are named semantically only** (e.g. `accent`, `secondaryBackground`,
  `chartSeries1`). No hex values in the spec, so both appearances work.
- iPhone only. Portrait is the primary target, but the layout must not be locked to it:
  every screen must also adapt cleanly to landscape (HIG Layout).

## Accessibility requirements

These are HIG requirements, not nice-to-haves. Show how the design meets each one.

- **Never rely on colour alone.** Chart series must differ by more than colour: a
  distinct line style (solid / dashed / dotted), point shape, or a label placed directly
  on the line. The same applies to refusal and error states: pair colour with an icon or
  text, never colour by itself.
- **VoiceOver for charts.** Every chart needs accessibility labels and supports Audio
  Graphs (available in Swift Charts on iOS 16). The chart's title, each dataset's
  `description` and `unit`, and the `explanation` text provide the spoken summary.
  Describe what the data represents, never what it looks like ("CO₂, ppm", not "the
  blue line").
- **Charts never require interaction.** The key message (explanation, source, units)
  is always visible; dragging to inspect values only adds detail. The drag target is the
  **whole plot area**, not individual points, which are too small to hit on long series.
- **Text always follows the user's text-size setting (Dynamic Type).** Specify every
  piece of text as an iOS text style (Large Title, Headline, Body, Callout, Footnote,
  Caption…), **never as a fixed point size**, including chart titles, axis labels,
  legends, the drag readout and button labels. Mockup font sizes are illustrations at
  the default setting, not values to copy. Never cap the text size to protect a layout:
  instead, layouts must reflow at the largest **accessibility** sizes (e.g. side-by-side
  elements stack vertically, chart axes show fewer tick labels, long text wraps rather
  than truncating). Show the key screens at the default size and at the largest
  accessibility size.
- **Tap targets at least 44×44 pt**, including the example-question buttons and the ⓘ
  button.
- **Contrast meets WCAG AA** for text and chart marks in both light and dark
  appearances, and improves further when the system Increase Contrast setting is on.
- **Reduce Motion.** Any animation (e.g. a typing indicator) must be replaced by a
  static or gentler version when Reduce Motion is on.

## Screens and states to design

### 1. Empty state (first launch, and any fresh conversation)
Contents, top to bottom:
- **One-line intro:** what ClimateChat does and that answers come from NOAA, NSIDC and
  Open-Meteo data. Draft: *"Ask about climate change. Every figure comes from NOAA,
  NSIDC or Open-Meteo measurements, never from the AI's memory."*
- **Four tappable example questions.** Tapping one sends it exactly as if typed:
  - "How has CO₂ changed since 1960?"
  - "Show me a chart of global temperature since 1950"
  - "Is Arctic sea ice shrinking over time?"
  - "Has Portland, Oregon gotten hotter since 1980?"
- **Small footnote:** *"5 questions per day while in beta."* **(TestFlight only:** must
  be reworded before any App Store release, since beta references don't belong in an
  App Store build.)

No large logo or hero image; the navigation bar title already says "ClimateChat". The
empty state disappears once the first message is sent.

### 2. Navigation bar
- Title "ClimateChat".
- An **ⓘ info button** that opens the About / Credits sheet (screen 7).

### 3. Text answer
Plain assistant bubble. Answers name their source inline ("…according to NOAA GML").
Some ordinary-looking text answers are really degraded states and need no special
styling, just normal bubbles:
- a generic *"Sorry — something went wrong while putting that answer together. Please
  try asking again."* (a timeout or internal failure),
- *"the data couldn't be retrieved right now"* (a data source is down),
- city answers that name the place used and mention alternatives ("I used Portland,
  Oregon; Portland, Maine also matches").

### 4. Chart answer (the main design problem)
A chart card inside the assistant's turn. The data the app receives per chart:
- `title` (AI-written), `chartType` (`line` or `bar`), `xLabel` (usually "Year"),
  `yLabel` (AI-written descriptive text), `explanation` (1–3 sentences of AI prose)
- one or more **datasets**, each with: `label` (short legend name, AI-written),
  `source` (e.g. "NOAA GML"), `description` (e.g. "Global atmospheric CO₂, annual
  mean"), `unit` (e.g. "ppm"), and the data points.

Rules the card must follow:
- **Attribution comes from each dataset's `source`** and must be visible on the card
  (e.g. "Source: NOAA GML"). If datasets have different sources, list each one.
- **The axis unit comes from the datasets' `unit`**, not from `yLabel`. `yLabel` can be
  shown only as a descriptive subtitle.
- `description` is the authoritative "what is this series" text; decide where it lives
  (under the legend, in a caption, or revealed on tap).
- **Mixed units → separate stacked charts.** If a chart's datasets have different units
  (CO₂ in ppm and methane in ppb), draw one plot per unit, stacked inside the same card,
  sharing the title and explanation. Datasets with the same unit share one plot.
- **Drag to inspect.** Dragging anywhere across a plot shows the exact x (year or date)
  and value with its unit at that point. Show how the readout looks.
- **Series are distinguished by more than colour** (line style, point shape or direct
  labels). See Accessibility requirements.
- Series can be long: up to ~170 annual points or several hundred monthly points.
- Must stay legible at the largest Dynamic Type sizes and in dark mode, with enough
  contrast between up to ~3 series.

Show the card with: one line series, two series with the same unit, a mixed-unit pair
(stacked), and a bar chart.

### 5. Refusal (off-topic question)
When someone asks something unrelated to climate ("write me a haiku about pizza"), the
AI returns a short refusal message. Show it **visually distinct from a normal answer**,
followed by the **same four example questions as the empty state**, as tappable
buttons that send the question.

### 6. Error states (inline in the thread, not alerts)
Shown as an inline message where the assistant's answer would have appeared. Fixed
message per case:

| Case | Message |
|---|---|
| No connection | "You're offline. Check your connection and try again." |
| Daily limit reached | "You've used today's 5 questions. You can ask more after {local reset time}." (reset is midnight UTC, shown in the user's own time) |
| Server error | "ClimateChat is having trouble right now. Please try again in a moment." |
| App needs updating / rejected request | "Something's wrong with this version of the app. Please update it from TestFlight." **(TestFlight only:** reword for the App Store build.) |
| Unreadable response | "The answer came back garbled. Please try asking again." |

The daily-limit message should feel informational, not like a failure. There is no
question counter anywhere else in the app. A retry button is planned for a later phase:
leave room for one, but it isn't required in this pass.

### 7. About / Credits sheet (from the ⓘ button)
- What ClimateChat is and how answers are sourced (one short paragraph).
- Data sources: NOAA Global Monitoring Laboratory (greenhouse gases), NOAA National
  Centers for Environmental Information (temperature, ocean heat), NSIDC / NOAA Sea Ice
  Index (Arctic sea ice), Open-Meteo (city weather).
- **Required credits, with licence links (CC BY 4.0):**
  - Weather data by **Open-Meteo.com**, licensed CC BY 4.0
  - Place names by **GeoNames** (geonames.org), licensed CC BY 4.0
- App version.

## For the design session to propose

- Overall visual tone and typography within the iOS system fonts.
- The semantic colour palette (named roles for background, bubbles, accent, chart series,
  refusal, error, informational states), in both light and dark.
- The chart card layout: title, plot(s), legend, units, attribution, explanation, drag
  readout.
- Refusal and error visual treatments.
- App icon direction, in the current HIG format: a **layered icon** (foreground layers
  over a background, assembled in Xcode's Icon Composer) with **default, dark, clear and
  tinted** appearance variants that keep the same core features. No text in the icon.
- Loading state while waiting 3–10 seconds for an answer (e.g. typing indicator in an
  assistant bubble), including its Reduce Motion version.

## Out of scope for v1

City picker, conversation history across launches, settings, sign-in, streaming text,
iPad layout, widgets.
