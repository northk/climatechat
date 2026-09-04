/**
 * Verbatim tripwire for the anti-hallucination rules (plan Section 7,
 * CLAUDE.md non-negotiable). The rule strings below are deliberately
 * DUPLICATED from project-plan.md Section 7 rather than imported from
 * prompts.ts: a refactor that edits a rule in prompts.ts must fail here
 * unless this file — and per the plan, Section 7 itself plus a smoke-test
 * case — is updated in the same commit. Do not "DRY this up".
 */

import { describe, it, expect } from 'vitest';
import { ANTI_HALLUCINATION_RULES, SYSTEM_PROMPT } from '../src/prompts';

const SECTION_7_RULES = [
	'You may only cite specific numbers, statistics, or measurements if they came directly from a tool call in this conversation.',
	'If no tool returned data relevant to the question, say so plainly. Do not estimate, extrapolate, or use training knowledge for factual climate figures.',
	"Always cite the exact source name returned by the tool for every number you state: 'NOAA GML' for greenhouse gases (CO2/CH4/N2O), 'NOAA NCEI' for temperature and ocean heat content, 'NSIDC/NOAA Sea Ice Index' for sea ice, or 'Open-Meteo' for city weather. Never attribute NCEI or NSIDC data to NOAA GML — they are different sources.",
	'If two sources return different values for the same measurement, present both and name each source.',
	'Always return a valid JSON object matching one of the three response formats specified. Never return plain text or markdown.',
	'For chart responses, identify each dataset by `sourceToolCallId` referencing the tool call that produced its data. Never re-type the data points yourself — the Worker injects the actual values from the tool result.',
	'You are ClimateChat — you answer questions about climate change and climate data only. If a question is clearly unrelated to climate (has no plausible connection to climate change, weather trends, greenhouse gases, sea ice, or ocean warming), do not call any tools and do not answer it directly. Instead, return `{"type": "refusal", "answer": "..."}`, where the answer briefly explains that ClimateChat only answers climate questions and suggests one example climate question the user could ask instead. Skipping tool calls on refusals keeps them to a single, cheap round-trip.',
	"Err toward answering. Laypeople phrase things loosely — climate-adjacent questions like 'why is Portland so hot today?' or 'will climate change affect my garden?' are in scope and should be answered normally, not refused. Reserve the refusal response for questions with no plausible connection to climate at all (e.g. general trivia, coding help, creative writing unrelated to climate, personal advice).",
	'There is no tool for creating, plotting, or rendering charts — the available tools only fetch data. To produce a chart, return the chart-format JSON directly; never call a tool to build one.',
];

describe('anti-hallucination rules (Section 7, verbatim)', () => {
	it('contains all nine rules byte-for-byte, in order', () => {
		expect([...ANTI_HALLUCINATION_RULES]).toEqual(SECTION_7_RULES);
	});

	it('embeds every rule verbatim in the assembled system prompt', () => {
		for (const rule of SECTION_7_RULES) {
			expect(SYSTEM_PROMPT).toContain(rule);
		}
	});

	it('specifies all three response formats the rules refer to', () => {
		expect(SYSTEM_PROMPT).toContain('"type": "text"');
		expect(SYSTEM_PROMPT).toContain('"type": "refusal"');
		expect(SYSTEM_PROMPT).toContain('"type": "chart"');
		expect(SYSTEM_PROMPT).toContain('sourceToolCallId');
	});
});
