// @typecheck strict
/**
 * The storage envelope for ONE datatable tenant, and the single check that
 * enforces it.
 *
 * ── WHY THESE ARE NOT dataModel/vocabulary's DATA_LIMITS ────────────
 * `DATA_LIMITS.MAX_TABLES_PER_APP` is named, documented and sized for ONE App
 * Studio app. Spending it as a per-organisation cap for datatables meant a
 * shared workspace and a single app answered to the same number for two
 * different questions, and neither could move without moving the other.
 * `MAX_ROWS_PER_APP` and `MAX_DB_BYTES` had the mirror problem: they were
 * declared and inert on this path, so one organisation could grow the shared
 * `beeflow_core` volume without bound — nothing anywhere read `size_bytes`.
 *
 * ── ONE CHECK, TWO CALLERS ──────────────────────────────────────────
 * routes/datatables.js and core/automationRunner/execDatatable.js both call
 * assertDatatableQuota. Two copies of the arithmetic is two things that can
 * disagree about whether a table is full, and the copy that says "no" is the
 * one nobody notices is missing: the row cap was enforced only on the manual
 * HTTP add, so a nightly automation wrote past it for as long as it liked.
 *
 * ── WHAT IS MEASURED, AND HOW FRESH IT IS ───────────────────────────
 * Rows come from `datatables.row_count` — maintained by arithmetic
 * (bumpAfterWrite) so a write never takes a lock, and re-synced against
 * COUNT(*) by jobs/datatableRetention. Bytes come from
 * `datatable_models.size_bytes`, which the same sweep refreshes from the live
 * schema size. Both are therefore approximate between sweeps, and deliberately
 * so: a live COUNT(*) or pg_total_relation_size on every row write would put a
 * full-table scan on the hot path to save a cap from being a few hundred rows
 * out.
 *
 * ── TWO TABLE COUNTS, ONE VOLUME ────────────────────────────────────
 * A spreadsheet in Documents keeps each tab's cells in a personal datatable
 * of the managed kind `document_sheet` (core/documents/sheetCells.js), made
 * by the document, never by a person in Studio → Datatables. Counting those
 * against the table cap meant a person who opened a handful of multi-tab
 * workbooks in chat could no longer start a spreadsheet, nor make a single
 * table of their own, and nothing they could see explained why. So the table
 * count is split: `maxTablesPerScope` counts the tables people make,
 * `maxSheetTablesPerScope` the tabs of spreadsheets. The VOLUME guard stays
 * one: rows and bytes count every table of the scope, sheets included, and a
 * new sheet tab is refused once the scope is over its byte limit (measured
 * live for a sheet, see core/dataEngine/provisionManagedTable).
 *
 * ── EVERY CAP IS AN ENVIRONMENT VARIABLE ────────────────────────────
 * Read on every call (so an operator's change needs no code, and a test can
 * set one for a single case), with a generous default; 0 means unlimited.
 * Documented in docs/docs/self-hosting/env.md.
 */

'use strict';
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

const MB = 1024 * 1024;

/**
 * The defaults, one per environment variable. Rows and bytes are per SCOPE
 * (an organisation, or one account's personal tables) because that is the
 * unit of storage: one Postgres schema, one model document, one row in
 * `datatable_models`.
 */
const DEFAULTS = Object.freeze({
    DATATABLE_MAX_TABLES_PER_SCOPE: 200,
    DATATABLE_MAX_SHEET_TABLES_PER_SCOPE: 2000,
    DATATABLE_MAX_ROWS_PER_TABLE: 100_000,
    DATATABLE_MAX_ROWS_PER_SCOPE: 500_000,
    DATATABLE_MAX_MB_PER_SCOPE: 256,
});

/**
 * A whole number >= 0 from the environment; unset, empty or garbage gives
 * the default (a typo must not silently mean "unlimited").
 * @param {keyof typeof DEFAULTS} name
 * @param {Record<string, string|undefined>} env
 */
function capFromEnv(name, env) {
    const raw = env[name];
    if (raw == null || String(raw).trim() === '') return DEFAULTS[name];
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULTS[name];
}

/**
 * The envelope as configured now. 0 = unlimited for every cap.
 * @param {Record<string, string|undefined>} [env]
 */
