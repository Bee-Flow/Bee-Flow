// @typecheck
/**
 * What ./execDatatable.js and ./datatableWrites.js share: the limits of one
 * datatable step, the source-mirror lookups (core/dataEngine/sources), and the
 * shapes of a refusal, a skip and a zero-effect output.
 */

'use strict';

// Rows live in a Postgres schema. The App Studio engine flag may say 'sqlite'
// on the same server, so every compile on this path states its dialect.
const PG = { dialect: 'pg' };
// Rows one step may write into a SOURCE MIRROR (core/dataEngine/sources): a
// source without a batch call takes them one at a time, so this bounds the
// step's duration where DATATABLE_MAX_LIMIT bounds a local transaction's
// size. The Nextcloud-era name is kept as an alias for whoever imports it.
const MIRROR_WRITE_MAX_PER_STEP = 200;
const NC_WRITE_MAX_PER_STEP = MIRROR_WRITE_MAX_PER_STEP;
// Statements one transaction may carry — pgAppEngine.batch refuses more.
// update_rows/delete_rows used to issue ONE exec per id: 801 round trips and
// 801 transactions for 800 rows, with bumpAfterWrite unreachable if the process
// died half way through.
const WRITE_CHUNK = 500;

function sources() {
    return require('../dataEngine/sources');
}

/** Does this datatable mirror an external source? (core/dataEngine/sources) */
function isMirror(table) {
    return sources().isSourceMirror(table);
}

/** The write-through of the table's own kind. */
function mirrorWrites(table) {
    return sources().writeThrough(table);
}

function mirrorCtx({ table, scope, scopeKey, tableMeta, grade, ctx }) {
    return mirrorWrites(table).contextOf({ table, scope, scopeKey, tableMeta, grade, viewerId: ctx.userId || null });
}

/**
 * @param {string} message
 * @param {string} errorClass
 */
function fail(message, errorClass) {
    const e = new Error(message);
    Object.assign(e, { errorClass });
    return e;
}

/**
 * A step-level skip, in the shape the runner already renders amber.
 * @param {string} reason
 * @param {string} message
 */
function skipped(reason, message, output) {
    return { output: { ...output, skipped: message }, skippedReason: reason };
}

/**
 * The zero-effect output for an op. A skip has to hand downstream the SAME
 * shape a real run would, or a `steps.x.output.rows` binding on the next step
 * resolves to nothing and the failure moves one node along.
 */
function emptyOutput(op) {
    if (op === 'update_rows') return { updated: 0, truncated: false };
    if (op === 'delete_rows') return { deleted: 0, truncated: false };
    if (op === 'add_row' || op === 'save_row') return { row: null, id: null, created: false, updated: 0 };
    if (op === 'count_rows') return { count: 0, found: false };
    // `count` is the DEPRECATED alias of `returned` — see the find_rows branch.
    return { rows: [], returned: 0, count: 0, found: false, hasMore: false, nextCursor: null };
}

module.exports = {
    PG, MIRROR_WRITE_MAX_PER_STEP, NC_WRITE_MAX_PER_STEP, WRITE_CHUNK,
    sources, isMirror, mirrorWrites, mirrorCtx, fail, skipped, emptyOutput,
};

/** @typedef {import('./datatableResolve').DatatableRow} DatatableRow */

/** @typedef {ReturnType<typeof import('../dataEngine/accessFilter').compileAccessFilter>} AccessPredicate */

/**
 * The step context `t` execDatatable builds and every helper of the step takes.
 * @typedef {import('./datatableResolve').ResolvedDatatable & {
 *   step: { values?: Record<string, unknown>, matchColumn?: string, [key: string]: unknown },
 *   ctx: { userId?: string, secretValues?: () => unknown, [key: string]: unknown },
 *   runState: import('../automationModel/bind').BindRunState, op: string, mode: string,
 *   filters: unknown[], match: 'any'|'all', accessAction: string,
 *   readFilter: AccessPredicate|null, writeFilter: AccessPredicate|null }} DatatableStepContext
 */
