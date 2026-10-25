// @typecheck noImplicitAny
'use strict';
/**
 * The table operation engine: runs a list of normalised operations over a
 * source table, one after the other, on streams of row objects.
 *
 * Lazy where it can be (filter, select, derive, pseudonymise, bucket, a join's
 * left side, sampling the first rows), consuming where it must be (group, pivot,
 * groups, describe, equal-part buckets, random samples). It yields to the event
 * loop every 2000 rows and asks `isCancelled` there.
 *
 * Errors carry `errorClass`, `opId` and `field`. `opStats` are filled in as the
 * rows flow, so read them after the rows were consumed; they are also on the
 * `opStats` property of any error the engine throws. `warningCodes` lists the
 * stable codes behind the warnings ('rules_from_runtime', 'preview_salt', ...).
 */

const { tableError, createTicker, iterate } = require('./values');

/** @typedef {{ key: string, label?: string, type?: string }} TableColumn */
/** @typedef {Record<string, unknown>} TableRow */
/** @typedef {{ id: string, op: string, enabled?: boolean, unknown?: boolean }} TableOp */
/** @typedef {{ columns: TableColumn[], provenance?: Record<string, string>|null, rows: () => AsyncIterable<TableRow> }} OpInput */
/** @typedef {{ columns: TableColumn[], rows: () => AsyncIterable<TableRow>, segments?: unknown, description?: unknown }} OpOutput */
/**
 * @typedef {{ opId: string, op: string, enabled: boolean, ok: boolean, inputRows: number, outputRows: number,
 *   columns: string[], warnings: string[], unmatched?: number, error?: { code: string, field: string, message: string } }} OpStat
 */
/**
 * @typedef {{ runState: import('../../../automationModel/bind').BindRunState, limits: ReturnType<typeof import('../limits').tableLimits>, mode: string, minGroupFloor: number,
 *   resolveTable: (binding: unknown, opId?: string) => Promise<{ columns: TableColumn[], rows: Parameters<typeof import('./values').iterate<TableRow>>[0] }>,
 *   tick: () => Promise<void>, warn: (message: string, code?: string) => void, stat: OpStat }} OpCtx
 */

/** @type {Record<string, () => { apply: (op: TableOp, input: OpInput, ctx: OpCtx) => OpOutput|Promise<OpOutput> }>} */
const OPS = {
    join: () => require('./join'),
    pseudonymise: () => require('./pseudonymise'),
    derive: () => require('./derive'),
    bucket: () => require('./bucket'),
    group: () => require('./group'),
    pivot: () => require('./pivot'),
    filter: () => require('./filter'),
    select: () => require('./select'),
    sample: () => require('./sample'),
    groups: () => require('./segments'),
    describe: () => require('./describe'),
};

/** @param {TableColumn[]} columns */
const keysOf = (columns) => columns.map((c) => c.key);

/**
 * @param {OpStat} stat
 * @param {{ errorClass?: string, field?: string, message?: string }} err
 */
function fail(stat, err) {
    stat.ok = false;
    stat.error = { code: err.errorClass || 'table_op_invalid', field: err.field || '', message: String(err.message || err) };
}

/** Count rows into stat[field] (restarting per pass) and pin errors to the operation they came from.
 * @param {AsyncIterable<TableRow>} rows
 * @param {OpStat} stat
 * @param {'inputRows'|'outputRows'} field
 * @param {TableOp} [op]
 */
async function* flow(rows, stat, field, op) {
    stat[field] = 0;
    try {
        for await (const row of iterate(rows)) {
            stat[field]++;
            yield row;
        }
    } catch (err) {
        if (err && typeof err === 'object') {
            if (err.opId === undefined && op) err.opId = op.id;
            if (op && err.opId === op.id) fail(stat, err);
        }
        throw err;
    }
}

/** @param {() => AsyncIterable<TableRow>} rows */
async function* sourceRows(rows) {
    try { yield* iterate(rows); } catch (err) {
        if (err && typeof err === 'object' && err.opId === undefined) err.opId = null;
        throw err;
    }
}

/**
 * @param {() => AsyncIterable<TableRow>} rows
 * @param {number} maxRows
 */
