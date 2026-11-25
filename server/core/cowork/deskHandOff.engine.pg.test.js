// @typecheck
/**
 * The proof of desks (ADR 0045): a hand-off carries data, never access. On the REAL automation engine and the real
 * stores (PGlite behind db.js), Ann's "Supplier radar" ends well and hands its result to Bob's "Invoice intake" on
 * their shared desk. Bob's item runs AS BOB:
 *
 *   - every tool call of the run is made for Bob, and every lookup of a credential or a connection while it runs names
 *     Bob and never Ann (the pool is the seam that records the queries, testUtils/pglitePool.js);
 *   - it receives only the result text of Ann's run (not even her item's title), and its plan is approved as one
 *     whose start brings outside text;
 *   - nothing of Ann's goes to Bob before Ann allowed it on the desk (usecases/coworkDesks.mts allowHandOff), and
 *     Ann is told that Bob's cowork asks;
 *   - a follower whose owner is in another organisation never starts, and one whose owner left the organisation stops
 *     counting.
 *
 * The outside world is stood in for through the product's own seam: a tool family registered with the dispatcher
 * (core/tools/toolFamilyRegistry.js) answers the Outlook tools and records who each call was made for.
 *
 * The desk needs its people in one organisation, but an owner row with an organisation makes the engine ask that
 * organisation's licence for automations, which this server does not have (planQuestions.engine.pg.test.js has the
 * same limit, and runs its owners without user rows). So the user rows are there while the desk is read (who follows
 * whom, who counts) and set aside while a plan is approved and while a follower's run executes (`unlicensed`): the
 * hand-off itself is decided with them.
 *
 * Run: cd server && node --test core/cowork/deskHandOff.engine.pg.test.js
 */

'use strict';

process.env.MASTER_ENCRYPTION_KEY ??= 'ci-master-encryption-key-for-tests-only!!';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pg, store } = require('./coworkEngine.testkit').coworkOnEngine();
require('../../testUtils/registerFeatures'); // the tool catalogue, so the plan's Outlook steps are known

const db = require('../../db');
const automationStore = require('../../stores/automationStore');
const { registerToolFamily, unregisterToolFamily, NOT_HANDLED } = require('../tools/toolFamilyRegistry');
const { attachPlan, approvePlan } = require('../../usecases/coworkPlan.mts');
const { chooseStart } = require('../../usecases/coworkStart.mts');
const { allowHandOff } = require('../../usecases/coworkDesks.mts');
const { coworkDesks, initDB: initDesks } = require('../../stores/coworkDesks.mts');
const { coworkStarts } = require('../../stores/coworkStarts.mts');
const { afterRunEnded } = require('./afterCowork.mts');
const { runOnEvent } = require('./eventRun.mts');
const { asStartedBy } = require('./startKinds.mts');
const { outsideTextOf, triggerBringsOutsideText } = require('./plan/outsideText.mts');
const { toolLookups } = require('./plan/planLookups.mts');

const ORG = 'org-desk';
const RESULT = 'Three orders are overdue: 4711, 4712 and 4713.';
const literal = (/** @type {unknown} */ value) => ({ kind: 'literal', value });
const ref = (/** @type {string} */ path) => ({ kind: 'ref', path });

/** Every tool call that reached Outlook, with the user it was made for. */
const calls = /** @type {Array<{ tool: string, userId: unknown, args: any }>} */ ([]);
/** The queries about credentials and connections while a follower runs, with their parameters. */
const lookups = /** @type {Array<{ sql: string, params: unknown[] }>} */ ([]);
let recording = false;

