// @typecheck
'use strict';

/**
 * Characterisation (golden) test for syncConnector: for each scenario the
 * result or the thrown error (message, status, code), every call on its
 * dependencies in order with what it was given (the label-column step, the
 * claim, the connector run, the reply adoption, key lookups, deletes, record
 * writes, row counts, the thread labels, the retention purge, the finish and
 * the new-record hook) and the log lines. The clock stands still, so the next
 * run time, the duration and the retention cutoff are fixed.
 *
 * Scenarios reach each branch: no sync block, a missing table, a claim that
 * is taken (with and without force), upsert and replace, the three
 * incremental tiers with and without a stored watermark, a mailbox, grains
 * and child tables at several levels (missing table, missing grain, a parent
 * level that was not written), thread mode, the row cap, retention, the
 * hook on a first and a later run, a partial result and every failure path
 * (the error streak, a retry-after, a failing finish).
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test appStudio/connectorSync.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-01T10:00:00.000Z') });

const connectorSync = require('./connectorSync');

const GOLDEN = path.join(__dirname, 'connectorSync.characterisation.golden.json');

const app = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };

const EMAILS = {
    id: 'tbl_aaaaaa', key: 'emails', name: 'Emails',
    fields: [
        { key: 'ext_id', type: 'text', unique: true, sourcePath: 'id' },
        { key: 'subject', type: 'text', sourcePath: 'subject' },
        { key: 'received', type: 'datetime', sourcePath: 'receivedAt' },
        { key: 'unread', type: 'bool', sourcePath: 'unread' },
        { key: 'tags', type: 'multiselect', sourcePath: 'tags' },
    ],
};
const MESSAGES = {
    id: 'tbl_bbbbbb', key: 'messages', name: 'Messages',
    fields: [
        { key: 'emails_ref', type: 'relation', relation: { table: EMAILS.id } },
        { key: 'ext_id', type: 'text', unique: true, sourcePath: 'id' },
        { key: 'received_at', type: 'datetime', sourcePath: 'receivedAt' },
    ],
};
const FILES = {
    id: 'tbl_cccccc', key: 'files', name: 'Files',
    fields: [
        { key: 'messages_ref', type: 'relation', relation: { table: MESSAGES.id } },
        { key: 'ext_id', type: 'text', unique: true, sourcePath: 'id' },
        { key: 'filename', type: 'text', sourcePath: 'name' },
    ],
};
const MODEL = { modelVersion: 1, tables: [null, EMAILS, MESSAGES, FILES] };

/** @param {Record<string, unknown> | unknown} sync @param {Record<string, unknown>} [extra] */
const connector = (sync, extra = {}) => ({ id: 'conn_ab12cd', kind: 'integration_tool', name: 'Emails', tool: 'gmail_search', sync, ...extra });
/** @param {Record<string, unknown>} [over] */
const upsert = (over = {}) => ({ tableId: EMAILS.id, mode: 'upsert', keyField: 'id', ...over });
const CHILD_MESSAGES = { tableId: MESSAGES.id, level: 1, relationField: 'emails_ref', mode: 'upsert', keyField: 'id' };
const CHILD_FILES = { tableId: FILES.id, level: 2, parentLevel: 1, relationField: 'messages_ref', mode: 'upsert', keyField: 'id' };

