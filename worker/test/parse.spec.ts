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
		['+3', 3],
		['.5', 0.5],
		['5.', 5],
		['1e3', 1000],
		['2.5E-2', 0.025],
	])('accepts %j → %j', (input, expected) => {
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
		['hex', '0x10'],
		['a trailing unit', '1.2C'],
		['two numbers', '1 2'],
		['an overflowing exponent', '1e999'],
		['a lone sign', '-'],
		['a lone dot', '.'],
	])('rejects %s', (_name, input) => {
		expect(parseNumber(input)).toBeNull();
	});
});