before(async () => {
    await store.initDB();
    await require('../../stores/userStore').getUser('ann'); // the user store's schema
    await initDesks();
    for (const [id, org] of [['ann', ORG], ['bob', ORG], ['eve', 'org-elsewhere'], ['dan', ORG]]) {
        await pg.query(`INSERT INTO users (id, username, "organizationId", status) VALUES ($1, $1, $2, 'active') ON CONFLICT (id) DO NOTHING`, [id, org]);
        // Everyone has a Microsoft connection, so a run that reached for the wrong one would find it.
        await require('../../stores/automationCredentialStore').upsertCredential({ userId: id, orgId: org, provider: 'microsoft', accessToken: `token-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 3_600_000, scope: 'Mail.Read Mail.ReadWrite' });
    }
    registerToolFamily({
        name: 'desk-outlook',
        order: -1000,
        isTool: (/** @type {string} */ tool) => tool.startsWith('outlook_'),
        execute: async (/** @type {string} */ tool, /** @type {any} */ args, /** @type {any} */ context) => {
            calls.push({ tool, userId: context?.userId, args });
            if (tool === 'outlook_create_draft') return { draft: true, id: 'draft-1' };
            return NOT_HANDLED;
        },
    });
    // The pool is the seam: while a follower runs, every query that reads a credential or a connection is kept.
    const query = db.pool.query;
    db.pool.query = /** @type {any} */ (async (/** @type {any} */ sql, /** @type {any} */ params) => {
        const text = typeof sql === 'string' ? sql : String(sql?.text ?? '');
        if (recording && /credential|connection|oauth|integration_token/i.test(text)) lookups.push({ sql: text, params: Array.isArray(params) ? params : [] });
        return query(sql, params);
    });
});

after(() => { unregisterToolFamily('desk-outlook'); });

/** Bob's intake: save the result of the run before it as a draft. Its body is the hand-off, as outside text. */
function intakeDefinition() {
    const steps = [{ id: 'draft', type: 'integration_action', label: 'Save the overdue orders as a draft', tool: 'outlook_create_draft', inputs: { to: literal('finance@example.test'), subject: literal('Overdue orders'), body: ref('trigger.output.after.result') } }];
    return { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges: [{ from: 'trg', to: 'draft' }], vars: {} };
}

/** A cowork of `userId`, on the desk. */
async function onDesk(/** @type {string} */ deskId, /** @type {string} */ userId, /** @type {string} */ title) {
    const created = /** @type {{ id: string }} */ (await store.createSchedule({ userId, title, prompt: 'P', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() }));
    await coworkDesks().addMember({ deskId, scheduleId: created.id, addedBy: userId, accepted: true });
    return created.id;
}

/** Run `fn` with the people's rows set aside (see the header), and put them back after. */
async function unlicensed(/** @type {() => Promise<any>} */ fn) {
    await pg.exec('CREATE TABLE IF NOT EXISTS users_aside (LIKE users INCLUDING DEFAULTS); INSERT INTO users_aside SELECT * FROM users; DELETE FROM users;');
    try { return await fn(); } finally {
        await pg.exec('INSERT INTO users SELECT * FROM users_aside; DELETE FROM users_aside;');
    }
}

/**
 * `userId`'s intake on the desk, starting after `afterId`, its plan approved. `written`: the start goes in by the
 * store, past the check of the use case (a row that must still start nothing).
 */
async function follower(/** @type {string} */ deskId, /** @type {string} */ userId, /** @type {string} */ afterId, written = false) {
    const id = await onDesk(deskId, userId, 'Invoice intake');
    const automation = await automationStore.createAutomation({ userId, title: 'Invoice intake', definition: intakeDefinition(), triggerType: 'manual' });
    await unlicensed(async () => attachPlan({ item: await store.getSchedule(id), automationId: automation.id }));
    // Starting after a cowork of another owner is allowed because both are on the desk: decided with the organisations.
    if (written) await coworkStarts().setStart(id, 'after_cowork', { scheduleId: afterId });
    else await chooseStart({ item: /** @type {any} */ (await store.getSchedule(id)), choice: { kind: 'after_cowork', scheduleId: afterId } });
    await unlicensed(async () => {
        const again = await attachPlan({ item: await store.getSchedule(id), automationId: automation.id });
        await approvePlan({ item: await store.getSchedule(id), fingerprint: again.draft.fingerprint });
    });
    return id;
}

/** Ann's radar ended well with RESULT: its run. */
async function radarEnded(/** @type {string} */ radarId) {
    const runId = /** @type {string} */ (await store.markRunning(radarId, { triggerKind: 'manual' }));
    await store.markCompleted(radarId, RESULT, { runId });
    return runId;
}

/** The hand-offs of a run of Ann's radar, through the real lookups, recording while each follower runs. */
async function handOff(/** @type {string} */ radarId, /** @type {string} */ runId) {
    const starts = coworkStarts();
    return afterRunEnded({ id: radarId, userId: 'ann', title: 'Supplier radar' }, runId, {
        runOrigin: (id) => starts.runOrigin(id),
        listFollowers: (id, userId) => starts.listFollowers(id, userId),
        listDeskFollowers: (id) => coworkDesks().deskFollowers(id),
        start: async (item, event) => {
            recording = true;
            try { return await unlicensed(() => runOnEvent(item, event)); } finally { recording = false; }
        },
    });
}

test('a hand-off from Ann\'s cowork runs Bob\'s cowork as Bob, with only the result, as outside text', async () => {
    const desk = await coworkDesks().createDesk({ organizationId: ORG, ownerId: 'ann', name: 'Invoices' });
    const radar = await onDesk(desk.id, 'ann', 'Supplier radar');
    const intake = await follower(desk.id, 'bob', radar);
    const asks = (await pg.query('SELECT title, link FROM notifications WHERE user_id = $1', ['ann'])).rows;
    assert.deepStrictEqual(asks.map((n) => n.link), [`/app/cowork/${radar}`], 'Ann is told that a colleague\'s cowork asks for her results');
    assert.strictEqual(await handOff(radar, await radarEnded(radar)), 0, 'nothing of Ann\'s goes to Bob before she allows it');
    assert.deepStrictEqual(await store.listRuns(intake), []);
    await allowHandOff({ userId: 'ann', deskId: desk.id, scheduleId: intake });
    // As the run checks it (core/cowork/planRun.mts): its start brings outside text, and the draft's body reads it.
    const asRun = asStartedBy(intakeDefinition(), /** @type {any} */ (await store.getSchedule(intake)));
    assert.strictEqual(triggerBringsOutsideText(asRun), true, 'the hand-off reads as outside text');
    assert.ok(outsideTextOf(asRun, toolLookups()).reads.has('draft'), 'and the step that uses it reads outside text');

    calls.length = 0;
    lookups.length = 0;
    assert.strictEqual(await handOff(radar, await radarEnded(radar)), 1, 'Bob\'s intake started');

    const [run] = await store.listRuns(intake);
    assert.strictEqual(run.status, 'success', `the intake ran (${run.error})`);
    const runRow = (await pg.query('SELECT user_id, trigger_kind FROM cowork_runs WHERE id = $1', [run.id])).rows[0];
    assert.deepStrictEqual([runRow.user_id, runRow.trigger_kind], ['bob', 'after_cowork'], 'the run is Bob\'s');
    assert.ok(calls.length > 0, 'the plan called Outlook');
    assert.deepStrictEqual([...new Set(calls.map((c) => c.userId))], ['bob'], 'every tool call was made for Bob');
    assert.strictEqual(calls.find((c) => c.tool === 'outlook_create_draft')?.args?.body, RESULT, 'the result of Ann\'s run came along');
    const credentialReads = lookups.filter((l) => /FROM automation_credentials/i.test(l.sql));
    assert.ok(credentialReads.length > 0, 'the run looked up its owner\'s connections');
    assert.deepStrictEqual([...new Set(credentialReads.map((l) => l.params[0]))], ['bob'], 'every credential lookup was made for Bob');
    for (const lookup of lookups) assert.ok(!lookup.params.includes('ann'), `no credential or connection of Ann was looked up: ${lookup.sql.slice(0, 120)}`);

    const link = await store.getPlanRun(intake, run.id);
    const automationRun = await automationStore.getRun(link.automationRunId);
    assert.deepStrictEqual(automationRun.triggerPayload?.after, { result: RESULT }, 'only the result text, not the title of Ann\'s item');
    assert.strictEqual(automationRun.userId, 'bob', 'the engine ran it as Bob');
});

test('a follower in another organisation never starts; a member who left stops counting', async () => {
    const desk = await coworkDesks().createDesk({ organizationId: ORG, ownerId: 'ann', name: 'Elsewhere' });
    const radar = await onDesk(desk.id, 'ann', 'Supplier radar');
    await assert.rejects(follower(desk.id, 'eve', radar), (/** @type {any} */ e) => e.status === 404, 'someone of another organisation cannot choose to start after it');
    const outsider = await follower(desk.id, 'eve', radar, true);
    const dans = await follower(desk.id, 'dan', radar);
    await allowHandOff({ userId: 'ann', deskId: desk.id, scheduleId: dans });
    await pg.query(`UPDATE users SET "organizationId" = 'org-left' WHERE id = 'dan'`);
    assert.strictEqual(await handOff(radar, await radarEnded(radar)), 0, 'nobody started');
    assert.deepStrictEqual(await store.listRuns(outsider), [], 'the outsider\'s cowork did not run, though its start names the radar');
    assert.deepStrictEqual(await store.listRuns(dans), [], 'the cowork of the member who left did not run');
});