async function* capRows(rows, maxRows) {
    let n = 0;
    for await (const row of rows()) {
        if (maxRows > 0 && ++n > maxRows) {
            throw tableError('table_too_large', `The result has more than ${maxRows} rows. Filter or group earlier, or raise AUTOMATION_TABLE_MAX_ROWS.`);
        }
        yield row;
    }
}

/**
 * @param {{
 *   source: { columns: any[], rows: () => AsyncIterable<any>, provenance?: Record<string,string>|null },
 *   ops: any[], runState: any,
 *   resolveTable?: (binding: any, opId?: string) => Promise<{ columns: any[], rows: any }>,
 *   limits: any, minGroupFloor?: number, mode?: 'run'|'preview', upToOpId?: string,
 *   isCancelled?: () => boolean|Promise<boolean>,
 * }} args
 */
async function runTableOps(args) {
    const { source, ops, runState, limits, mode = 'run', upToOpId, isCancelled } = args;
    const resolveTable = args.resolveTable || (async () => { throw tableError('table_op_invalid', 'No table can be looked up here.'); });
    const list = Array.isArray(ops) ? ops : [];
    const opStats = [];
    /** @type {string[]} */
    const warnings = [];
    /** @type {string[]} */
    const warningCodes = [];
    /** @param {string} text @param {string} [code] */
    const addWarning = (text, code) => {
        if (!warnings.includes(text)) warnings.push(text);
        if (code && !warningCodes.includes(code)) warningCodes.push(code);
    };
    const tick = createTicker({ isCancelled });

    if (limits.maxOps > 0 && list.length > limits.maxOps) {
        throw tableError('table_op_invalid', `A table step can have at most ${limits.maxOps} operations (this one has ${list.length}). Split it over two steps, or raise AUTOMATION_TABLE_MAX_OPS.`);
    }
    let last = list.length - 1;
    if (upToOpId) {
        last = list.findIndex((o) => o.id === upToOpId);
        if (last < 0) throw tableError('table_op_invalid', `There is no operation with the id "${upToOpId}".`, { field: 'upToOpId' });
    }

    let cur = { columns: source.columns, rows: () => sourceRows(source.rows), provenance: source.provenance || null };
    let segments = null;
    let description = null;

    for (let i = 0; i <= last; i++) {
        const op = list[i];
        /** @type {OpStat} */
        const stat = { opId: op.id, op: op.op, enabled: op.enabled !== false, ok: true, inputRows: 0, outputRows: 0, columns: keysOf(cur.columns), warnings: [] };
        opStats.push(stat);
        if (!stat.enabled) continue;
        /** @param {string} message @param {string} [code] */
        const warn = (message, code) => {
            if (!stat.warnings.includes(message)) stat.warnings.push(message);
            addWarning(`Step ${i + 1} (${op.op}): ${message}`, code);
        };
        const opCtx = { runState, limits, mode, minGroupFloor: args.minGroupFloor || 0, resolveTable, tick, warn, stat };
        try {
            if (op.unknown || !OPS[op.op]) throw tableError('table_op_invalid', `"${op.op}" is not an operation this step knows.`, { opId: op.id, field: 'op' });
            const upstream = cur;
            const input = { columns: upstream.columns, provenance: upstream.provenance, rows: () => flow(upstream.rows(), stat, 'inputRows') };
            const out = await OPS[op.op]().apply(op, input, opCtx);
            cur = { columns: out.columns, rows: () => flow(out.rows(), stat, 'outputRows', op), provenance: upstream.provenance };
            if (out.segments) segments = out.segments;
            if (out.description) description = out.description;
            stat.columns = keysOf(out.columns);
        } catch (err) {
            if (err && typeof err === 'object') {
                if (err.opId === undefined) err.opId = op.id;
                fail(stat, err);
                err.opStats = opStats;
            }
            throw err;
        }
    }
    const finalRows = cur.rows;
    return { columns: cur.columns, rows: () => capRows(finalRows, limits.maxRows), opStats, segments, description, warnings, warningCodes };
}

module.exports = { runTableOps };
