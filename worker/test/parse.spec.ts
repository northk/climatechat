/**
 * Strict numeric parsing (Codex review): a missing upstream value must
 * never become a real measurement, while a genuine 0 must survive.
 */

import { describe, it, expect } from 'vitest';
import { parseNumber } from '../src/tools/parse';

describe('parseNumber', () => {
	it.each([
		[0, 0],
		[-0.12, -0.12],
		[424.61, 424.61],
		['0', 0],
		['-0.12', -0.12],
		['  1.09 ', 1.09],
		['\t2\n', 2],
		['+3', 3],
		['.5', 0.5],
		['5.', 5],
		['1e3', 1000],
		['2.5E-2', 0.025],
	])('accepts %j → %j', (input, expected) => {
		expect(parseNumber(input)).toBe(expected);
	});

	// Documented, harmless leniency inherited from Number(): no upstream sends
	// these, and one that did would still be a real value, not a missing one
	it.each([
		['0x10', 16],
		['0b11', 3],
		['0o17', 15],
	])('accepts the non-decimal literal %j → %j', (input, expected) => {
		expect(parseNumber(input)).toBe(expected);
	});

	it.each([
		['null', null],
		['undefined', undefined],
		['an empty string', ''],
		['a blank string', '   '],
		['true', true],
		['false', false],
		['an empty array', []],
		['a one-element array', [5]],
		['an object', { value: 1 }],
		['NaN', NaN],
		['Infinity', Infinity],
		['"NaN"', 'NaN'],
		['"Infinity"', 'Infinity'],
		['"-Infinity"', '-Infinity'],
		['a trailing unit (parseFloat would read 1.2)', '1.2C'],
		['a numeric separator (parseFloat would read 1)', '1_000'],
		['a thousands comma (parseFloat would read 1)', '1,000'],
		['two numbers', '1 2'],
		['an overflowing exponent', '1e999'],
		['a lone sign', '-'],
		['a lone dot', '.'],
	])('rejects %s', (_name, input) => {
		expect(parseNumber(input)).toBeNull();
	});
});
