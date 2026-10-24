// @typecheck
'use strict';
/**
 * Findings for one `table` step: shape and field checks (validateOps.js) plus,
 * when the input columns are known, a pass over the columns each op uses.
 * Pure. Finding = { code: 'table.<x>', severity, path (relative to the step), message, hint? }.
 */

const { TABLE_OPS, OP_LABELS, OP_ID_RE, NOTE_MAX_CHARS, DEFAULT_MAX_OPS, bindingBlank, isRecord } = require('./constants');
const { normalizeTableStep } = require('./spec');
const { CHECKS } = require('./validateOps');
const { planColumns } = require('./planColumns');

/**
 * @param {any} step
 * @param {{ columns?: { key: string, label?: string }[], maxOps?: number }} [opts]
 *   `columns`: the columns of the source table when they are known.
 * @returns {{ code: string, severity: 'error'|'warning', path: string, message: string, hint?: string }[]}
 */
function validateTableStep(step, opts = {}) {
    const findings = [];
    const push = (severity, code, path, message, hint) => findings.push({ code: `table.${code}`, severity, path, message, ...(hint ? { hint } : {}) });
    const s = isRecord(step) ? step : {};
    const normalized = normalizeTableStep(s);
    const maxOps = opts.maxOps === undefined ? DEFAULT_MAX_OPS : opts.maxOps;

    if (bindingBlank(s.source)) push('error', 'source_missing', 'source', 'Pick the table this step works on.', 'Choose the output of a step that makes a table, such as Read table.');
    if (s.ops !== undefined && !Array.isArray(s.ops)) push('error', 'ops_invalid', 'ops', 'The operations must be a list.');
    const rawOps = Array.isArray(s.ops) ? s.ops : [];
    if (maxOps > 0 && rawOps.length > maxOps) push('error', 'ops_too_many', 'ops', `A table step can have at most ${maxOps} operations (this one has ${rawOps.length}).`, 'Split the work over two table steps.');
    if (s.expiresInDays !== undefined && !(Number(s.expiresInDays) >= 1 && Number(s.expiresInDays) <= 90)) {
        push('error', 'expires_invalid', 'expiresInDays', 'Keep the table for between 1 and 90 days.');
    }

    const seenIds = new Set();
    let groupsAt = -1;
    normalized.ops.forEach((n, i) => {
        const raw = isRecord(rawOps[i]) ? rawOps[i] : {};
        const label = `Step ${i + 1} (${OP_LABELS[n.op] || 'Unknown'})`;
        const add = (severity, code, sub, message, hint) => push(severity, code, `ops[${i}]${sub}`, `${label}: ${message}`, hint);
        if (!TABLE_OPS.includes(n.op)) {
            return push('error', 'op_unknown', `ops[${i}].op`, `Step ${i + 1}: "${raw.op ?? ''}" is not an operation this step knows.`, `Use one of: ${TABLE_OPS.join(', ')}.`);
        }
        if (raw.id !== undefined && !OP_ID_RE.test(String(raw.id))) add('error', 'op_id_invalid', '.id', 'the id may use letters, digits, - and _ (up to 40 characters).');
        if (seenIds.has(n.id)) add('error', 'op_id_duplicate', '.id', `the id "${n.id}" is used by another step.`, 'Give every operation its own id.');
        seenIds.add(n.id);
        if (typeof raw.note === 'string' && raw.note.length > NOTE_MAX_CHARS) add('warning', 'note_too_long', '.note', `the note is cut to ${NOTE_MAX_CHARS} characters.`);
        if (groupsAt >= 0 && n.enabled) add('warning', 'ops_after_groups', '', 'it works on the list of segments, not on your rows.', 'Move it before the Segments step to work on the rows.');
        if (n.op === 'groups' && n.enabled && groupsAt < 0) groupsAt = i;
        CHECKS[n.op](raw, n, add);
    });

    if (Array.isArray(opts.columns)) {
        const plan = planColumns(opts.columns, normalized.ops);
        for (const f of plan.findings) findings.push(f);
    }
    return findings;
}

module.exports = { validateTableStep };
