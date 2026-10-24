// @typecheck
'use strict';
/**
 * Vocabulary and small coercion helpers of the table step, shared by the
 * normaliser, the validator and the column planner. Pure: no stores, no env.
 */

const TABLE_OPS = Object.freeze(['join', 'pseudonymise', 'derive', 'bucket', 'group', 'pivot', 'filter', 'select', 'sample', 'groups', 'describe']);

/** What an operation is called in a sentence ("Step 3 (Group): ..."). */
const OP_LABELS = Object.freeze({
    join: 'Join',
    pseudonymise: 'Pseudonymise',
    derive: 'Add columns',
    bucket: 'Bucket',
    group: 'Group',
    pivot: 'Pivot',
    filter: 'Filter',
    select: 'Select columns',
    sample: 'Sample',
    groups: 'Segments',
    describe: 'Describe',
});

const OP_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SALT_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const DEFAULT_MAX_OPS = 50;
const NOTE_MAX_CHARS = 500;
const COLUMN_NAME_MAX_CHARS = 200;
const TTL_MIN_DAYS = 1;
const TTL_MAX_DAYS = 90;
const TTL_DEFAULT_DAYS = 7;
const PREVIEW_SALT = 'preview-salt-not-for-runs';
const MIN_SALT_CHARS = 16;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Trimmed text; '' for anything that is not text or a number. */
function str(v) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return '';
}

/** A list of non-blank trimmed strings, or null when the value is not a list. */
function strListOrNull(v) {
    if (!Array.isArray(v)) return null;
    return v.map(str).filter(Boolean);
}

const strList = (v) => strListOrNull(v) || [];

/** Integer clamped into [min, max]; `fallback` when the value is not a number. */
function intIn(v, min, max, fallback) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** A finite number, or null. */
function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'string' ? Number(v.trim().replace(',', '.')) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** A binding is { kind: 'literal'|'ref'|'template'|'expr', ... }. */
const isBinding = (v) => isRecord(v) && typeof v.kind === 'string';

/** True when a binding (or bare value) carries nothing. */
function bindingBlank(b) {
    if (b === undefined || b === null) return true;
    if (!isBinding(b)) return typeof b === 'string' && b.trim() === '';
    if (b.kind === 'ref') return !str(b.path);
    if (b.kind === 'literal') return b.value === undefined || b.value === null || b.value === '';
    return !str(b.value);
}

module.exports = {
    TABLE_OPS, OP_LABELS, OP_ID_RE, SALT_VAR_RE, DEFAULT_MAX_OPS, NOTE_MAX_CHARS, COLUMN_NAME_MAX_CHARS,
    TTL_MIN_DAYS, TTL_MAX_DAYS, TTL_DEFAULT_DAYS, PREVIEW_SALT, MIN_SALT_CHARS,
    isRecord, str, strList, strListOrNull, intIn, numOrNull, isBinding, bindingBlank,
};
