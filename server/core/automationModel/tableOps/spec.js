'use strict';
/**
 * The table step's configuration: vocabulary, defaults and normalisation.
 *
 *   { type: 'table', id, label, source: Binding, ops: Op[], name?, expiresInDays?: 1..90 (7) }
 *
 * Every op carries { id, op, enabled, note? } plus its own fields (normalize.js).
 * Shared by the validator, the builder, the preview route and the runtime. Pure.
 */

const {
    TABLE_OPS, OP_LABELS, OP_ID_RE, SALT_VAR_RE, NOTE_MAX_CHARS, TTL_MIN_DAYS, TTL_MAX_DAYS, TTL_DEFAULT_DAYS,
    isRecord, str, intIn,
} = require('./constants');
const { RULE_TESTS, normalizeRules } = require('./rules');
const { byOp, AGG_FNS } = require('./normalize');

/**
 * One operation with defaults. An unknown `op` keeps its name and gains
 * `unknown: true`, so the validator can name it instead of the runner guessing.
 * @param {any} op
 * @param {number} index 0-based position in the step
 */
function normalizeOp(op, index) {
    const raw = isRecord(op) ? op : {};
    const name = str(raw.op);
    const id = OP_ID_RE.test(str(raw.id)) ? str(raw.id) : `op${index + 1}`;
    const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, NOTE_MAX_CHARS) : undefined;
    const base = { id, op: name, enabled: raw.enabled !== false, ...(note ? { note } : {}) };
    if (!TABLE_OPS.includes(name)) return { ...base, unknown: true };
    return { ...base, ...byOp[name](raw) };
}

/**
 * @param {any} step
 * @returns {{ source: any, ops: any[], name: string|null, expiresInDays: number }}
 */
function normalizeTableStep(step) {
    const s = isRecord(step) ? step : {};
    return {
        source: s.source === undefined ? null : s.source,
        ops: Array.isArray(s.ops) ? s.ops.map((op, i) => normalizeOp(op, i)) : [],
        name: str(s.name) || null,
        expiresInDays: intIn(s.expiresInDays, TTL_MIN_DAYS, TTL_MAX_DAYS, TTL_DEFAULT_DAYS),
    };
}

module.exports = {
    TABLE_OPS, OP_LABELS, RULE_TESTS, AGG_FNS, OP_ID_RE, SALT_VAR_RE,
    normalizeTableStep, normalizeOp, normalizeRules,
};

// validate.js and planColumns.js read this file, so they are exposed lazily:
// `require('./spec')` is the one door for the whole vocabulary without a cycle.
for (const [name, file] of [['validateTableStep', './validate'], ['planColumns', './planColumns']]) {
    Object.defineProperty(module.exports, name, { enumerable: true, get: () => require(file)[name] });
}
