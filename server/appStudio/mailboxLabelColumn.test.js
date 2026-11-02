/**
 * An Outlook mailbox's tables get a `labels` column before the sync writes
 * categories into them; additive, version-checked, never fatal.
 *
 * Run: cd server && node --test appStudio/mailboxLabelColumn.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { ensureLabelColumns, labelTableIds } = require('./mailboxLabelColumn.mts');

const APP = { id: 'app_1', userId: 'u1' };
const column = (name, extra = {}) => ({ id: `fld_${name}`, key: name, name, type: 'text', ...extra });
const MODEL = {
    modelVersion: 1,
    tables: [
        { id: 'tbl_thr', key: 'threads', fields: [column('thread_key'), column('status')] },
        { id: 'tbl_msg', key: 'messages', fields: [column('provider_message_id')] },
        { id: 'tbl_att', key: 'attachments', fields: [column('provider_attachment_id')] },
    ],
};
const CONNECTOR = {
    kind: 'mailbox', provider: 'outlook', groupIntoThreads: true,
    sync: { tableId: 'tbl_thr', children: [{ tableId: 'tbl_msg', level: 1 }, { tableId: 'tbl_att', level: 2 }] },
};

function store({ model = MODEL, version = 7, save = async () => ({ ok: true }) } = {}) {
    const calls = { get: 0, saves: [] };
    return {
        calls,
        deps: {
            getDataModel: async () => { calls.get += 1; return { model, modelVersion: version }; },
            saveDataModel: async (...a) => { calls.saves.push(a); return save(...a); },
        },
    };
}

const labelsOf = (model, tableId) => model.tables.find((t) => t.id === tableId).fields.filter((c) => c.key === 'labels');

test('thread mode: conversations and messages get the column, attachments do not', async () => {
    const s = store();
    const out = await ensureLabelColumns(APP, MODEL, CONNECTOR, s.deps);
    assert.strictEqual(s.calls.saves.length, 1);
    const [appId, ownerId, saved, opts] = s.calls.saves[0];
    assert.deepStrictEqual([appId, ownerId], ['app_1', 'u1']);
    assert.deepStrictEqual(opts, { expectedVersion: 7, additiveOnly: true });
    assert.strictEqual(saved, out);
    assert.strictEqual(labelsOf(out, 'tbl_thr').length, 1);
    assert.strictEqual(labelsOf(out, 'tbl_msg').length, 1);
    assert.strictEqual(labelsOf(out, 'tbl_att').length, 0);
    assert.match(labelsOf(out, 'tbl_thr')[0].id, /^fld_[0-9a-f]{6}$/);
    assert.strictEqual(labelsOf(out, 'tbl_thr')[0].type, 'text');
    assert.strictEqual(labelsOf(MODEL, 'tbl_thr').length, 0, 'the model passed in is not mutated');
});

test('flat mode labels only the message table', () => {
    const flat = { ...CONNECTOR, groupIntoThreads: false, sync: { tableId: 'tbl_msg', children: [{ tableId: 'tbl_att', level: 1 }] } };
    assert.deepStrictEqual(labelTableIds(flat), ['tbl_msg']);
});

test('Gmail and other connector kinds are left alone, without reading the store', async () => {
    const s = store();
    assert.strictEqual(await ensureLabelColumns(APP, MODEL, { ...CONNECTOR, provider: 'gmail' }, s.deps), MODEL);
    assert.strictEqual(await ensureLabelColumns(APP, MODEL, { kind: 'integration_tool', sync: { tableId: 'tbl_thr' } }, s.deps), MODEL);
    assert.strictEqual(s.calls.get, 0);
});

test('a table that already has the column, by key or by source path, is not touched', async () => {
    const model = { ...MODEL, tables: [
        { id: 'tbl_thr', fields: [column('labels')] },
        { id: 'tbl_msg', fields: [column('categorieen', { sourcePath: 'labels' })] },
    ] };
    const s = store({ model });
    assert.strictEqual(await ensureLabelColumns(APP, model, CONNECTOR, s.deps), model);
    assert.strictEqual(s.calls.get, 0);
});

test('added meanwhile: the stored model is returned and nothing is saved', async () => {
    const stored = { ...MODEL, tables: MODEL.tables.map((t) => ({ ...t, fields: [...t.fields, column('labels')] })) };
    const s = store({ model: stored });
    assert.strictEqual(await ensureLabelColumns(APP, MODEL, CONNECTOR, s.deps), stored);
    assert.strictEqual(s.calls.saves.length, 0);
});

test('the sync writes into the column it just added, in the same run', async () => {
    const connectorSync = require('./connectorSync');
    const flat = { id: 'conn_mb0001', kind: 'mailbox', provider: 'outlook', sync: { tableId: 'tbl_msg', mode: 'upsert', keyField: 'provider_message_id' } };
    const inserted = [];
    const s = store();
    await connectorSync.syncConnector({ id: 'app_1', userId: 'u1' }, MODEL, flat, { _deps: {
        ...s.deps,
        ensureLabelColumns: (app, model, conn) => ensureLabelColumns(app, model, conn, s.deps),
        runConnector: async () => ({ rows: [{ provider_message_id: 'AAMk-1', labels: 'Daniel' }] }),
        adoptRecordedReplies: async () => {},
        claimSync: async () => ({ watermark: null }),
        finishSync: async () => {},
        compileKeyIndex: () => ({ sql: 'SELECT', params: [] }),
        query: async () => ({ rows: [] }),
        writeRecordBatch: async (_a, _m, _t, rows) => { inserted.push(...rows); return rows.map((_, i) => `rec_${i}`); },
        bumpDataVersion: async () => {},
    } });
    assert.deepStrictEqual(inserted, [{ provider_message_id: 'AAMk-1', labels: 'Daniel' }]);
});

test('a refused or failing save keeps the old model and never throws', async () => {
    const conflict = store({ save: async () => ({ ok: false, conflict: true }) });
    assert.strictEqual(await ensureLabelColumns(APP, MODEL, CONNECTOR, conflict.deps), MODEL);

    const managed = store({ save: async () => { throw Object.assign(new Error('managed_part'), { status: 409 }); } });
    assert.strictEqual(await ensureLabelColumns(APP, MODEL, CONNECTOR, managed.deps), MODEL);

    const broken = store({ save: async () => { throw new Error('db down'); } });
    assert.strictEqual(await ensureLabelColumns(APP, MODEL, CONNECTOR, broken.deps), MODEL);
});
