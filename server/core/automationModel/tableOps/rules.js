// @typecheck
'use strict';
/**
 * Row rules of the table step: the vocabulary, the check of a rule list, and
 * the predicate a rule compiles to. Text tests ignore upper/lower case and
 * surrounding spaces (the restricted expression language's own helpers);
 * numeric tests read numbers the way a spreadsheet does ("1.234,5", "12%").
 * Pure.
 */

const { equalsValue, textContains, textStartsWith, textEndsWith } = require('../../../shared/expr/index.mjs');
const { parseNumberish, parseIsoUtc } = require('../../dataEngine/sources/spreadsheetFile/cells');
const { isRecord, str, isBinding } = require('./constants');

const RULE_TESTS = Object.freeze([
    'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in',
    'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty', 'contains_item',
]);

const UNARY = new Set(['is_empty', 'is_not_empty']);
const LIST_TESTS = new Set(['in', 'not_in']);
const NUMERIC = new Set(['gt', 'gte', 'lt', 'lte']);
const DEFAULT_SEPARATOR = ';';

const isBlankCell = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Check a list of rules.
 * @param {unknown} list
 * @returns {{ rules: { column: string, test: string, value?: unknown, separator?: string }[], errors: { index: number, field: 'column'|'test'|'value'|'rule', message: string }[] }}
 *   `rules` holds the well-formed rules only; `errors` names every other one by position (0-based).
 */
function normalizeRules(list) {
    const rules = [];
    const errors = [];
    if (list === undefined || list === null) return { rules, errors };
    if (!Array.isArray(list)) return { rules, errors: [{ index: 0, field: 'rule', message: 'The rules must be a list.' }] };
    list.forEach((raw, index) => {
        const fail = (field, message) => errors.push({ index, field, message });
        if (!isRecord(raw)) return fail('rule', 'A rule must have a column, a test and (for most tests) a value.');
        const column = str(raw.column);
        const test = str(raw.test);
        if (!column) return fail('column', 'Pick the column this rule looks at.');
        if (!RULE_TESTS.includes(test)) return fail('test', test ? `"${test}" is not a known test.` : 'Pick a test.');
        const rule = { column, test };
        if (!UNARY.has(test)) {
            let value = raw.value;
            if (value === undefined) return fail('value', 'Give this rule a value to compare with.');
            if (!isBinding(value)) {
                if (LIST_TESTS.has(test) && !Array.isArray(value)) value = [value];
                if (LIST_TESTS.has(test) && value.length === 0) return fail('value', 'Give at least one value to compare with.');
                if (test === 'between' && !(Array.isArray(value) && value.length === 2)) {
                    return fail('value', 'A "between" rule needs a lowest and a highest value.');
                }
                if (NUMERIC.has(test) && (Array.isArray(value) || isRecord(value))) return fail('value', 'This test compares with a single value.');
            }
            rule.value = value;
        }
        if (test === 'contains_item') rule.separator = str(raw.separator) || DEFAULT_SEPARATOR;
        rules.push(rule);
    });
    return { rules, errors };
}

/** A number, or ISO-date milliseconds, or null: the two things gt/lt can compare. */
function orderable(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'n', v } : null;
    if (typeof v === 'boolean' || v === null || v === undefined) return null;
    const n = parseNumberish(v);
    if (Number.isFinite(n)) return { kind: 'n', v: n };
    const d = parseIsoUtc(v);
    return d ? { kind: 'd', v: d.getTime() } : null;
}

function compare(cell, value) {
    const a = orderable(cell);
    const b = orderable(value);
    if (!a || !b || a.kind !== b.kind) return null;
    return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
}

const textOf = (v) => (v === null || v === undefined ? null : String(v).trim());

function itemsOf(cell, separator) {
    const t = textOf(cell);
    return t ? t.split(separator).map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * The predicate of one rule whose value is already a plain value.
 * @param {{ test: string, value?: unknown, separator?: string }} rule
 * @returns {(cell: unknown) => boolean}
 */
function compileRule(rule) {
    const { test, value } = rule;
    switch (test) {
        case 'equals': return (c) => (isBlankCell(value) ? isBlankCell(c) : !isBlankCell(c) && equalsValue(c, value));
        case 'not_equals': {
            const eq = compileRule({ test: 'equals', value });
            return (c) => !eq(c);
        }
        case 'contains': return (c) => !isBlankCell(c) && textContains(textOf(c), textOf(value));
        case 'not_contains': return (c) => isBlankCell(c) || !textContains(textOf(c), textOf(value));
        case 'starts_with': return (c) => !isBlankCell(c) && textStartsWith(textOf(c), textOf(value));
        case 'ends_with': return (c) => !isBlankCell(c) && textEndsWith(textOf(c), textOf(value));
        case 'in': return (c) => !isBlankCell(c) && /** @type {any[]} */ (value).some((v) => equalsValue(c, v));
        case 'not_in': return (c) => isBlankCell(c) || !(/** @type {any[]} */ (value)).some((v) => equalsValue(c, v));
        case 'gt': return (c) => { const r = compare(c, value); return r !== null && r > 0; };
        case 'gte': return (c) => { const r = compare(c, value); return r !== null && r >= 0; };
        case 'lt': return (c) => { const r = compare(c, value); return r !== null && r < 0; };
        case 'lte': return (c) => { const r = compare(c, value); return r !== null && r <= 0; };
        case 'between': return (c) => {
            const lo = compare(c, value[0]);
            const hi = compare(c, value[1]);
            return lo !== null && hi !== null && lo >= 0 && hi <= 0;
        };
        case 'is_empty': return (c) => isBlankCell(c);
        case 'is_not_empty': return (c) => !isBlankCell(c);
        case 'contains_item': {
            const sep = rule.separator || DEFAULT_SEPARATOR;
            return (c) => itemsOf(c, sep).some((item) => equalsValue(item, value));
        }
        default: return () => false;
    }
}

module.exports = { RULE_TESTS, DEFAULT_SEPARATOR, normalizeRules, compileRule, isBlankCell };
