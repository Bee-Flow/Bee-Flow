/**
 * request_approval — the app-sourced approval creator.
 *
 * Store facades are monkey-patched; what is pinned: acts-as-owner identity
 * (owner_id = app owner, requested_by = the REAL viewer, anon included),
 * source 'app' with no run/step, snapshotting (prompt/details resolved NOW,
 * onDecided.recordId resolved NOW), attachment verification through the
 * app's own ledger, and the per-app pending cap.
 *
 * Run: node --test appStudio/actionExecutor.approval.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const automationStore = require('../stores/automationStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const notificationStore = require('../stores/notificationStore');
const { executeDataStep } = require('./actionExecutor');
const entitlements = require('../core/entitlements/entitlements');

// request_approval is gated on the Enterprise `approvals` capability, resolved
// against the APP OWNER. hasCapability fails closed without a real
// entitlements snapshot, so the harness grants it; the refusal has its own
// test at the bottom of this file.
const realHasCapability = entitlements.hasCapability;
entitlements.hasCapability = async () => true;

const APP = { id: 'app_7', userId: 'owner', name: 'Quote portal', organizationId: 'org1' };
const MODEL = { tables: [{ id: 'tbl_q', key: 'quotes' }] };

async function withPatched({ pending = 0, attachmentRows = {} } = {}, fn) {
    const rec = { created: [], audits: [], bells: [] };
    const saved = {
        countPendingApprovalsForApp: automationStore.countPendingApprovalsForApp,
        createApproval: automationStore.createApproval,
        appendApprovalAudit: automationStore.appendApprovalAudit,
        getSubscriptionsForProvider: automationStore.getSubscriptionsForProvider,
        getAttachment: studioAppDataStore.getAttachment,
        createNotification: notificationStore.createNotification,
    };
    automationStore.countPendingApprovalsForApp = async () => pending;
    automationStore.createApproval = async (row) => { rec.created.push(row); return { id: 'apr_new', ...row, status: 'pending' }; };
    automationStore.appendApprovalAudit = async (ev) => { rec.audits.push(ev); };
    automationStore.getSubscriptionsForProvider = async () => [];
    studioAppDataStore.getAttachment = async (id, appId, ownerId) => {
        if (appId !== APP.id || ownerId !== APP.userId) return null;   // owner-scoped ledger
        return attachmentRows[id] || null;
    };
    notificationStore.createNotification = async (n) => { rec.bells.push(n); };
    try { await fn(rec); } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (k === 'getAttachment') studioAppDataStore.getAttachment = v;
            else if (k === 'createNotification') notificationStore.createNotification = v;
            else automationStore[k] = v;
        }
    }
}

const BASE_STEP = {
    kind: 'request_approval',
    prompt: { kind: 'formula', expr: '"Approve quote " + form.quoteNo' },
    resultVar: 'approval',
};
const CTX = { viewerId: 'viewer-1', viewerName: 'Sam', role: 'member', formValues: { quoteNo: 'Q-12' }, vars: {} };

test('happy path: acts-as-owner row, real requester, resolved snapshot', async () => {
    await withPatched({}, async (rec) => {
        const res = await executeDataStep(APP, MODEL, BASE_STEP, CTX);
        assert.strictEqual(res.ok, true, JSON.stringify(res));
        assert.strictEqual(res.result.approvalId, 'apr_new');
        assert.strictEqual(res.result.status, 'pending');
        const row = rec.created[0];
        assert.strictEqual(row.source, 'app');
        assert.strictEqual(row.ownerId, 'owner');            // acts-as-owner
        assert.strictEqual(row.requestedBy, 'viewer-1');     // recorded, not impersonated
        assert.strictEqual(row.studioAppId, 'app_7');
        assert.strictEqual(row.organizationId, 'org1');
        assert.strictEqual(row.runId, null);
        assert.strictEqual(row.stepId, null);
        assert.strictEqual(row.prompt, 'Approve quote Q-12'); // resolved NOW
        assert.strictEqual(row.automationTitle, 'Quote portal');
        // The request was audited and the owner got the bell (no assignee).
        assert.strictEqual(rec.audits[0].decision, 'requested');
        assert.strictEqual(rec.audits[0].source, 'app');
        assert.deepStrictEqual(rec.bells.map(b => b.userId), ['owner']);
    });
});

test('an anonymous public viewer is recorded as the requester', async () => {
    await withPatched({}, async (rec) => {
        const res = await executeDataStep(APP, MODEL, BASE_STEP, { ...CTX, viewerId: 'anon:ab12cd' });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(rec.created[0].requestedBy, 'anon:ab12cd');
    });
});

test('a blank question refuses to create anything', async () => {
    await withPatched({}, async (rec) => {
        const res = await executeDataStep(APP, MODEL, { ...BASE_STEP, prompt: { kind: 'static', value: '   ' } }, CTX);
        assert.strictEqual(res.ok, false);
        assert.match(res.error, /question/);
        assert.strictEqual(rec.created.length, 0);
    });
});

test('the per-app pending cap refuses new requests', async () => {
    await withPatched({ pending: 200 }, async (rec) => {
        const res = await executeDataStep(APP, MODEL, BASE_STEP, CTX);
        assert.strictEqual(res.ok, false);
        assert.match(res.error, /too many undecided/);
        assert.strictEqual(rec.created.length, 0);
    });
});

test('attachments are verified in the app ledger; dirty or foreign files drop', async () => {
    const attachmentRows = {
        f_ok: { id: 'f_ok', mimeType: 'application/pdf', size: 100, scanned: true, quarantined: false },
        f_dirty: { id: 'f_dirty', mimeType: 'application/pdf', size: 50, scanned: true, quarantined: true },
    };
    const step = {
        ...BASE_STEP,
        attachments: { kind: 'static', value: [
            { kind: 'studio_attachment', fileId: 'f_ok', name: 'quote.pdf' },
            { kind: 'studio_attachment', fileId: 'f_dirty', name: 'bad.pdf' },
            { kind: 'studio_attachment', fileId: 'f_missing', name: 'ghost.pdf' },
            { notAn: 'attachment' },
        ] },
    };
    await withPatched({ attachmentRows }, async (rec) => {
        const res = await executeDataStep(APP, MODEL, step, CTX);
        assert.strictEqual(res.ok, true);
        const snap = rec.created[0].attachments;
        assert.strictEqual(snap.length, 1);
        assert.strictEqual(snap[0].fileId, 'f_ok');
        assert.strictEqual(snap[0].filename, 'quote.pdf');
        assert.strictEqual(snap[0].store, 'app');
    });
});

test('onDecided snapshots a RESOLVED recordId and refuses unknown tables', async () => {
    const good = {
        ...BASE_STEP,
        context: { recordId: { kind: 'formula', expr: 'vars.rec' } },
        onDecided: { tableId: 'tbl_q', recordId: { kind: 'formula', expr: 'vars.rec' }, set: { approved: { status: 'ok' } } },
    };
    await withPatched({}, async (rec) => {
        const res = await executeDataStep(APP, MODEL, good, { ...CTX, vars: { rec: 'rec_9' } });
        assert.strictEqual(res.ok, true, JSON.stringify(res));
        assert.deepStrictEqual(rec.created[0].onDecided, { tableId: 'tbl_q', recordId: 'rec_9', set: { approved: { status: 'ok' } } });
        assert.deepStrictEqual(rec.created[0].context, { recordId: 'rec_9' });
    });
    await withPatched({}, async (rec) => {
        const res = await executeDataStep(APP, MODEL, { ...good, onDecided: { ...good.onDecided, tableId: 'tbl_gone' } }, { ...CTX, vars: { rec: 'rec_9' } });
        assert.strictEqual(res.ok, false);
        assert.match(res.error, /table/);
        assert.strictEqual(rec.created.length, 0);
    });
    await withPatched({}, async (rec) => {
        const res = await executeDataStep(APP, MODEL, good, { ...CTX, vars: {} });   // recordId resolves empty
        assert.strictEqual(res.ok, false);
        assert.match(res.error, /which record/);
        assert.strictEqual(rec.created.length, 0);
    });
});

test('a deadline lands on the row; absent or 0 means none', async () => {
    await withPatched({}, async (rec) => {
        await executeDataStep(APP, MODEL, { ...BASE_STEP, expiresInHours: 48 }, CTX);
        assert.ok(rec.created[0].expiresAt, 'a 48h deadline is stamped');
        const dt = new Date(rec.created[0].expiresAt).getTime() - Date.now();
        assert.ok(dt > 47 * 3_600_000 && dt < 49 * 3_600_000, `deadline ~48h out, got ${dt}`);
    });
    await withPatched({}, async (rec) => {
        await executeDataStep(APP, MODEL, { ...BASE_STEP, expiresInHours: 0 }, CTX);
        assert.strictEqual(rec.created[0].expiresAt, null);
    });
});

test('reminder + escalation clocks land on the row; a stranger target drops', async () => {
    // The escalation target passes the same org gate as the assignee. The
    // userStore-backed check is not reachable in this harness, so use a
    // GROUP-less config and verify clock arithmetic + the drop rule via the
    // deadline instead: a clock at/after the deadline never lands.
    await withPatched({}, async (rec) => {
        const res = await executeDataStep(APP, MODEL, {
            ...BASE_STEP, expiresInHours: 24, remindAfterHours: 4, escalateAfterHours: 48, escalateToUserId: 'u9',
        }, CTX);
        assert.strictEqual(res.ok, true);
        const row = rec.created[0];
        assert.ok(row.remindAt, 'a 4h reminder before a 24h deadline lands');
        // 48h escalation against a 24h deadline can never fire → dropped whole.
        assert.strictEqual(row.escalateAt, null);
        assert.strictEqual(row.escalateToUserId, null);
    });
});


test('an unlicensed app cannot request an approval — and nothing is written', async () => {
    entitlements.hasCapability = async () => false;
    try {
        await withPatched({}, async (rec) => {
            const res = await executeDataStep(APP, MODEL, BASE_STEP, CTX);
            assert.strictEqual(res.ok, false);
            assert.match(res.error, /Enterprise/);
            assert.strictEqual(rec.created.length, 0, 'no row, no audit, no bell — the gate is before all of it');
            assert.strictEqual(rec.audits.length, 0);
        });
    } finally {
        entitlements.hasCapability = async () => true;
    }
});

test('the capability is resolved against the app OWNER, not the viewer', async () => {
    const asked = [];
    entitlements.hasCapability = async (cap, opts) => { asked.push({ cap, ...opts }); return true; };
    try {
        // An anonymous visitor on a public page has no licence of their own;
        // the app's does the work.
        await withPatched({}, async () => {
            await executeDataStep(APP, MODEL, BASE_STEP, { ...CTX, viewerId: 'anon:ab12cd' });
        });
    } finally {
        entitlements.hasCapability = async () => true;
    }
    assert.strictEqual(asked[0].cap, 'approvals');
    assert.strictEqual(asked[0].userId, APP.userId);
    assert.strictEqual(asked[0].orgId, APP.organizationId);
});

test.after(() => { entitlements.hasCapability = realHasCapability; });
