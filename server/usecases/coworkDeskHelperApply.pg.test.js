// @typecheck
/**
 * Setting up the Teamwork helper's proposal (./coworkDeskHelperApply.mts) on the real desk and start stores (PGlite),
 * through the desk's own use cases: a colleague's cowork is only invited and joins when its owner accepts; a hand-off
 * from a colleague's cowork waits for that colleague's yes; the caller's own yes is given ahead only for their own
 * cowork; the draft is checked again (another organisation's cowork, a cowork not shared, a stranger as holder, four
 * hand-offs between people in a row), before anything is made.
 *
 * Run: cd server && node --test usecases/coworkDeskHelperApply.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { pg, store } = require('../stores/coworkStore.testkit').coworkStoreOnPglite();
const { makeCoworkDesks, COWORK_DESKS_DDL } = require('../stores/coworkDesks.mts');
const { makeCoworkShares } = require('../stores/coworkShares.mts');
const { makeCoworkStarts } = require('../stores/coworkStarts.mts');
const desksUseCase = require('./coworkDesks.mts');
const startUseCase = require('./coworkStart.mts');
const { applyDeskDraft } = require('./coworkDeskHelperApply.mts');

const desks = makeCoworkDesks({ ready: async () => { await store.initDB(); for (const sql of COWORK_DESKS_DDL) await pg.exec(sql); } });
const shares = makeCoworkShares({ ready: () => store.initDB() });
const starts = makeCoworkStarts({ ready: () => store.initDB() });

/** @type {Array<{ userId: string, title: string, message: string }>} */
const notices = [];
/** The notices that asked a leader's owner to allow a hand-off (usecases/coworkStart.mts askLeader). @type {string[]} */
const askedLeaders = [];
const getUser = async (/** @type {string} */ id) => /** @type {any} */ ((await pg.query('SELECT * FROM users WHERE id = $1', [id])).rows[0] ?? null);
const listMembers = async (/** @type {string} */ orgId) => /** @type {any} */ ((await pg.query(`SELECT * FROM users WHERE "organizationId" = $1 AND status = 'active' ORDER BY id`, [orgId])).rows);

/** @type {import('./coworkStart.mts').StartDeps} */
const startDeps = {
    getSchedule: (id) => store.getSchedule(id),
    setStart: (id, kind, trigger) => starts.setStart(id, kind, trigger),
    syncSubscription: async () => null,
    canReadTable: async () => false,
    clientHost: () => 'https://bee.example',
    sameDesk: (a, b) => desks.sameDesk(a, b),
    askLeader: async (item, leader) => { if (!(await desks.followAllowed(leader.id, item.id))) askedLeaders.push(leader.userId); },
};
/** @type {import('./coworkDesks.mts').DeskDeps} */
const deskDeps = {
    desks, getUser, listMembers,
    notify: async (n) => { notices.push({ userId: n.userId, title: n.title, message: n.message }); },
    getSchedule: (id) => store.getSchedule(id),
    sharedWith: async (id, userId) => (await shares.roleOf(id, userId)) !== null,
    // Accepting an invitation that carries a start applies it as the owner, through chooseStart with its checks.
    startAfter: async (id, afterId) => startUseCase.chooseStart({ item: /** @type {any} */ (await store.getSchedule(id)), choice: { kind: 'after_cowork', scheduleId: afterId } }, startDeps),
};
/** @type {import('./coworkDeskHelperApply.mts').ApplyDeps} */
const deps = {
    helper: {
        getUser, listMembers,
        getSchedule: (id) => store.getSchedule(id),
        myCoworks: (userId) => store.getSchedules(userId),
        sharedWithMe: (userId) => shares.sharedWith(userId),
        membershipOf: (id) => desks.membershipOf(id),
    },
    desks: () => desksUseCase,
    starts: () => startUseCase,
    deskDeps, startDeps,
    notify: deskDeps.notify,
};

