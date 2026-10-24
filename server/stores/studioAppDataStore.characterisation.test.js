/**
 * The golden behaviour of studioAppDataStore, pinned before it was split into
 * stores/studioAppData/* modules behind the `studioAppDataStore` barrel.
 *
 * `../db`, the per-app engine (`./studioAppDbStore`), `./studioAppStore` (the
 * FK parent's ready handle) and `./managedPartsDefault` are preloaded under
 * their REAL paths, so every module that requires them, whatever relative
 * string it uses, gets the double. The db double records every statement IN
 * ORDER across the helper functions, the transaction client and the boot DDL.
 * What is pinned: the exported keys and their types, the boot DDL, and per
 * main path (data model CAS, row counts, datasets + cache, connector sync,
 * e-mail ledger, members, attachments) the trace and the value handed back.
 * A pure move must leave every one of them as is.
 *
 * Regenerate (only for an intended behaviour change):
 *   UPDATE_GOLDEN=1 node --test stores/studioAppDataStore.characterisation.test.js
 * Run: cd server && node --test stores/studioAppDataStore.characterisation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { withTransactionVia } = require('../testUtils/txFake');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createRecordingDb } = require('../testUtils/mockDb');
const { preloadStubs } = require('../testUtils/stubRequire');

process.env.NODE_ENV = 'test';
delete process.env.STUDIO_APP_ENGINE;

const GOLDEN = path.join(__dirname, 'studioAppDataStore.characterisation.golden.json');
const TRACE = [];
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const NOW = Date.parse('2026-03-01T12:00:00.000Z');

// ── Fixtures ─────────────────────────────────────────────────────────
const T = '2026-01-01T00:00:00.000Z';
const MODEL = {
    modelVersion: 1,
    tables: [{
        id: 'tbl_aaaaaa', key: 'people', name: 'People', icon: null,
        fields: [{ id: 'fld_aaaaaa', key: 'title', type: 'text', required: false, unique: false }],
        access: { default: 'app', roles: {}, rowFilters: {} },
    }],
    roles: [], roleMapping: { default: 'app', byGroup: {} },
};
const tables = {
    studio_app_dataset_cache: [
        { id: 'c-1', dataset_id: 'ds-1', viewer_scope_key: 'v', params_hash: 'p', data_version: 2, result: '{"rows":[1]}', row_count: 1, computed_at: T, expires_at: '2026-12-01T00:00:00.000Z' },
        { id: 'c-2', dataset_id: 'ds-1', viewer_scope_key: 'old', params_hash: 'p', data_version: 2, result: '{}', row_count: 0, computed_at: T, expires_at: '2026-02-01T00:00:00.000Z' },
    ],
    studio_app_datasets: [
        { id: 'ds-1', app_id: 'app-1', owner_user_id: 'u1', name: 'DS', table_id: 'tbl_aaaaaa', source: '{"t":1}', descriptor: '{"d":1}', cache_ttl_seconds: 30, created_at: T, updated_at: T },
    ],
    studio_app_data_meta: [
        { app_id: 'app-1', owner_user_id: 'u1', model: JSON.stringify(MODEL), model_version: 3, data_versions: '{"people":4}', row_counts: '{"people":7,"gone":2}', created_at: T, updated_at: T },
    ],
    studio_app_members: [
        { app_id: 'app-1', user_id: 'm1', role_key: 'editor', created_at: T },
    ],
    studio_app_attachments: [
        { id: 'att-1', app_id: 'app-1', owner_user_id: 'u1', record_id: 'r1', field_key: 'f', mime_type: 'image/png', sha256: 'aa', size: '12', scanned: 't', quarantined: false, created_at: T, updated_at: T },
        { id: 'att-2', app_id: 'app-1', owner_user_id: 'u1', record_id: null, field_key: null, mime_type: 'text/plain', sha256: 'aa', size: 3, scanned: false, quarantined: true, created_at: T, updated_at: T },
    ],
    studio_app_connector_sync: [
        { app_id: 'app-1', connector_id: 'con-1', owner_user_id: 'u1', table_key: 'people', status: 'ok', last_run_at: T, next_run_at: T, started_at: null, watermark: 'w1', rows_written: '5', last_error: null, consecutive_errors: 1 },
    ],
    studio_app_email_log: [
        { id: 9, app_id: 'app-1', connector_id: 'con-1', viewer_user_id: 'u1', effective_user_id: 'u2', to_masked: 'a***@x', subject: 'Hi', provider_message_id: 'pm', thread_key: null, dlp_outcome: 'pass', sent_at: T },
    ],
    studio_apps: [
        { id: 'app-1', user_id: 'u1', project_id: null },
        { id: 'app-2', user_id: 'u2', project_id: 'p1' },
    ],
};
const seed = JSON.parse(JSON.stringify(tables));
const mock = createRecordingDb({ tables });
function restoreSeed() {
    for (const k of Object.keys(seed)) {
        tables[k].length = 0;
        for (const r of JSON.parse(JSON.stringify(seed[k]))) tables[k].push(r);
    }
}

const rec = (ch) => async (sql, params = []) => {
    TRACE.push({ ch, sql: norm(sql), params: JSON.parse(JSON.stringify(params ?? null)) });
    return mock.dispatch(String(sql), params);
};
const client = {
    query: rec('tx'),
    release() { TRACE.push({ ch: 'release' }); },
};
const db = {
    run: rec('run'),
    getOne: async (sql, params) => (await rec('getOne')(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rec('getAll')(sql, params)).rows,
    exec: async (sql) => { TRACE.push({ ch: 'exec', sql: norm(sql) }); },
    getClient: async () => { TRACE.push({ ch: 'getClient' }); return client; },
    withTransaction: (fn) => withTransactionVia(() => db.getClient())(fn),
    makeStoreInit: mock.db.makeStoreInit,
    pool: { connect: async () => client },
};

const note = (name, ret) => async (...args) => {
    TRACE.push({ ch: 'dep', name, args: JSON.parse(JSON.stringify(args, (k, v) => (k === 'client' ? '<client>' : v))) });
    return typeof ret === 'function' ? ret(...args) : ret;
};
let schemaStamp = 0;
let failMigration = false;
preloadStubs(require, {
    '../db': db,
    './studioAppDbStore': {
        applyMigration: note('applyMigration', () => {
            if (failMigration) throw new Error('migration boom');
            return { applied: 0 };
        }),
        getSchemaStamp: note('getSchemaStamp', () => schemaStamp),
        query: note('query', (_o, _a, sql) => {
            if (/"people"/.test(sql)) return { rows: [{ n: '11' }] };
            throw new Error('no such table');
        }),
    },
    './studioAppStore': { ready: Promise.resolve() },
    './managedPartsDefault': {
        assertManagedWrite: note('assertManagedWrite', ({ projectId }) => (projectId ? { managed: true, via: 'capability' } : { managed: false })),
    },
});

let uuidN = 0;
const realUUID = crypto.randomUUID;
const realNow = Date.now;
crypto.randomUUID = () => `uuid-${++uuidN}`;
Date.now = () => NOW;
test.after(() => { crypto.randomUUID = realUUID; Date.now = realNow; });

const store = require('./studioAppDataStore');

const results = {};
async function capture(name, fn) {
    restoreSeed();
    TRACE.length = 0;
    uuidN = 0;
    let value;
    try {
        value = await fn();
    } catch (e) {
        value = { threw: e.message, code: e.code || null, status: e.status || e.statusCode || null };
    }
    results[name] = { value: value === undefined ? '<undefined>' : JSON.parse(JSON.stringify(value)), trace: [...TRACE] };
}

test('studioAppDataStore golden behaviour', async () => {
    TRACE.length = 0;
    await store.initDB();
    results.boot = TRACE.filter((t) => t.ch === 'exec').map((t) => t.sql);
    results.bootSame = store.ready === store.initDB();

    results.exports = Object.fromEntries(Object.keys(store).map((k) => {
        const d = Object.getOwnPropertyDescriptor(store, k);
        return [k, d.get ? 'getter' : typeof d.value];
    }));
    results.constants = { SYNC_STALE_MS: store.SYNC_STALE_MS };

    // Data model
    await capture('getDataModel', () => store.getDataModel('app-1', 'u1'));
    await capture('getDataModel.foreign', () => store.getDataModel('app-1', 'u2'));
    schemaStamp = 5;
    await capture('getDataModel.reconcileDrift', () => store.getDataModel('app-1', 'u1', { reconcile: true }));
    schemaStamp = 0;
    await capture('reconcileDataModel.clean', () => store.reconcileDataModel('app-1', 'u1'));
    await capture('reconcileDataModel.notFound', () => store.reconcileDataModel('app-9', 'u1'));
    await capture('saveDataModel', () => store.saveDataModel('app-1', 'u1', MODEL, { expectedVersion: 3 }));
    await capture('saveDataModel.conflict', () => store.saveDataModel('app-1', 'u1', MODEL, { expectedVersion: 1 }));
    await capture('saveDataModel.invalid', () => store.saveDataModel('app-1', 'u1', { tables: 'x' }));
    await capture('saveDataModel.foreignMeta', () => store.saveDataModel('app-1', 'u2', MODEL));
    await capture('saveDataModel.newMeta', () => store.saveDataModel('app-2', 'u2', MODEL));
    await capture('saveDataModel.notAdditive', () => store.saveDataModel('app-1', 'u1', { ...MODEL, tables: [] }, { additiveOnly: true }));
    failMigration = true;
    await capture('saveDataModel.migrationThrows', () => store.saveDataModel('app-1', 'u1', MODEL));
    failMigration = false;
    results.additiveModel = {
        drop: store.additiveModel(MODEL, { ...MODEL, tables: [] }),
        addField: store.additiveModel(MODEL, { ...MODEL, tables: [{ ...MODEL.tables[0], fields: [...MODEL.tables[0].fields, { id: 'fld_bbbbbb', key: 'age', type: 'number', required: false, unique: false }] }] }),
    };
    await capture('makeDataModelSaver', async () => {
        const saver = store.makeDataModelSaver({
            getClient: () => db.getClient(),
            applyMigration: note('io.applyMigration', { applied: 1 }),
            isPg: () => true,
            recountRows: note('io.recountRows', null),
            managedParts: { assertManagedWrite: note('io.assertManagedWrite', { managed: false }) },
        });
        return saver.saveDataModel('app-1', 'u1', MODEL);
    });
    await capture('bumpDataVersion', () => store.bumpDataVersion('app-1', 'people', 'u1'));
    await capture('bumpDataVersion.foreign', () => store.bumpDataVersion('app-1', 'people', 'u2'));
    await capture('getRowCounts', () => store.getRowCounts('app-1', 'u1'));
    await capture('getRowCounts.none', () => store.getRowCounts('app-9', 'u1'));
    await capture('setRowCount', () => store.setRowCount('app-1', 'people', '-4', 'u1'));
    await capture('bumpRowCount', () => store.bumpRowCount('app-1', 'people', -10, 'u1'));
    await capture('recountRows', () => store.recountRows('app-1', 'u1', [{ key: 'people' }, { key: 'missing' }, null, { key: '' }]));
    // Datasets + cache
    await capture('createDataset', () => store.createDataset('app-1', 'u1', { name: 'N', tableId: 't', source: { a: 1 }, cacheTtlSeconds: 5 }));
    await capture('createDataset.missing', () => store.createDataset('', 'u1'));
    await capture('listDatasets', () => store.listDatasets('app-1', 'u1'));
    await capture('getDataset', () => store.getDataset('ds-1', 'app-1', 'u1'));
    await capture('updateDataset', () => store.updateDataset('ds-1', 'app-1', 'u1', { name: 'X', tableId: '', cacheTtlSeconds: 'x' }));
    await capture('updateDataset.noop', () => store.updateDataset('ds-1', 'app-1', 'u1', { bogus: 1 }));
    await capture('deleteDataset', () => store.deleteDataset('ds-1', 'app-1', 'u1'));
    await capture('deleteDataset.foreign', () => store.deleteDataset('ds-1', 'app-1', 'u2'));
    await capture('getCache', () => store.getCache('ds-1', 'v', 'p', '2'));
    await capture('getCache.expired', () => store.getCache('ds-1', 'old', 'p', 2));
    await capture('putCache', () => store.putCache('ds-1', { viewerScopeKey: 'v', paramsHash: 'p', dataVersion: 3, result: { r: 1 }, rowCount: 1, ttlSeconds: 10 }));
    await capture('invalidateCache', () => store.invalidateCache('ds-1'));
    // Connector sync + e-mail ledger
    await capture('getSyncState', () => store.getSyncState('app-1', 'con-1'));
    await capture('listSyncStates', () => store.listSyncStates('app-1'));
    await capture('claimSync', () => store.claimSync('app-1', 'con-1', 'u1', { tableKey: 'people' }));
    await capture('finishSync', () => store.finishSync('app-1', 'con-1', { status: 'error', watermark: 'w2', rowsWritten: '3', error: 'x'.repeat(600), consecutiveErrors: 2 }));
    await capture('finishSync.ok', () => store.finishSync('app-1', 'con-1', { status: 'done', nextRunAt: '2026-03-02T00:00:00.000Z' }));
    await capture('listDueSyncs', () => store.listDueSyncs(999));
    await capture('deleteSyncState', () => store.deleteSyncState('app-1', 'con-1'));
    await capture('reconcileSyncStates', () => store.reconcileSyncStates('app-1', 'u1', ['con-1', 'con-2', 'con-1', '', 3]));
    await capture('reconcileSyncStates.none', () => store.reconcileSyncStates('app-1', 'u1'));
    await capture('logEmailSend', () => store.logEmailSend({ appId: 'app-1', connectorId: 'con-1', viewerUserId: 'u1', subject: 'S' }));
    await capture('listEmailSends', () => store.listEmailSends('app-1', { limit: 9999 }));
    // Members
    await capture('addMember.update', () => store.addMember('app-1', 'u1', 'm1', 'viewer'));
    await capture('addMember.insert', () => store.addMember('app-1', 'u1', 'm2'));
    await capture('addMember.foreign', () => store.addMember('app-1', 'u2', 'm2'));
    await capture('listMembers', () => store.listMembers('app-1', 'u1'));
    await capture('listMembers.foreign', () => store.listMembers('app-1', 'u2'));
    await capture('removeMember', () => store.removeMember('app-1', 'u1', 'm1'));
    await capture('getMemberRole', () => store.getMemberRole('app-1', 'm1'));
    // Attachments
    await capture('addAttachment', () => store.addAttachment('app-1', 'u1', { recordId: 'r1', size: 4 }));
    await capture('addAttachment.missing', () => store.addAttachment('app-1', ''));
    await capture('listAttachments', () => store.listAttachments('app-1', 'u1'));
    await capture('listAttachments.record', () => store.listAttachments('app-1', 'u1', { recordId: 'r1' }));
    await capture('getAttachment', () => store.getAttachment('att-1', 'app-1', 'u1'));
    await capture('setAttachmentScan', () => store.setAttachmentScan('att-1', 'app-1', 'u1', { scanned: 1, quarantined: 0 }));
    await capture('setAttachmentScan.noop', () => store.setAttachmentScan('att-1', 'app-1', 'u1'));
    await capture('deleteAttachment', () => store.deleteAttachment('att-1', 'app-1', 'u1'));
    await capture('deleteAttachment.foreign', () => store.deleteAttachment('att-1', 'app-1', 'u2'));
    await capture('countAttachments', () => store.countAttachments('app-1', 'u1'));
    await capture('countAttachmentsBySha', () => store.countAttachmentsBySha('app-1', 'u1', 'aa'));
    await capture('countAttachmentsBySha.empty', () => store.countAttachmentsBySha('app-1', 'u1', ''));

    if (process.env.UPDATE_GOLDEN === '1') {
        fs.writeFileSync(GOLDEN, JSON.stringify(results, null, 1) + '\n');
        return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const key of Object.keys(golden)) {
        assert.deepStrictEqual(results[key], golden[key], `golden mismatch in ${key}`);
    }
    assert.deepStrictEqual(Object.keys(results).sort(), Object.keys(golden).sort());
});