const ROWS = [
    { id: 'm1', subject: 'Hi', receivedAt: '2026-02-01T08:00:00Z', unread: true, tags: ['a'] },
    { id: 'm2', subject: 'Yo', receivedAt: '2026-02-20T09:30:00Z', unread: 0 },
    { id: 'm3', subject: 'Old', receivedAt: '2026-01-05T00:00:00Z' },
];
const GRAINS = [
    { level: 0, rows: [{ id: 't1', subject: 'Thread one' }, { id: 't2', subject: 'Thread two' }] },
    { level: 1, rows: [
        { id: 'm1', receivedAt: '2026-02-01T08:00:00Z', _parentIndex: 0 },
        { id: 'm2', receivedAt: '2026-02-02T08:00:00Z', _parentIndex: 1 },
        { id: 'm3', receivedAt: '2026-02-03T08:00:00Z', _parentIndex: 7 },
    ] },
    { level: 2, rows: [{ id: 'f1', name: 'a.pdf', _parentIndex: 0 }, { id: 'f2', name: 'b.pdf', _parentIndex: 2 }, { id: 'f1', name: 'dup.pdf', _parentIndex: 1 }] },
];
const MAILBOX = { kind: 'mailbox', groupIntoThreads: true, onNewRecord: { action: 'act_1' } };
const CLAIMED = { watermark: '2026-02-10T00:00:00.000Z', lastRunAt: '2026-02-28T10:00:00.000Z', consecutiveErrors: 2 };

/**
 * name → { connector, model?, opts?, env }. env: claim (null = taken), result
 * (what the connector run answers) or runThrows, existing (key → record id),
 * and the per-dependency switches read in depsFor.
 * @type {Record<string, { connector: any, model?: any, opts?: Record<string, unknown>, env?: Record<string, any> }>}
 */
