# Climate Change Q&A Web App — Project Brief

## What I Want to Build

A climate change Q&A web app that's easy to use for laypeople (non-developers). The user types a natural language question like:

- "Is Portland getting hotter?"
- "How much did the average temperature change on Earth this year, and by how much?"
- "How much annual temperature change do scientists think is caused by human emissions?"

…and gets a clear, plain-English answer backed by real climate data.

---

## Architecture (Three Layers)

### 1. Data Layer
An MCP server that fetches climate data from potentially multiple REST APIs.

### 2. AI Layer
Claude interprets user questions, calls the right data tools, and composes plain-English answers.

- If different data sources don't agree, the answer should clearly state that there are conflicting or different answers, and state each answer along with which source it came from.
- The AI layer should do everything it can to avoid hallucinations or incorrect or misleading answers.

### 3. Frontend
A clean, simple web app with a chat-style prompt interface.

- Capable of rendering charts and graphs based on real data from the APIs.
- Also capable of rendering plain-English answers.

---

## Design Principles

- **Start with one data source** ([global-warming.org](https://global-warming.org), no API key needed), but design the data layer so additional sources (Open-Meteo, NASA POWER, NOAA) can be added as modules later without difficult refactoring.
- **Frontend** should look clean and feel approachable to a layperson and work well on a desktop or mobile browser.
- **Backend** should be deployable to the free hosting tier on Cloudflare — frontend on Cloudflare Pages, backend as a Cloudflare Worker using the Anthropic SDK with tool use. 
- **Cloudflare Workers** will act as an MCP-style tool dispatcher: the Worker receives the user's question, calls Claude via the Anthropic SDK, and Claude calls the climate data tools directly within the Worker.

---

## What I Want from the Plan

Before writing any code, I want a detailed project plan including:

1. **Recommended tech stack** with brief justification for each choice
2. **Folder and file structure** for the whole project
3. **Sequence of build steps** in the right order
4. **Risks or decision points** I should know about before starting

> Don't write any code yet. Just give me the plan so I can review and confirm before we build.

---

## Reference / Inspiration

Two existing apps in this space (both of which failed when I tried to use them — they hung or said they couldn't answer):

- [ClimateChatTO](https://climatechat-to.ca) — Toronto-specific climate chat
- [ChatClimate.ai](https://www.chatclimate.ai/)

Also potentially useful for ideas:

- [Ember Climate MCP server for Claude Code](https://vinkius.com/apps/ember-climate-mcp/with/claude-code)
