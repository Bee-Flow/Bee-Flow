// @typecheck
/**
 * Cowork run receipts on a real Postgres (PGlite): every closed run gets one, in the order the runs finished, linked
 * and signed; a removed receipt shows as a gap, an edited one as changed content; a receipt holds names and counts and
 * never the text a run read or wrote; issuing twice issues nothing new.
 *
 * Run: cd server && node --test core/cowork/receipts/receipts.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { pg, store } = require('../../../stores/coworkStore.testkit').coworkStoreOnPglite();
const { makeCoworkReceipts, COWORK_RECEIPTS_DDL } = require('../../../stores/coworkReceipts.mts');
const { issueReceipts } = require('./issueReceipts.mts');
const { verifyReceipts } = require('./verifyReceipts.mts');
const { hashPayload, linkHash } = require('./receiptHash.mts');
const { receiptKey, _forgetReceiptKey } = require('./receiptKey.mts');

const MARKER = 'MARKER-7f3a-secret-content';
const receipts = makeCoworkReceipts({ ready: async () => { await store.initDB(); for (const sql of COWORK_RECEIPTS_DDL) await pg.exec(sql); } });

/** A secret store in memory, as the config store would hold the key. */
const secrets = () => {
    const kept = new Map();
    return {
        getSecret: async (/** @type {string} */ k) => kept.get(k) ?? null,
        setSecretIfAbsent: async (/** @type {string} */ k, /** @type {string} */ v) => { if (!kept.has(k)) kept.set(k, v); return kept.get(k); },
    };
};
const keyStore = secrets();
/** @type {import('../plan/planTypes.mts').ToolLookups} */
const lookups = {
    appOfTool: (t) => (t.startsWith('outlook_') ? 'outlook' : null),
    effectOfTool: (t) => (t.includes('send') ? 'sends' : t.includes('draft') ? 'writes' : 'reads'),
    isOpenWebRead: () => false,
};
const deps = {
    withChain: receipts.withChain, planOf: receipts.planOf, stepsOf: receipts.stepsOf, itemsWithPending: receipts.itemsWithPending,
    signingKey: () => receiptKey(keyStore), lookups,
};

before(async () => {
    _forgetReceiptKey();
    await pg.exec(`
        CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, root_run_id TEXT);
        CREATE TABLE IF NOT EXISTS automation_run_steps (run_id TEXT, step_id TEXT, step_type TEXT, status TEXT, attempts INTEGER DEFAULT 1);
    `);
});