const CASES = {
    // what the connector fills
    noSyncBlock: { connector: connector(undefined) },
    syncBlockIsAList: { connector: connector([]) },
    noConnector: { connector: null },
    tableGone: { connector: connector(upsert({ tableId: 'tbl_gone' })) },
    noModel: { connector: connector(upsert()), model: null },
    labelStepReplacesTheModel: { connector: connector(upsert({ tableId: 'tbl_added' })), env: { addTable: { ...EMAILS, id: 'tbl_added', key: 'added' }, result: { rows: ROWS } } },
    // the claim
    claimTaken: { connector: connector(upsert()), env: { claim: null } },
    claimTakenWithReason: { connector: connector(upsert()), opts: { reason: 'view' }, env: { claim: null } },
    claimTakenForced: { connector: connector(upsert(), MAILBOX), opts: { force: true, reason: 'manual' }, env: { claim: null, result: { rows: ROWS } } },
    // writes
    upsertInsertsAndUpdates: { connector: connector(upsert()), env: { result: { rows: ROWS }, existing: { m2: 'rec_old_2' } } },
    upsertUnchangedRow: { connector: connector(upsert()), env: { result: { rows: ROWS }, existing: { m1: 'rec_old_1', m2: 'rec_old_2' }, noChanges: true } },
    upsertDuplicateKeys: { connector: connector(upsert()), env: { result: { rows: [ROWS[0], { id: 'm1', subject: 'Again' }, { subject: 'No key' }, ROWS[1], { id: 'm2' }] } } },
    upsertKeyColumnGone: { connector: connector(upsert({ keyField: 'nope' })), env: { result: { rows: ROWS } } },
    upsertByColumnKey: { connector: connector(upsert({ keyField: 'Subject' })), env: { result: { rows: ROWS } } },
    replaceRefills: { connector: connector({ tableId: EMAILS.id, mode: 'replace' }), env: { result: { rows: ROWS } } },
    replaceKeepsTheTableOnNoRows: { connector: connector({ tableId: EMAILS.id, mode: 'replace' }), env: { result: { rows: [] } } },
    noKeyFieldReplaces: { connector: connector({ tableId: EMAILS.id }), env: { result: { rows: ROWS } } },
    replaceRowCountFails: { connector: connector({ tableId: EMAILS.id, mode: 'replace' }), env: { result: { rows: ROWS }, setRowCountThrows: true } },
    replaceWithAKeyField: { connector: connector(upsert({ mode: 'replace' })), env: { result: { rows: ROWS }, existing: { m1: 'rec_old_1' } } },
    resultWithoutRows: { connector: connector(upsert()), env: { result: {} } },
    resultNothing: { connector: connector(upsert()), env: { result: null } },
    resultRowsNotAList: { connector: connector(upsert()), env: { result: { rows: 'x' } } },
    resultPartial: { connector: connector(upsert()), env: { result: { rows: ROWS, partial: true } } },
    resultPartialTruthy: { connector: connector(upsert()), env: { result: { rows: ROWS, partial: 'yes' } } },
    resultPartialFalse: { connector: connector(upsert()), env: { result: { rows: ROWS, partial: false } } },
    rowCap: { connector: connector(upsert()), env: { result: { rows: Array.from({ length: connectorSync.MAX_SYNC_ROWS + 3 }, (_, i) => ({ id: `r${i}` })) } } },
    // incremental tiers
    requestTier: { connector: connector(upsert({ incremental: { param: 'since', field: 'receivedAt' } })), env: { claim: CLAIMED, result: { rows: ROWS } } },
    requestTierUnix: { connector: connector(upsert({ incremental: { param: 'after', format: 'unix', field: 'receivedAt' } })), env: { claim: CLAIMED, result: { rows: ROWS } } },
    requestTierDate: { connector: connector(upsert({ incremental: { param: 'from', format: 'date' } })), env: { claim: CLAIMED, result: { rows: ROWS } } },
    requestTierFirstRun: { connector: connector(upsert({ incremental: { param: 'since', field: 'receivedAt' } })), env: { result: { rows: ROWS } } },
    requestTierUnreadableWatermark: { connector: connector(upsert({ incremental: { param: 'since', field: 'receivedAt' } })), env: { claim: { watermark: 'garbage' }, result: { rows: ROWS } } },
    clientTier: { connector: connector(upsert({ incremental: { field: 'receivedAt' } })), env: { claim: CLAIMED, result: { rows: [...ROWS, { id: 'm4', subject: 'No stamp' }] } } },
    clientTierFirstRun: { connector: connector(upsert({ incremental: { field: 'receivedAt' } })), env: { result: { rows: ROWS } } },
    clientTierAtTheWatermark: { connector: connector(upsert({ incremental: { field: 'receivedAt' } })), env: { claim: CLAIMED, result: { rows: [{ id: 'm5', receivedAt: CLAIMED.watermark }, { id: 'm6', receivedAt: '2026-02-10T00:00:00.001Z' }] } } },
    clientTierWithChildrenKeepsOldParents: { connector: connector(upsert({ incremental: { field: 'receivedAt' }, children: [CHILD_MESSAGES] })), env: { claim: CLAIMED, result: { grains: [{ level: 0, rows: [{ id: 't1', receivedAt: '2026-01-01T00:00:00Z' }, { id: 't2', receivedAt: '2026-02-25T00:00:00Z' }] }, GRAINS[1]] } } },
    clientTierWithChildrenWritesAll: { connector: connector(upsert({ incremental: { field: 'receivedAt' }, children: [CHILD_MESSAGES] })), env: { claim: CLAIMED, result: { rows: [], grains: GRAINS } } },
    clientTierMailboxWritesAll: { connector: connector(upsert({ incremental: { field: 'receivedAt' } }), { kind: 'mailbox' }), env: { claim: CLAIMED, result: { rows: ROWS } } },
    incrementalNotAnObject: { connector: connector(upsert({ incremental: 'receivedAt' })), env: { claim: CLAIMED, result: { rows: ROWS } } },
    // mailbox
    mailboxSince: { connector: connector(upsert({ incremental: { param: 'since', field: 'receivedAt' } }), { kind: 'mailbox' }), env: { claim: CLAIMED, result: { rows: ROWS } } },
    mailboxFirstRun: { connector: connector(upsert(), { kind: 'mailbox' }), env: { result: { rows: ROWS } } },
    mailboxSinceBesideItsOwnParam: { connector: connector(upsert({ incremental: { param: 'after', format: 'unix', field: 'receivedAt' } }), { kind: 'mailbox' }), env: { claim: CLAIMED, result: { rows: ROWS } } },
    mailboxAdoptionFails: { connector: connector(upsert(), { kind: 'mailbox' }), env: { adoptThrows: true, result: { rows: ROWS } } },
    // grains and child tables
    grainsPrimaryIsGrainZero: { connector: connector(upsert()), env: { result: { rows: ROWS, grains: GRAINS } } },
    grainsWithoutRows: { connector: connector(upsert()), env: { result: { rows: ROWS, grains: [{ level: 0 }] } } },
    grainsEmptyList: { connector: connector(upsert()), env: { result: { rows: ROWS, grains: [] } } },
    grainsNotAList: { connector: connector(upsert(), { kind: 'mailbox' }), env: { result: { rows: ROWS, grains: { 0: { rows: GRAINS[0].rows } } } } },
    childrenTwoLevels: { connector: connector(upsert({ children: [CHILD_FILES, CHILD_MESSAGES] })), env: { result: { grains: GRAINS }, existing: { m2: 'rec_old_m2' } } },
    childDefaultsToGrainZero: { connector: connector(upsert({ children: [{ ...CHILD_FILES, parentLevel: undefined, relationField: 'messages_ref' }] })), env: { result: { grains: GRAINS } } },
    childTableGone: { connector: connector(upsert({ children: [{ ...CHILD_MESSAGES, tableId: 'tbl_gone' }, CHILD_FILES] })), env: { result: { grains: GRAINS } } },
    childGrainMissing: { connector: connector(upsert({ children: [CHILD_MESSAGES, CHILD_FILES] })), env: { result: { grains: GRAINS.slice(0, 2) } } },
    childWithoutLevel: { connector: connector(upsert({ children: [{ tableId: MESSAGES.id, relationField: 'emails_ref', keyField: 'id' }] })), env: { result: { grains: GRAINS } } },
    childReplaceMode: { connector: connector(upsert({ children: [{ ...CHILD_MESSAGES, mode: 'replace' }] })), env: { result: { grains: GRAINS } } },
    childGrainWithoutRows: { connector: connector(upsert({ children: [CHILD_MESSAGES] })), env: { result: { grains: [GRAINS[0], { level: 1 }] } } },
    childrenNotAList: { connector: connector(upsert({ children: 'messages' })), env: { result: { rows: ROWS, grains: GRAINS } } },
    childrenWithoutGrains: { connector: connector(upsert({ children: [CHILD_MESSAGES] })), env: { result: { rows: ROWS } } },
    childKeyColumnGone: { connector: connector(upsert({ children: [{ ...CHILD_MESSAGES, keyField: 'nope' }] })), env: { claim: CLAIMED, result: { grains: GRAINS } } },
    // thread mode, labels, hook
    threadMode: { connector: connector(upsert({ children: [CHILD_MESSAGES, CHILD_FILES] }), MAILBOX), env: { claim: CLAIMED, result: { grains: GRAINS }, labels: 2, hook: { ran: 3 } } },
    threadModeNoChildren: { connector: connector(upsert(), MAILBOX), env: { claim: CLAIMED, result: { rows: ROWS }, hook: { ran: 1 } } },
    messageMode: { connector: connector(upsert(), { kind: 'mailbox', onNewRecord: { action: 'act_1' } }), env: { claim: CLAIMED, result: { rows: ROWS }, hook: { ran: 3 } } },
    messageModeWithChildren: { connector: connector(upsert({ children: [CHILD_MESSAGES] }), { kind: 'mailbox', onNewRecord: { action: 'act_1' } }), env: { claim: CLAIMED, result: { grains: GRAINS }, hook: { ran: 2 } } },
    hookNotOnFirstRun: { connector: connector(upsert(), MAILBOX), env: { claim: { watermark: null }, result: { rows: ROWS }, hook: { ran: 1 } } },
    hookOnlyForAMailbox: { connector: connector(upsert(), { onNewRecord: { action: 'act_1' } }), env: { claim: CLAIMED, result: { rows: ROWS }, hook: { ran: 1 } } },
    hookNotConfigured: { connector: connector(upsert(), { kind: 'mailbox' }), env: { claim: CLAIMED, result: { rows: ROWS }, hook: { ran: 1 } } },
    hookAnswersNothing: { connector: connector(upsert(), MAILBOX), env: { claim: CLAIMED, result: { rows: ROWS }, hook: null } },
    hookFails: { connector: connector(upsert(), MAILBOX), env: { claim: CLAIMED, result: { rows: ROWS }, hookThrows: true } },
    labelsCountAsUpdates: { connector: connector(upsert()), env: { result: { rows: ROWS }, labels: 4 } },
    // retention and the schedule
    retention: { connector: connector(upsert({ retentionDays: 30, incremental: { field: 'receivedAt' } })), env: { result: { rows: ROWS }, purgeChanges: 5 } },
    retentionNothingPurged: { connector: connector(upsert({ retentionDays: 30, incremental: { field: 'receivedAt' } })), env: { result: { rows: ROWS }, purgeChanges: 0 } },
    retentionUnreachable: { connector: connector(upsert({ retentionDays: 7 })), env: { result: { rows: ROWS } } },
    scheduleEveryMinutes: { connector: connector(upsert({ schedule: { everyMinutes: 240 } })), env: { result: { rows: ROWS } } },
    scheduleBelowTheFloor: { connector: connector(upsert({ schedule: { everyMinutes: 1 } })), env: { result: { rows: ROWS } } },
    scheduleMailboxFloor: { connector: connector(upsert({ schedule: { everyMinutes: 1 } }), { kind: 'mailbox' }), env: { result: { rows: ROWS } } },
    scheduleCron: { connector: connector(upsert({ schedule: { cron: '0 6 * * 1', tz: 'Europe/Amsterdam' } })), env: { result: { rows: ROWS } } },
    // failures
    runFails: { connector: connector(upsert()), env: { runThrows: new Error('not connected') } },
    runFailsOnAStreak: { connector: connector(upsert({ schedule: { everyMinutes: 30 } })), env: { claim: CLAIMED, runThrows: new Error('upstream 500') } },
    runFailsWithRetryAfter: { connector: connector(upsert(), { kind: 'mailbox' }), env: { claim: { consecutiveErrors: '3' }, runThrows: Object.assign(new Error('throttled'), { retryAfterMs: 7_200_000 }) } },
    runFailsCronIgnoredOnAStreak: { connector: connector(upsert({ schedule: { cron: '0 6 * * 1' } })), env: { runThrows: new Error('down') } },
    runFailsMailboxFloor: { connector: connector(upsert({ schedule: { everyMinutes: 1 } }), { kind: 'mailbox' }), env: { runThrows: new Error('down') } },
    runThrowsAString: { connector: connector(upsert()), env: { runThrows: 'plain text' } },
    runThrowsNothing: { connector: connector(upsert()), env: { runThrows: null } },
    runFailsForced: { connector: connector(upsert()), opts: { force: true }, env: { claim: null, runThrows: new Error('down') } },
    writeFails: { connector: connector(upsert()), env: { result: { rows: ROWS }, batchThrows: new Error('quota exceeded') } },
    finishFails: { connector: connector(upsert()), env: { result: { rows: ROWS }, finishThrows: 'ok' } },
    failureFinishFails: { connector: connector(upsert()), env: { runThrows: new Error('down'), finishThrows: 'error' } },
    labelsFail: { connector: connector(upsert()), env: { result: { rows: ROWS }, labelsThrow: true } },
};