function datatableLimits(env = process.env) {
    return {
        maxTablesPerScope: capFromEnv('DATATABLE_MAX_TABLES_PER_SCOPE', env),
        maxSheetTablesPerScope: capFromEnv('DATATABLE_MAX_SHEET_TABLES_PER_SCOPE', env),
        maxRowsPerTable: capFromEnv('DATATABLE_MAX_ROWS_PER_TABLE', env),
        maxRowsPerScope: capFromEnv('DATATABLE_MAX_ROWS_PER_SCOPE', env),
        maxBytesPerScope: capFromEnv('DATATABLE_MAX_MB_PER_SCOPE', env) * MB,
    };
}

// Log an ops line from here on up, so a tenant that is about to be refused is
// visible BEFORE the refusal lands in somebody's nightly run. A cap that first
// speaks by breaking a working automation is a cap nobody could plan around.
const WARN_FRACTION = 0.9;

/**
 * The frozen quota refusal, copied from routes/studioAppData.js so a client
 * that handles one handles the other:
 *   409 { error, code:'quota_exceeded', limit, used }
 *
 * The sentence is a catalogue key (i18n/defaults/en/datatables.js), so it is
 * written once and translated: the message is the English text, and
 * `messageKey` / `messageVars` let localizeQuotaError put it in the reader's
 * language where the caller knows who that is.
 *
 * `errorClass` rides along for the runner, whose on_error branches match on
 * that rather than on an HTTP code — validate/constants.js promises authors a
 * datatable step "fails on … a quota", and until this existed it did not.
 * @param {string} key
 * @param {Record<string, string|number>} vars
 * @param {{ limit: number, used: number }} usage
 */
function quotaError(key, vars, { limit, used }) {
    const { GUI_DEFAULTS } = require('../../i18n/defaults/en');
    const { fill } = require('../../i18n/translate');
    /** @type {Error & Record<string, any>} */
    const e = new Error(fill(GUI_DEFAULTS[key] || key, vars));
    e.status = 409;
    e.code = 'quota_exceeded';
    // A refusal written for the reader: the terminal error handler passes the
    // code through with the message (a route that answers it itself does too).
    e.expose = true;
    e.errorClass = 'datatable_quota';
    e.limit = limit;
    e.used = used;
    e.messageKey = key;
    e.messageVars = vars;
    return e;
}

/**
 * Put a quota refusal in the language of the person who will read it (their
 * preferred locale). Anything else, or any failure to translate, is left as
 * it is: the English sentence already says what to do.
 * @param {any} err
 * @param {string|null|undefined} userId
 * @param {{ getUser?: (id: string) => Promise<any>, translate?: (locale: string, key: string, vars: object) => Promise<string> }} [deps]
 * @returns {Promise<any>} the same error
 */
async function localizeQuotaError(err, userId, deps = {}) {
    if (!err || err.code !== 'quota_exceeded' || !err.messageKey || !userId) return err;
    try {
        const getUser = deps.getUser || ((id) => require('../../stores/userStore').getUser(id));
        const locale = (await getUser(userId))?.preferredLocale || 'en';
        if (String(locale).toLowerCase().startsWith('en')) return err;
        const translate = deps.translate || require('../../i18n/translate').translate;
        const text = await translate(locale, err.messageKey, err.messageVars || {});
        if (text && text !== err.messageKey) err.message = text;
    } catch (e) {
        // The English sentence already says what to do.
        bestEffort('core/dataEngine/datatableLimits:localizeQuotaError', e);
    }
    return err;
}

/**
 * @param {string} what
 * @param {number} used
 * @param {number} limit  0 = unlimited (never warns)
 */
function warn(what, used, limit) {
    if (!limit || used < limit * WARN_FRACTION) return;
    log.warn(`[datatableLimits] ${what}: ${used} of ${limit} (${Math.round((used / limit) * 100)}%)`);
}

/** Is a cap on (> 0) and would `used + add` go past it? */
const over = (/** @type {number} */ used, /** @type {number} */ add, /** @type {number} */ limit) => limit > 0 && used + add > limit;

/** @typedef {{ tables?: number, sheetTables?: number, rows?: number, bytes?: number }} ScopeUsage  datatableStore.scopeUsage */
/** @typedef {{ id?: string, key?: string, name?: string, rowCount?: number }} QuotaTable  the `datatables` row a write goes to */

