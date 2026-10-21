// @typecheck
/**
 * Builder tools — the two table steps: read_table (an uploaded or generated
 * spreadsheet / CSV into tables) and table (edit a table without code).
 *
 * Both are created through builder_add_steps (type "read_table" / "table").
 * The settings are read and judged by the shared specs, the same ones the
 * validator and the runner use (core/automationModel/tableOps), so a step the
 * builder adds is a step the validator accepts. A refused step names the field
 * path of every problem.
 *
 * The default labels MUST stay in step with nodeDefs.js's `defaultLabel` for
 * these types — nodeDefs.serverLabels.test.js reads both and compares them.
 */

const { newId, appendAfter } = require('../draftGraph');
const { sanitizeForEach, validateAndFixBindings } = require('../bindings');
const { refHead, REF_ROOTS, hasPlaceholder } = require('../../validate/refPaths');
const { normalizeReadTableStep, validateReadTableStep } = require('../../../core/automationModel/tableOps/readTableSpec');

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A bare path string is a ref, a string with {{…}} a template; anything else is left as sent. */
function asBinding(v) {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (!t) return v;
    if (hasPlaceholder(t)) return { kind: 'template', value: t };
    const { root } = refHead(t);
    return root && REF_ROOTS.has(root) && (t[root.length] === '.' || t[root.length] === '[') ? { kind: 'ref', path: t } : v;
}