/** @param {unknown} v */
const isTable = (v) => !!v && typeof v === 'object' && 'key' in v && Array.isArray(/** @type {{ fields?: unknown }} */ (v).fields);

/**
 * @param {Record<string, any>} env
 * @param {unknown[][]} calls
 */
function depsFor(env, calls) {
    /** @type {Record<string, any>} */
    const deps = {};
    // Whole objects by name: the app, a model as its table keys, a table as its key, the deps themselves.
    const brief = (/** @type {unknown} */ value) => JSON.parse(JSON.stringify(value === undefined ? '<undefined>' : value, function replacer(k, v) {
        if (v === undefined) return '<undefined>';
        if (v && typeof v === 'object' && typeof v.finishSync === 'function') return '<deps>'; // the merged copy the sync passes on
        if (v && typeof v === 'object' && v.id === app.id && v.userId === app.userId) return '<app>';
        if (v && typeof v === 'object' && Array.isArray(v.tables) && k !== '') return `<model ${v.tables.map((/** @type {any} */ t) => (t ? t.key : '-')).join(',')}>`;
        if (isTable(v) && k !== '') return `<table ${v.key}>`;
        if (typeof v === 'function') return '<function>';
        if (v instanceof Error) return `<Error ${v.message}>`;
        return v;
    }));
    const record = (/** @type {string} */ name, /** @type {unknown[]} */ ...args) => {
        const shown = brief([null, ...args]).slice(1);
        calls.push([name, ...shown.map((/** @type {unknown} */ a) => (Array.isArray(a) && a.length > 12 ? [`<${a.length} items>`, ...a.slice(0, 2)] : a))]);
    };
    const store = new Map(Object.entries(env.existing || {}));
    let nextId = 0;
    Object.assign(deps, {
        ensureLabelColumns: async (/** @type {any} */ a, /** @type {any} */ model, /** @type {any} */ c, /** @type {any} */ d) => {
            record('ensureLabelColumns', a, model, c && c.id, d);
            return env.addTable ? { ...model, tables: [...model.tables, env.addTable] } : model;
        },
        claimSync: async (/** @type {unknown[]} */ ...a) => { record('claimSync', ...a); return 'claim' in env ? env.claim : { watermark: null }; },
        runConnector: async (/** @type {any} */ c, /** @type {any} */ opts) => {
            record('runConnector', c.id, opts);
            if ('runThrows' in env) throw env.runThrows;
            return env.result;
        },
        adoptRecordedReplies: async (/** @type {any} */ a, /** @type {any} */ m, /** @type {any} */ c, /** @type {any} */ grains, /** @type {any} */ d) => {
            record('adoptRecordedReplies', a, m, c.id, grains ? grains.length : grains, d);
            if (env.adoptThrows) throw new Error('adoption failed');
        },
        compileKeyIndex: (/** @type {any} */ t, /** @type {string} */ column, /** @type {string[]} */ keys) => { record('compileKeyIndex', t, column, keys); return { sql: `KEYS ${t.key}`, params: keys }; },
        compileDeleteAll: (/** @type {any} */ t, /** @type {unknown} */ filter) => { record('compileDeleteAll', t, filter); return { sql: `DELETE ${t.key}`, params: [] }; },
        query: async (/** @type {string} */ o, /** @type {string} */ a, /** @type {string} */ sql, /** @type {string[]} */ keys) => {
            record('query', o, a, sql, keys);
            if (!sql.startsWith('KEYS')) return { rows: [] };
            return { rows: (keys || []).filter((k) => store.has(String(k))).map((k) => ({ id: store.get(String(k)), k })) };
        },
        exec: async (/** @type {unknown[]} */ ...a) => { record('exec', ...a); store.clear(); return { changes: 0 }; },
        writeRecordBatch: async (/** @type {any} */ a, /** @type {any} */ m, /** @type {any} */ t, /** @type {any[]} */ rows, /** @type {any} */ opts) => {
            record('writeRecordBatch', a, m, t, rows, opts);
            if (env.batchThrows) throw env.batchThrows;
            const ids = rows.map(() => `rec_${nextId++}`);
            rows.forEach((r, i) => { if (r.ext_id !== undefined && r.ext_id !== null) store.set(String(r.ext_id), ids[i]); });
            return ids;
        },
        writeRecord: async (/** @type {any} */ a, /** @type {any} */ m, /** @type {any} */ t, /** @type {any} */ values, /** @type {any} */ opts) => {
            record('writeRecord', a, m, t, values, opts);
            return { id: opts.recordId, changes: env.noChanges ? 0 : 1 };
        },
        setRowCount: async (/** @type {unknown[]} */ ...a) => { record('setRowCount', ...a); if (env.setRowCountThrows) throw new Error('count failed'); },
        refreshThreadLabels: async (/** @type {any} */ a, /** @type {any} */ m, /** @type {any} */ c, /** @type {any} */ ids, /** @type {any} */ d) => {
            record('refreshThreadLabels', a, m, c.id, ids, d);
            if (env.labelsThrow) throw new Error('labels failed');
            return env.labels || 0;
        },
        batch: async (/** @type {string} */ o, /** @type {string} */ a, /** @type {any[]} */ stmts) => { record('batch', o, a, stmts); return stmts.map(() => ({ changes: env.purgeChanges || 0, rows: [] })); },
        finishSync: async (/** @type {string} */ a, /** @type {string} */ c, /** @type {any} */ state) => {
            record('finishSync', a, c, state);
            if (env.finishThrows === state.status) throw new Error(`finish ${state.status} failed`);
        },
        runNewRecordHook: async (/** @type {any} */ a, /** @type {any} */ m, /** @type {any} */ c, /** @type {any} */ news) => {
            record('runNewRecordHook', a, m, c.id, news);
            if (env.hookThrows) throw new Error('hook failed');
            return env.hook;
        },
    });
    // The retention purge compiles its statements through the deps: each compiler answers a named statement.
    for (const name of ['compileDeleteOlderThan', 'compileDeleteOrphans', 'compileDoomedUnderParent', 'compileRetentionDelete']) {
        deps[name] = (/** @type {unknown[]} */ ...a) => { record(name, ...a); return { sql: name, params: [] }; };
    }
    for (const name of ['getSyncState', 'bumpDataVersion', 'listAttachments', 'deleteAttachment', 'deleteFile', 'buildAttachmentKey']) {
        deps[name] = async (/** @type {unknown[]} */ ...a) => { record(name, ...a); return []; };
    }
    return deps;
}

