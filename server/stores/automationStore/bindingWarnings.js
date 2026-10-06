// @typecheck
/**
 * What a run-step row keeps of the mappings that found nothing while the step
 * ran: the runner's binding log (automation/bind.js withBindingLog, carried
 * here by core/automationRunner/bindingMisses.js) on its way into
 * automation_run_steps.binding_warnings.
 *
 * Built from an ALLOW-LIST of fields, never by copying the entry: the column
 * is read back by the Runs tab and the step's output panel, and a key a later
 * change adds to the log must not reach the database (or them) unseen. Every
 * string then goes through the caller's redaction, the same pass the step's
 * error gets: a formula's text or an evaluation message can quote a literal.
 * Each entry carries the server's own sentence (`description`), built from
 * the redacted entry, so the panels and the run summary say the same thing.
 */

'use strict';

const { describeBindingMiss } = require('../../automation/bind');

// Same ceiling as the binding log itself (bind.js MAX_BINDING_LOG_ENTRIES);
// repeated here so a caller that skips the log cannot grow a row past it.
const MAX_STORED_WARNINGS = 50;

const REASONS = new Set(['missing', 'not_run', 'syntax', 'error']);
const KINDS = new Set(['ref', 'template', 'expr']);

// field → longest string kept. A path or a formula can be long; the rest are
// names and kinds of value.
const STRING_FIELDS = { field: 200, path: 1000, at: 1000, found: 20, missing: 200, message: 500, step: 200 };

const isCount = (v) => Number.isInteger(v) && v > 0;

/** One log entry as stored, or null when it has no path to show. */
function pickEntry(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    if (typeof e.path !== 'string' || !e.path) return null;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, max] of Object.entries(STRING_FIELDS)) {
        const v = e[key];
        if (typeof v === 'string' && v) out[key] = v.length > max ? `${v.slice(0, max - 1)}…` : v;
    }
    if (KINDS.has(e.kind)) out.kind = e.kind;
    out.reason = REASONS.has(e.reason) ? e.reason : 'missing';
    if (Number.isInteger(e.size) && e.size >= 0) out.size = e.size;
    if (e.index === true) out.index = true;
    out.count = isCount(e.count) ? e.count : 1;
    return out;
}

/**
 * The list for the row, or null when nothing was missed.
 *
 * @param {unknown} list   the step's binding-log entries
 * @param {{ clean?: (v: any) => any }} [opts]  redaction for the stored copy
 * @returns {Array<Record<string, unknown>> | null}
 */
function persistableBindingWarnings(list, { clean = (v) => v } = {}) {
    if (!Array.isArray(list) || !list.length) return null;
    const out = [];
    for (const e of list) {
        if (out.length >= MAX_STORED_WARNINGS) break;
        const picked = pickEntry(e);
        if (!picked) continue;
        const safe = clean(picked);
        out.push({ ...safe, description: describeBindingMiss(safe) });
    }
    return out.length ? out : null;
}

module.exports = { persistableBindingWarnings, MAX_STORED_WARNINGS };
