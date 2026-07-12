# ClimateChat

Climate Q&A iOS app (SwiftUI) + Cloudflare Worker backend (TypeScript).
Full architecture, build sequence, and risk register: see project-plan.md.

## Non-negotiable rules
- NEVER put ANTHROPIC_API_KEY in the iOS app, Config.swift, or any committed file (plan R3)
- Secrets.xcconfig is gitignored — verify .gitignore covers it BEFORE creating it (plan R11)
- If a secret is ever committed: rotate it immediately, don't just delete the commit (plan R11)
- Tool handlers return structured JSON, never raw CSV (plan Phase 2 preamble)
- Never cite NCEI or NSIDC data as "NOAA GML" — different sources (plan Section 7)
- UI work must follow the UI Design Spec (plan Section 5); if it's still TBD, stop and ask

## Commands
- Worker tests: cd worker && npx vitest run
- Worker lint: cd worker && npm run lint
- iOS tests: xcodebuild test -scheme ClimateChat -destination 'platform=iOS Simulator,name=iPhone 16'
- iOS lint: swiftlint lint
- Deploy: cd worker && wrangler deploy (only after tests + lint pass)
- Smoke test: APP_SECRET=xxx ./scripts/smoke-test.sh (consumes full daily rate quota)

## Conventions
- TypeScript strict mode; no floating promises
- Model string: claude-sonnet-5
- Response envelope types live in worker/src/types.ts — iOS Codable structs must match