'use strict';
/**
 * The `table` step: run a list of operations (join, pseudonymise, add columns,
 * bucket, group, pivot, filter, select, sample, segments, describe) over a
 * table made by an earlier step, and keep the result as a new table.
 *
 * The output carries the table handle plus, when it is small, the rows and a
 * markdown rendering to bind in later steps. A dry run stores nothing.
 */

const { normalizeTableStep } = require('../automationModel/tableOps/spec');
const { planColumns } = require('../automationModel/tableOps/planColumns');
const { noteRunWarning } = require('./runWarnings');

const NOT_FOUND = 'The table from an earlier step has expired or belongs to another run. Run the step that makes it again.';
const LIST_SAMPLE = 1000;

const defaultDeps = {
    tableLimits: () => require('./tables/limits').tableLimits(),
    isTableHandle: (v) => require('./tables/handle').isTableHandle(v),
    dryRunHandle: (a) => require('./tables/handle').dryRunHandle(a),
    openTable: (h, scope) => require('./tables/tableStore').openTable(h, scope),
    writeTable: (a) => require('./tables/tableStore').writeTable(a),
    minGroupFloorFor: (orgId) => require('./tables/groupPolicy').minGroupFloorFor(orgId),
    resolveValue: (binding, runState) => require('../automationModel/bind').resolveValue(binding, runState),
    isCancelRequested: (runId) => require('./cancellation').isCancelRequested(runId),
    runTableOps: (a) => require('./tables/ops').runTableOps(a),
    toMarkdown: (c, r) => require('./tables/ops/markdown').toMarkdown(c, r),
};

const orgOf = (ctx) => (ctx && (ctx.orgId || ctx.userHomeOrgId)) || null;

function stepError(errorClass, message, field) {
    return Object.assign(new Error(message), { errorClass, ...(field ? { field } : {}) });
}

/** The table handle a bound value is, or that it carries as `.table`. */
function tableFrom(value, deps) {
    if (deps.isTableHandle(value)) return value;
    if (value && typeof value === 'object' && deps.isTableHandle(value.table)) return value.table;
    return null;
}

function sourcePath(binding) {
    if (binding && typeof binding === 'object') {
        if (binding.kind === 'ref' && binding.path) return `\`${binding.path}\``;
        if (typeof binding.value === 'string' && binding.value) return `\`${binding.value}\``;
    }
    return 'an unset reference';
}

/** The sentence a skipped step shows: what was bound, what was found, what to do. */
function unresolvedMessage(binding, resolved) {
    const found = resolved === undefined ? 'nothing' : resolved === null ? 'null' : Array.isArray(resolved) ? 'a list' : typeof resolved;
    return `This step works on a table, but its source ${sourcePath(binding)} did not resolve to one (found ${found}). `
        + 'Re-run the step that produces the table, then run this step again, or point this step at a different table.';
}

/** A plain list of objects as a table source: columns from the union of the first keys. */
function listAsTable(list) {
    const { toScalar } = require('./tables/ops/values');
    const keys = [];
    const seen = new Set();
    for (const item of list.slice(0, LIST_SAMPLE)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        for (const k of Object.keys(item)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
    const rows = list.filter((i) => i && typeof i === 'object' && !Array.isArray(i)).map((i) => {
        const row = {};
        for (const k of keys) row[k] = toScalar(i[k]);
        return row;
    });
    return { columns: keys.map((k) => ({ key: k, label: k, type: 'mixed' })), rows: () => rows };
}

function dryRunResult(step, spec, handle, deps) {
    const columns = planColumns(handle.columns || [], spec.ops).columns || [];
    const table = deps.dryRunHandle({ name: spec.name || step.label || 'table', columns });
    return {
        output: { table, rowCount: 0, columns: table.columns, rows: [], markdown: '', opStats: [], warnings: [], _dryRun: true },
        dryRunSynthesised: true,
    };
}

/**
 * @param {any} step
 * @param {any} ctx
 * @param {any} runState
 * @param {'live'|'dry_run'|string} mode
 * @param {typeof defaultDeps} [overrides]
 */
async function execTable(step, ctx, runState, mode, overrides = defaultDeps) {
    const deps = { ...defaultDeps, ...overrides };
    const spec = normalizeTableStep(step);
    const resolved = deps.resolveValue(spec.source, runState);
    const handle = tableFrom(resolved, deps);
    if (!handle) {
        return { output: { skipped: unresolvedMessage(spec.source, resolved) }, skippedReason: 'table_source_unresolved' };
    }
    if (mode === 'dry_run') return dryRunResult(step, spec, handle, deps);

    const limits = deps.tableLimits();
    if (limits.maxOps > 0 && spec.ops.length > limits.maxOps) {
        throw stepError('table_op_invalid', `A table step can have at most ${limits.maxOps} operations (this one has ${spec.ops.length}). Split it over two steps, or raise AUTOMATION_TABLE_MAX_OPS.`, 'ops');
    }
    const scope = { runId: ctx.runId, rootRunId: ctx.rootRunId, automationId: ctx.automationId, userId: ctx.userId };
    const opened = await deps.openTable(handle, scope);
    if (!opened) throw stepError('table_not_found', NOT_FOUND, 'source');

    const resolveTable = async (binding) => {
        const value = deps.resolveValue(binding, runState);
        const other = tableFrom(value, deps);
        if (other) {
            const t = await deps.openTable(other, scope);
            if (!t) throw stepError('table_not_found', NOT_FOUND, 'with');
            return { columns: t.columns, rows: t.rows };
        }
        if (Array.isArray(value)) return listAsTable(value);
        throw stepError('table_op_invalid', 'The table to join with did not resolve to a table or a list of rows. Run the step that makes it again.', 'with');
    };

    const minGroupFloor = await deps.minGroupFloorFor(orgOf(ctx));
    const result = await deps.runTableOps({
        source: { columns: opened.columns, rows: opened.rows, provenance: handle.provenance || null },
        ops: spec.ops, runState, resolveTable, limits, minGroupFloor, mode: 'run',
        isCancelled: ctx.runId ? () => deps.isCancelRequested(ctx.runId) : undefined,
    });

    const inline = [];
    const inlineCap = limits.inlineRows;
    async function* tee() {
        for await (const row of result.rows()) {
            if (inlineCap > 0 && inline.length <= inlineCap) inline.push(row);
            yield row;
        }
    }
    const table = await deps.writeTable({
        ctx, stepId: step.id, name: spec.name || step.label || 'table', columns: result.columns,
        rows: tee(), ttlDays: spec.expiresInDays, provenance: handle.provenance || null,
    });

    const output = { table, rowCount: table.rowCount, columns: table.columns };
    if (inlineCap > 0 && table.rowCount <= inlineCap) {
        output.rows = inline;
        output.markdown = deps.toMarkdown(table.columns, inline);
    } else output.rowsOmitted = true;
    if (result.segments) output.segments = result.segments;
    if (result.description) output.description = result.description;
    output.opStats = result.opStats;
    output.warnings = result.warnings;
    for (const w of result.warnings) noteRunWarning(runState, `${step.id}: ${w}`);
    return { output };
}

module.exports = { execTable, unresolvedMessage };
