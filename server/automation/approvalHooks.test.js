/**
 * on_decided hook — template resolution + the commit-first contract.
 *
 * The store facades and the writeRecord choke point are monkey-patched: what
 * is pinned here is (1) the template language the snapshot's `set` maps use,
 * (2) that the hook only fires for its own outcome, and (3) that a hook
 * failure is AUDITED and never thrown — the decision must already stand.
 *
 * Run: node --test automation/approvalHooks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const automationStore = require('../stores/automationStore');
const studioAppStore = require('../stores/studioAppStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const actionExecutor = require('../appStudio/actionExecutor');
const notificationStore = require('../stores/notificationStore');
const { runOnDecidedHook, _hooksTest } = require('./approvalHooks');
const { resolveTemplate, hookScope } = _hooksTest;

const ROW = {
    id: 'apr_1', status: 'approved', studioAppId: 'app_7', ownerId: 'owner',
    prompt: 'Approve the quote?', decisionReason: 'Looks good', decidedBy: 'u2',
    decidedByName: 'Fleur', decidedAt: '2026-08-22T10:00:00Z', requestedBy: 'u3',
    answers: { po: '4471', urgent: true }, context: { recordId: 'rec_9', kind: 'quote' },
    onDecided: { tableId: 'tbl_q', recordId: 'rec_9', set: { approved: { status: 'goedgekeurd', po_number: '{{answers.po}}', by: '{{decidedByName}}' } } },
};

test('an exact {{path}} keeps the raw type; mixed strings interpolate as text', () => {
    const scope = hookScope(ROW);
    assert.strictEqual(resolveTemplate('{{answers.urgent}}', scope), true);
    assert.strictEqual(resolveTemplate('{{answers.po}}', scope), '4471');
    assert.strictEqual(resolveTemplate('PO {{answers.po}} — {{decidedByName}}', scope), 'PO 4471 — Fleur');
    assert.strictEqual(resolveTemplate('{{missing.path}}', scope), null);
    assert.strictEqual(resolveTemplate('x{{missing.path}}y', scope), 'xy');
    assert.strictEqual(resolveTemplate(42, scope), 42);
    assert.strictEqual(resolveTemplate(null, scope), null);
});

async function withPatched({ app = { id: 'app_7', userId: 'owner', name: 'Quotes' }, model = { tables: [{ id: 'tbl_q', key: 'quotes' }] }, writeResult = { id: 'rec_9', updated: true, changes: 1 }, writeThrows = null } = {}, fn) {
    const rec = { writes: [], audits: [], bells: [] };
    const saved = {
        getStudioApp: studioAppStore.getStudioApp,
        getDataModel: studioAppDataStore.getDataModel,
        writeRecord: actionExecutor.writeRecord,
        findTable: actionExecutor._findTable,
        appendApprovalAudit: automationStore.appendApprovalAudit,
        createNotification: notificationStore.createNotification,
    };
    studioAppStore.getStudioApp = async () => app;
    studioAppDataStore.getDataModel = async () => ({ model });
    actionExecutor.writeRecord = async (a, m, table, values, opts) => {
        rec.writes.push({ table: table.id, values, viewer: opts.viewer, recordId: opts.recordId });
        if (writeThrows) throw writeThrows;
        return writeResult;
    };
    automationStore.appendApprovalAudit = async (ev) => { rec.audits.push(ev); };
    notificationStore.createNotification = async (n) => { rec.bells.push(n); };
    try { await fn(rec); } finally {
        studioAppStore.getStudioApp = saved.getStudioApp;
        studioAppDataStore.getDataModel = saved.getDataModel;
        actionExecutor.writeRecord = saved.writeRecord;
        automationStore.appendApprovalAudit = saved.appendApprovalAudit;
        notificationStore.createNotification = saved.createNotification;
    }
}

test('the approved outcome writes its templated columns acts-as-owner', async () => {
    await withPatched({}, async (rec) => {
        const res = await runOnDecidedHook(ROW);
        assert.strictEqual(res.ran, true);
        assert.strictEqual(rec.writes.length, 1);
        assert.deepStrictEqual(rec.writes[0].values, { status: 'goedgekeurd', po_number: '4471', by: 'Fleur' });
        assert.deepStrictEqual(rec.writes[0].viewer, { id: 'owner', role: 'owner' });
        assert.strictEqual(rec.writes[0].recordId, 'rec_9');
        assert.strictEqual(rec.audits[0].decision, 'hook_ran');
    });
});

test('an outcome with no set entry is a clean no-op', async () => {
    await withPatched({}, async (rec) => {
        const res = await runOnDecidedHook({ ...ROW, status: 'rejected' });
        assert.deepStrictEqual(res, { ran: false });
        assert.strictEqual(rec.writes.length, 0);
        assert.strictEqual(rec.audits.length, 0);
    });
});

test('no hook, no app id, or still pending — all no-ops', async () => {
    assert.deepStrictEqual(await runOnDecidedHook({ ...ROW, onDecided: null }), { ran: false });
    assert.deepStrictEqual(await runOnDecidedHook({ ...ROW, studioAppId: null }), { ran: false });
    assert.deepStrictEqual(await runOnDecidedHook({ ...ROW, status: 'pending' }), { ran: false });
});

test('a failing write is audited and belled — never thrown', async () => {
    await withPatched({ writeThrows: new Error('RLS refused') }, async (rec) => {
        const res = await runOnDecidedHook(ROW);
        assert.strictEqual(res.ran, false);
        assert.match(res.error, /RLS refused/);
        assert.strictEqual(rec.audits[0].decision, 'hook_failed');
        assert.strictEqual(rec.bells.length, 1);
        assert.strictEqual(rec.bells[0].userId, 'owner');
    });
});

test('a vanished table fails soft the same way', async () => {
    await withPatched({ model: { tables: [] } }, async (rec) => {
        const res = await runOnDecidedHook(ROW);
        assert.strictEqual(res.ran, false);
        assert.match(res.error, /no longer exists/);
        assert.strictEqual(rec.audits[0].decision, 'hook_failed');
    });
});

test('an update that matched no row is a failure, not a silent success', async () => {
    await withPatched({ writeResult: { id: 'rec_9', updated: false, changes: 0 } }, async (_rec) => {
        const res = await runOnDecidedHook(ROW);
        assert.strictEqual(res.ran, false);
        assert.match(res.error, /record no longer exists/);
    });
});