before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT DEFAULT '', status TEXT DEFAULT 'active', "displayName" TEXT, username TEXT);
        INSERT INTO users (id, "organizationId", status, "displayName") VALUES ('ann', 'org-a', 'active', 'Ann'), ('ben', 'org-a', 'active', 'Ben'),
            ('cas', 'org-a', 'active', 'Cas'), ('eve', 'org-b', 'active', 'Eve') ON CONFLICT (id) DO NOTHING`);
});

/** A cowork with an agent (so it may start after another one), shared with `sharedWith` when given. */
async function item(/** @type {string} */ userId, /** @type {string} */ title, /** @type {{ sharedWith?: string, agent?: boolean }} */ opts = {}) {
    const made = /** @type {{ id: string }} */ (await store.createSchedule({ userId, title, prompt: 'P', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString(), agentId: opts.agent === false ? null : 'agent-1' }));
    if (opts.sharedWith) await shares.setShares(made.id, [{ userId: opts.sharedWith, role: 'viewer' }], userId);
    return made.id;
}
const refused = (/** @type {number} */ status) => (/** @type {any} */ e) => e.status === status;
const kinds = (/** @type {Array<{ kind: string }>} */ notes) => notes.map((n) => n.kind);

test('my cowork, then a colleague\'s: the colleague\'s is only invited with its start, they are asked, and one click on accept starts it after mine; my yes is given ahead', async () => {
    const mails = await item('ann', 'Answer supplier mails');
    const invoices = await item('ben', 'Invoice check', { sharedWith: 'ann' });
    const result = await applyDeskDraft({ userId: 'ann', draft: { deskName: 'Supplier invoices', chain: [mails, invoices], roles: [{ role: 'Purchasing', holderId: 'ben', standInId: 'cas' }] } }, deps);
    assert.deepStrictEqual(kinds(result.done), ['desk_made', 'added', 'role_set']);
    assert.deepStrictEqual(result.waiting, [{ kind: 'their_start', title: 'Invoice check', afterTitle: 'Answer supplier mails', who: 'Ben', allowedByYou: true, planned: true }]);
    const view = await desksUseCase.deskView('ann', result.deskId, deskDeps);
    assert.deepStrictEqual(view.members.map((m) => [m.title, m.accepted, m.deskRole]), [['Answer supplier mails', true, 'Purchasing'], ['Invoice check', false, null]], 'Ben\'s cowork is not on the desk until he accepts');
    assert.deepStrictEqual(view.roles.map((r) => [r.role, r.holderName, r.standInName]), [['Purchasing', 'Ben', 'Cas']]);
    assert.ok(notices.some((n) => n.userId === 'ben' && n.message.includes('"Invoice check"') && n.message.includes('Accepting puts it on the desk and starts it after "Answer supplier mails"')), 'Ben is told what accepting does');
    assert.strictEqual((await store.getSchedule(invoices))?.triggerKind ?? 'schedule', 'schedule', 'nothing of Ben\'s changes before he accepts');
    assert.deepStrictEqual((await desksUseCase.itemDesk(/** @type {any} */ (await store.getSchedule(invoices)), deskDeps)).desk?.plannedAfter, { id: mails, title: 'Answer supplier mails', ownerName: 'Ann' }, 'his invitation says what accepting does');

    // Ben agrees with one click: accepting applies the planned start, as him. Ann already said yes, so it is allowed at once.
    const accepted = await desksUseCase.acceptOnDesk({ userId: 'ben', deskId: result.deskId, scheduleId: invoices }, deskDeps);
    assert.deepStrictEqual(accepted.plannedStart, { afterTitle: 'Answer supplier mails', applied: true, reason: null });
    assert.strictEqual((await store.getSchedule(invoices))?.triggerKind, 'after_cowork');
    assert.strictEqual((await desks.membershipOf(invoices))?.plannedAfterId, null, 'the planned start is applied once');
    const after = await desksUseCase.deskView('ben', result.deskId, deskDeps);
    assert.deepStrictEqual(after.members.map((m) => [m.title, m.handOff]), [['Answer supplier mails', null], ['Invoice check', 'allowed']]);
    assert.ok(!askedLeaders.includes('ann'), 'Ann is not asked again for what she set up');
});

test('a colleague\'s cowork, then mine: nothing goes along until the colleague allows it', async () => {
    const intake = await item('ben', 'Invoice intake', { sharedWith: 'ann' });
    const report = await item('ann', 'Friday report');
    const first = await applyDeskDraft({ userId: 'ann', draft: { deskName: 'Friday', chain: [intake, report], roles: [] } }, deps);
    assert.deepStrictEqual(kinds(first.waiting), ['invited', 'start_later'], 'my start waits until Ben\'s cowork is on the desk');
    assert.strictEqual((await store.getSchedule(report))?.triggerKind ?? 'schedule', 'schedule');

    await desksUseCase.acceptOnDesk({ userId: 'ben', deskId: first.deskId, scheduleId: intake }, deskDeps);
    // "Change with the helper", opened from my cowork on the desk I made: the hand-off is chosen now and waits for Ben.
    const second = await applyDeskDraft({ userId: 'ann', itemId: report, draft: { deskName: 'Friday', chain: [intake, report], roles: [] } }, deps);
    assert.strictEqual(second.deskId, first.deskId);
    assert.deepStrictEqual(kinds(second.done), ['starts_after']);
    assert.deepStrictEqual(second.waiting, [{ kind: 'allow', title: 'Friday report', afterTitle: 'Invoice intake', who: 'Ben' }]);
    const view = await desksUseCase.deskView('ann', first.deskId, deskDeps);
    assert.deepStrictEqual(view.members.map((m) => [m.title, m.handOff]), [['Invoice intake', null], ['Friday report', 'waiting']]);
    assert.strictEqual(await desks.followAllowed(intake, report), false, 'Ben\'s result does not go along before he allows it');
    assert.ok(askedLeaders.includes('ben'), 'Ben is asked to allow it');
    await assert.rejects(desksUseCase.allowHandOffAhead({ userId: 'ann', deskId: first.deskId, leaderId: intake, followerId: report }, deskDeps), refused(404), 'a yes ahead is only ever for one\'s own cowork');
});

test('a planned start that became invalid is refused on accept, and the acceptance holds with the reason', async () => {
    const digest = await item('ann', 'Daily digest');
    const check = await item('ben', 'Stock check', { sharedWith: 'ann' });
    const result = await applyDeskDraft({ userId: 'ann', draft: { deskName: 'Stock', chain: [digest, check], roles: [] } }, deps);
    assert.strictEqual(result.waiting[0]?.planned, true);
    // Ann takes her cowork off the desk before Ben accepts: the start the invitation asked for is no longer possible.
    await desksUseCase.leaveDesk({ userId: 'ann', deskId: result.deskId, scheduleId: digest }, deskDeps);
    const accepted = await desksUseCase.acceptOnDesk({ userId: 'ben', deskId: result.deskId, scheduleId: check }, deskDeps);
    assert.strictEqual(accepted.plannedStart?.applied, false);
    assert.match(String(accepted.plannedStart?.reason), /no longer on the desk/);
    assert.deepStrictEqual(accepted.members.map((m) => [m.title, m.accepted]), [['Stock check', true]], 'the acceptance stands');
    assert.strictEqual((await store.getSchedule(check))?.triggerKind ?? 'schedule', 'schedule', 'his start is unchanged');

    // A start chooseStart refuses (here: a prompt without an agent or a plan) is reported the same way.
    const report = await item('ann', 'Weekly report');
    const notes = await item('ben', 'Notes', { sharedWith: 'ann', agent: false });
    const second = await applyDeskDraft({ userId: 'ann', draft: { deskName: 'Notes', chain: [report, notes], roles: [] } }, deps);
    const refusedStart = await desksUseCase.acceptOnDesk({ userId: 'ben', deskId: second.deskId, scheduleId: notes }, deskDeps);
    assert.deepStrictEqual([refusedStart.plannedStart?.applied, refusedStart.members.find((m) => m.title === 'Notes')?.accepted], [false, true]);
    assert.match(String(refusedStart.plannedStart?.reason), /agent or a plan/);
});

test('the draft is checked again as the caller, before anything is made', async () => {
    const mine = await item('ann', 'Mine');
    const eves = await item('eve', 'Eve secret', { sharedWith: 'ann' });
    const unshared = await item('cas', 'Not shared');
    const before = (await desksUseCase.myDesks('ann', deskDeps)).length;
    const draft = (/** @type {string[]} */ chain, roles = /** @type {any[]} */ ([])) => ({ userId: 'ann', draft: { deskName: 'Try', chain, roles } });
    await assert.rejects(applyDeskDraft(draft([mine, eves]), deps), refused(404), 'another organisation\'s cowork');
    await assert.rejects(applyDeskDraft(draft([mine, unshared]), deps), refused(404), 'a colleague\'s cowork not shared with me');
    await assert.rejects(applyDeskDraft(draft([mine], [{ role: 'Q', holderId: 'eve' }]), deps), refused(404), 'a holder from another organisation');
    await assert.rejects(applyDeskDraft(draft([mine, mine]), deps), refused(400));
    const b1 = await item('ben', 'B1', { sharedWith: 'ann' });
    const b2 = await item('ben', 'B2', { sharedWith: 'ann' });
    const a2 = await item('ann', 'A2');
    const a3 = await item('ann', 'A3');
    await assert.rejects(applyDeskDraft(draft([mine, b1, a2, b2, a3]), deps), refused(409), 'four hand-offs between people in a row');
    await assert.rejects(applyDeskDraft({ userId: 'eve', itemId: mine, draft: { deskName: 'X', chain: [eves], roles: [] } }, deps), refused(404), 'an item of another organisation');
    assert.strictEqual((await desksUseCase.myDesks('ann', deskDeps)).length, before, 'no desk was made');
});

test('my own cowork without an agent or a plan keeps its start, and says why', async () => {
    const radar = await item('ann', 'Radar');
    const note = await item('ann', 'Plain prompt', { agent: false });
    const result = await applyDeskDraft({ userId: 'ann', draft: { deskName: 'Own', chain: [radar, note], roles: [] } }, deps);
    assert.deepStrictEqual(result.waiting, [{ kind: 'needs_runner', title: 'Plain prompt' }]);
    assert.deepStrictEqual(kinds(result.done), ['desk_made', 'added', 'added']);
});