/** Does this binding read the current row (`row`, `rowIndex`)? Those exist only while the step runs. */
function readsRow(b) {
    if (b.kind === 'ref') return /^\s*\$?(row|rowIndex)\b/.test(String(b.path || ''));
    if (b.kind === 'template') return /\{\{\s*\$?(row|rowIndex)\b/.test(String(b.value || ''));
    return false;
}

/**
 * Check one binding the way every other builder checks one: the path must
 * exist in the draft. Literals and expressions are not paths; a binding that
 * reads the current row is checked by the validator, which knows the row.
 * @returns {{ value: any, error?: string, notes?: string[] }}
 */
function fixBinding(raw, draft, draftWrap, label) {
    const b = asBinding(raw);
    if (!isObject(b) || typeof b.kind !== 'string' || b.kind === 'literal' || b.kind === 'expr' || readsRow(b)) return { value: b };
    const r = validateAndFixBindings({ x: b }, draft, { draftWrap });
    if (r.error) return { value: b, error: `${label}: ${r.error.replace(/inputs\.x/g, label)}` };
    return { value: r.inputs.x, notes: (r.notes || []).map(n => n.replace(/inputs\.x/g, label)) };
}

/** The source of a table step: a path or template to a file or a table, never a typed-in value. */
function fixSource(raw, draft, draftWrap, what) {
    if (raw === undefined || raw === null || raw === '') {
        return { error: `source is required — ${what}`, _fixHint: `Reject reason: no source. Add source:{kind:"ref", path:"…"} at the top level of this step and resend it. ${what}` };
    }
    const fixed = fixBinding(raw, draft, draftWrap, 'source');
    if (fixed.error) return { error: fixed.error };
    const b = fixed.value;
    const literalFile = isObject(b) && b.kind === 'literal' && isObject(b.value) && (b.value.kind === 'form_upload' || b.value.kind === 'generated_file' || isObject(b.value.sourceHandle));
    if (!isObject(b) || typeof b.kind !== 'string' || (b.kind === 'literal' && !literalFile)) {
        return { error: `source must be a reference, not a typed-in value — use {kind:"ref", path:"…"}. ${what}` };
    }
    return { source: b, notes: fixed.notes || [] };
}

/** forEach, checked like every other step's. */
function fixForEach(args, draft, draftWrap) {
    if (args.forEach === undefined || args.forEach === null) return { notes: [] };
    const { forEach, error, notes } = sanitizeForEach(args.forEach, draft, draftWrap);
    return error ? { error } : { forEach, notes: notes || [] };
}

/** The refusal for findings that are errors: every field path, then a hint that keeps the rest of the step. */
function findingsRefusal(type, findings) {
    const errors = findings.filter(f => f.severity === 'error');
    if (!errors.length) return null;
    const lines = errors.map(f => `${f.path}: ${f.message}${f.hint ? ` ${f.hint}` : ''}`);
    return {
        error: `${type}: ${lines.join(' | ')}`,
        _fixHint: `Reject reason: ${errors.length} setting(s) of this ${type} step are not valid (${errors.map(f => f.path).join(', ')}). Fix exactly those fields and resend the step; the other settings were fine.`,
    };
}

const SOURCE_HINT_READ = 'Bind it to a form file answer (trigger.output.<field>) or a generated file (steps.<id>.output.sourceHandle).';
const SOURCE_HINT_TABLE = 'Bind it to a table: steps.<id>.output.table of a read_table or table step.';

/**
 * read_table: open an uploaded spreadsheet / CSV as tables, one per sheet.
 * Default label 'Read table'.
 */
function applyAddReadTable(draft, args, draftWrap) {
    const src = fixSource(args.source, draft, draftWrap, SOURCE_HINT_READ);
    if (src.error) return { error: src.error, ...(src._fixHint ? { _fixHint: src._fixHint } : {}) };
    const fe = fixForEach(args, draft, draftWrap);
    if (fe.error) return { error: fe.error };
    const refusal = findingsRefusal('read_table', validateReadTableStep({ ...args, source: src.source }));
    if (refusal) return refusal;

    const settings = normalizeReadTableStep({ ...args, source: src.source });
    const step = {
        id: newId('read'),
        type: 'read_table',
        label: args.label || 'Read table',
        ...settings,
        ...(fe.forEach ? { forEach: fe.forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    const warnings = [...src.notes, ...fe.notes];
    return { added: step, ...(warnings.length ? { _warnings: warnings } : {}) };
}

/** Copy of an op with its bindings (join.with, filter.rulesFrom, rule values, derive values) passed through `fn(value, label)`. */
function mapOpBindings(op, index, fn) {
    if (!isObject(op)) return op;
    const out = { ...op };
    const at = `ops[${index}]`;
    if (op.op === 'join' && op.with !== undefined) out.with = fn(op.with, `${at}.with`);
    if (op.op === 'filter') {
        if (op.rulesFrom !== undefined && op.rulesFrom !== null) out.rulesFrom = fn(op.rulesFrom, `${at}.rulesFrom`);
        if (Array.isArray(op.rules)) {
            out.rules = op.rules.map((r, j) => (isObject(r) && r.value !== undefined ? { ...r, value: fn(r.value, `${at}.rules[${j}].value`) } : r));
        }
    }
    if (op.op === 'derive' && Array.isArray(op.columns)) {
        out.columns = op.columns.map((c, j) => (isObject(c) && c.value !== undefined ? { ...c, value: fn(c.value, `${at}.columns[${j}].value`) } : c));
    }
    return out;
}

/** Run every op binding through the draft's path checks. */
function fixOpBindings(ops, draft, draftWrap) {
    const errors = [];
    const notes = [];
    const fixed = ops.map((op, i) => mapOpBindings(op, i, (value, label) => {
        const r = fixBinding(value, draft, draftWrap, label);
        if (r.error) errors.push(r.error);
        notes.push(...(r.notes || []));
        return r.value;
    }));
    return { ops: fixed, errors, notes };
}

/**
 * table: edit a table without code (join, derive, filter, group, pivot, ...).
 * Default label 'Edit table'.
 */
function applyAddTable(draft, args, draftWrap) {
    const { normalizeTableStep, validateTableStep } = /** @type {any} */ (require('../../../core/automationModel/tableOps/spec'));
    const src = fixSource(args.source, draft, draftWrap, SOURCE_HINT_TABLE);
    if (src.error) return { error: src.error, ...(src._fixHint ? { _fixHint: src._fixHint } : {}) };
    const fe = fixForEach(args, draft, draftWrap);
    if (fe.error) return { error: fe.error };
    if (args.ops !== undefined && !Array.isArray(args.ops)) {
        return findingsRefusal('table', [{ severity: 'error', path: 'ops', message: 'The operations must be a list.' }]);
    }
    const bound = fixOpBindings(Array.isArray(args.ops) ? args.ops : [], draft, draftWrap);
    if (bound.errors.length) {
        return { error: `table: ${bound.errors.join(' | ')}`, _fixHint: 'Reject reason: a reference in an operation does not resolve. Fix the named path and resend the step; the other settings were fine.' };
    }
    const candidate = { ...args, source: src.source, ops: bound.ops };
    const findings = validateTableStep(candidate);
    const refusal = findingsRefusal('table', findings);
    if (refusal) return refusal;

    const settings = normalizeTableStep(candidate);
    const step = {
        id: newId('table'),
        type: 'table',
        label: args.label || 'Edit table',
        source: settings.source,
        ops: settings.ops,
        ...(settings.name ? { name: settings.name } : {}),
        expiresInDays: settings.expiresInDays,
        ...(fe.forEach ? { forEach: fe.forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    const warnings = [...src.notes, ...fe.notes, ...bound.notes, ...findings.filter(f => f.severity === 'warning').map(f => `${f.path}: ${f.message}`)];
    return { added: step, ...(warnings.length ? { _warnings: warnings } : {}) };
}

module.exports = {
    applyAddReadTable, applyAddTable,
    fixBinding, fixSource, fixOpBindings, findingsRefusal, mapOpBindings,
    SOURCE_HINT_READ, SOURCE_HINT_TABLE,
};