/** @param {string} name */
async function runCase(name) {
    const c = CASES[name];
    /** @type {unknown[][]} */
    const calls = [];
    const _deps = depsFor(c.env || {}, calls);
    const firstLine = (/** @type {unknown[]} */ args) => args.map((a) => (a instanceof Error ? `<Error ${a.message}>` : String(a).split('\n')[0])).join(' ');
    const original = { warn: console.warn, error: console.error };
    // The sync's own lines only: a swallowed failure is logged at most once per label per interval, so not every time.
    const own = (/** @type {string} */ level) => (/** @type {unknown[]} */ ...a) => { if (String(a[0]).startsWith('[ConnectorSync]')) calls.push([level, firstLine(a)]); };
    console.warn = own('console.warn');
    console.error = own('console.error');
    try {
        const result = await connectorSync.syncConnector(app, 'model' in c ? c.model : MODEL, c.connector, { ...(c.opts || {}), _deps });
        return { result, calls };
    } catch (err) {
        const e = /** @type {any} */ (err);
        const threw = e instanceof Error
            ? { message: e.message, ...(e.status ? { status: e.status } : {}), ...(e.code ? { code: e.code } : {}) }
            : { value: e === undefined ? '<undefined>' : e };
        return { threw, calls };
    } finally {
        Object.assign(console, original);
    }
}

test('syncConnector: result, dependency calls and log lines per scenario match the golden file', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const name of Object.keys(CASES)) actual[name] = await runCase(name);
    const text = `${JSON.stringify(actual, null, 1)}\n`;
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, text);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const name of Object.keys(CASES)) {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(actual[name])), golden[name], `scenario ${name}`);
    }
    assert.deepStrictEqual(Object.keys(golden), Object.keys(CASES));
});