async function item() {
    const s = await store.createSchedule({ userId: 'ann', title: 'Supplier radar', prompt: `Read the mail. ${MARKER}`, repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    return /** @type {{ id: string }} */ (s).id;
}

/** A prompt run that called tools and wrote a result with the marker in it. */
async function promptRun(/** @type {string} */ id) {
    const runId = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    const activity = { tools: [{ name: 'outlook_search', app: 'outlook', ok: 2, failed: 0, refused: 0, reasons: [] }, { name: 'outlook_create_draft', app: 'outlook', ok: 1, failed: 0, refused: 0, reasons: [MARKER] }], toolCalls: 3, skills: [] };
    await store.markCompleted(id, `Two orders are late. ${MARKER}`, { runId, activity, mailSubject: `Order ${MARKER}` });
    return runId;
}

test('three closed runs give three receipts, in order, linked and signed; issuing again issues nothing', async () => {
    const id = await item();
    const runs = [await promptRun(id), await promptRun(id), await promptRun(id)];
    assert.strictEqual(await issueReceipts(id, deps), 3);
    assert.strictEqual(await issueReceipts(id, deps), 0, 'each run has its receipt once');
    const chain = await receipts.listReceipts(id);
    assert.deepStrictEqual(chain.map((r) => [r.seq, r.runId]), runs.map((r, i) => [i + 1, r]));
    const key = /** @type {NonNullable<Awaited<ReturnType<typeof receiptKey>>>} */ (await receiptKey(keyStore));
    const verdict = verifyReceipts(chain, key);
    assert.deepStrictEqual([verdict.ok, verdict.count, verdict.unsigned, verdict.problem], [true, 3, 0, null]);
    assert.deepStrictEqual(chain[0].payload.did, [
        { app: 'outlook', tool: 'outlook_create_draft', effect: 'writes', count: 1 },
        { app: 'outlook', tool: 'outlook_search', effect: 'reads', count: 2 },
    ]);
    assert.strictEqual(chain[0].payload.kind, 'prompt');
});

test('a receipt taken out shows as a gap; an edited one as changed content; a forged signature as a bad signature', async () => {
    const id = await item();
    for (let i = 0; i < 3; i += 1) await promptRun(id);
    await issueReceipts(id, deps);
    const key = /** @type {NonNullable<Awaited<ReturnType<typeof receiptKey>>>} */ (await receiptKey(keyStore));
    const chain = await receipts.listReceipts(id);

    assert.deepStrictEqual(verifyReceipts([chain[0], chain[2]], key).problem, { seq: 3, kind: 'gap' });
    const relinked = [chain[0], { ...chain[2], seq: 2 }];
    assert.deepStrictEqual(verifyReceipts(relinked, key).problem, { seq: 2, kind: 'link' });
    const edited = [chain[0], { ...chain[1], payload: { ...chain[1].payload, status: 'success', did: [] } }, chain[2]];
    assert.deepStrictEqual(verifyReceipts(edited, key).problem, { seq: 2, kind: 'content' });
    const forged = [chain[0], { ...chain[1], signature: chain[0].signature }, chain[2]];
    assert.deepStrictEqual(verifyReceipts(forged, key).problem, { seq: 2, kind: 'signature' });
    // A writer who edits a receipt, recomputes its hashes and clears its signature: after a signed receipt, that is a
    // signature problem, not an "unsigned" count.
    const tampered = { ...chain[1].payload, status: 'success', did: [] };
    const payloadHash = hashPayload(tampered);
    const rehashed = { ...chain[1], payload: tampered, payloadHash, hash: linkHash(chain[1].prevHash, payloadHash), signature: null };
    assert.deepStrictEqual(verifyReceipts([chain[0], rehashed], key).problem, { seq: 2, kind: 'signature' });
    const unsignedFirst = { ...chain[0], signature: null };
    assert.deepStrictEqual(verifyReceipts([unsignedFirst, chain[1], chain[2]], key).problem, null, 'a receipt from before the key stays acceptable');

    await pg.query('DELETE FROM cowork_receipts WHERE schedule_id = $1 AND seq = 2', [id]);
    assert.deepStrictEqual(verifyReceipts(await receipts.listReceipts(id), key).problem, { seq: 3, kind: 'gap' });
});

test('no receipt holds the text a run read or wrote: not its result, its subject, its brief, nor a reason a tool gave', async () => {
    const id = await item();
    await promptRun(id);
    await issueReceipts(id, deps);
    const stored = await pg.query('SELECT payload_json FROM cowork_receipts WHERE schedule_id = $1', [id]);
    for (const row of stored.rows) assert.ok(!String(row.payload_json).includes(MARKER), 'the marker never reaches a receipt');
});

test('a plan run: its receipt names the approved plan, what it may do, and the steps that went through', async () => {
    const id = await item();
    const definition = { steps: [{ id: 'mail', type: 'integration_action', tool: 'outlook_search' }, { id: 'draft', type: 'integration_action', tool: 'outlook_create_draft' }, { id: 'tell', type: 'notification', title: MARKER }], edges: [] };
    const permissions = { v: 1, grants: [{ app: 'outlook', effect: 'reads', tools: ['outlook_search'] }, { app: 'outlook', effect: 'writes', tools: ['outlook_create_draft'] }], sends: 'owner', ai: false, outsideText: true };
    await pg.query(`INSERT INTO cowork_plans (id, schedule_id, automation_id, version, definition_json, permissions_json, fingerprint, approved_by)
                    VALUES ('plan-r1', $1, 'auto-1', 1, $2, $3, $4, 'ann')`, [id, JSON.stringify(definition), JSON.stringify(permissions), 'f'.repeat(64)]);
    const runId = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'schedule' }));
    await pg.query(`UPDATE cowork_runs SET plan_id = 'plan-r1', automation_run_id = 'arun-1', independence = 'asks_before_sending', trusted_steps = '["draft"]' WHERE id = $1`, [runId]);
    await pg.query(`INSERT INTO automation_runs (id, root_run_id) VALUES ('arun-1', NULL), ('arun-2', 'arun-1')`);
    await pg.query(`INSERT INTO automation_run_steps (run_id, step_id, step_type, status) VALUES
        ('arun-1', 'mail', 'integration_action', 'success'), ('arun-1', 'draft', 'integration_action', 'error'),
        ('arun-2', 'draft', 'integration_action', 'success'), ('arun-2', 'tell', 'notification', 'success')`);
    await store.markCompleted(id, `Sent the digest. ${MARKER}`, { runId });
    await issueReceipts(id, deps);
    const [receipt] = await receipts.listReceipts(id);
    const p = receipt.payload;
    assert.deepStrictEqual([p.kind, p.start, p.independence, p.trustedSteps, p.sends], ['plan', 'schedule', 'asks_before_sending', 1, 'owner']);
    assert.deepStrictEqual(p.plan, { version: 1, fingerprint: 'f'.repeat(64), approvedBy: 'ann', approvedAt: /** @type {any} */ (p.plan).approvedAt });
    assert.deepStrictEqual(p.may, [{ app: 'outlook', effect: 'reads' }, { app: 'outlook', effect: 'writes' }]);
    assert.deepStrictEqual(p.did, [
        { app: 'bee-flow', tool: 'notification', effect: 'sends', count: 1 },
        { app: 'outlook', tool: 'outlook_create_draft', effect: 'writes', count: 1 },
        { app: 'outlook', tool: 'outlook_search', effect: 'reads', count: 1 },
    ]);
    assert.ok(!JSON.stringify(p).includes(MARKER));
});

test('a run waiting for a decision gets no receipt until its journey ends; without a key receipts are issued unsigned', async () => {
    const id = await item();
    const runId = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await store.markCompleted(id, 'Waiting.', { runId, waiting: true });
    assert.strictEqual(await issueReceipts(id, deps), 0);
    await pg.query(`UPDATE cowork_runs SET status = 'success' WHERE id = $1`, [runId]);
    const unsigned = await issueReceipts(id, { ...deps, signingKey: async () => null });
    assert.strictEqual(unsigned, 1);
    const verdict = verifyReceipts(await receipts.listReceipts(id), null);
    assert.deepStrictEqual([verdict.ok, verdict.unsigned], [true, 1]);
});