/**
 * Refuse a write that would take a tenant outside its envelope.
 *
 * @param {{kind:'org'|'user', id:string}} scope
 * @param {{ table?: QuotaTable|null, addRows?: number, addTables?: number, addSheetTables?: number,
 *   usage?: ScopeUsage|null }} [opts] `table`: the `datatables` row being written to, for the per-table
 *   row cap. Omit for a create; `addRows`: rows this operation would add (0 for an update or a delete —
 *   neither can overflow); `addTables`: tables a person (or their automation, app, link …) would add;
 *   `addSheetTables`: spreadsheet tabs a document would add (`document_sheet` tables), counted on their
 *   own cap — see the header; `usage`: pre-read usage, when the caller already holds it under a lock
 *   (createDatatable counts tables inside its own transaction, where the model row is FOR UPDATE-held —
 *   counting outside it let two replicas both see 49)
 * @throws a 409 quota error; returns the usage it read otherwise.
 * @returns {Promise<ScopeUsage>}
 */
async function assertDatatableQuota(scope, { table = null, addRows = 0, addTables = 0, addSheetTables = 0, usage = null } = {}) {
    // Lazily required, and only when the caller did not read the usage: this
    // module has to stay loadable in the runner suites that stub the stores,
    // and datatableStore opens a pg pool at load time.
    const used = usage || await require('../../stores/datatableStore').scopeUsage(scope);
    const L = datatableLimits();
    const usedTables = Number(used.tables) || 0;
    const usedSheets = Number(used.sheetTables) || 0;
    const usedRows = Number(used.rows) || 0;
    const usedBytes = Number(used.bytes) || 0;

    if (addTables > 0) {
        warn('tables in scope', usedTables, L.maxTablesPerScope);
        if (over(usedTables, addTables, L.maxTablesPerScope)) {
            throw quotaError(scope?.kind === 'user' ? 'datatables.quota_tables_user' : 'datatables.quota_tables_org',
                { used: usedTables, limit: L.maxTablesPerScope },
                { limit: L.maxTablesPerScope, used: usedTables });
        }
    }

    if (addSheetTables > 0) {
        warn('spreadsheet tabs in scope', usedSheets, L.maxSheetTablesPerScope);
        if (over(usedSheets, addSheetTables, L.maxSheetTablesPerScope)) {
            throw quotaError('datatables.quota_sheet_tabs',
                { used: usedSheets, limit: L.maxSheetTablesPerScope },
                { limit: L.maxSheetTablesPerScope, used: usedSheets });
        }
    }

    if (addRows > 0) {
        const rowsHere = Math.max(0, Number(table?.rowCount) || 0);
        warn(`rows in "${table?.key || table?.id || '?'}"`, rowsHere, L.maxRowsPerTable);
        if (over(rowsHere, addRows, L.maxRowsPerTable)) {
            throw quotaError('datatables.quota_rows_table',
                { name: table?.name || table?.key || 'this table', limit: L.maxRowsPerTable },
                { limit: L.maxRowsPerTable, used: rowsHere });
        }
        warn('rows in scope', usedRows, L.maxRowsPerScope);
        if (over(usedRows, addRows, L.maxRowsPerScope)) {
            throw quotaError('datatables.quota_rows_scope',
                { used: usedRows, limit: L.maxRowsPerScope },
                { limit: L.maxRowsPerScope, used: usedRows });
        }
    }

    // Bytes gate every WRITE, adds included — but never a read or a delete, so
    // emptying a table is how a tenant gets back under the ceiling.
    if ((addRows > 0 || addTables > 0 || addSheetTables > 0) && L.maxBytesPerScope > 0) {
        warn('bytes in scope', usedBytes, L.maxBytesPerScope);
        if (usedBytes >= L.maxBytesPerScope) {
            throw quotaError('datatables.quota_bytes',
                { limitMb: Math.round(L.maxBytesPerScope / MB) },
                { limit: L.maxBytesPerScope, used: usedBytes });
        }
    }

    return used;
}

module.exports = {
    DEFAULTS,
    datatableLimits,
    assertDatatableQuota,
    localizeQuotaError,
    quotaError,
    WARN_FRACTION,
};
