// @typecheck
/**
 * Desks for their people (./coworkDesks.mts), on the real stores (PGlite): a desk is made by a member of an
 * organisation; an owner puts their own cowork on it, the desk's maker invites one shared with them and it joins when
 * its owner accepts; the view shows the coworks in the order work moves, with owners and last status but never run
 * content; roles are set by the desk's maker for colleagues only, and the owners whose coworks use a role are told when
 * it changes hands; a colleague's cowork that starts after mine receives its result only once I allowed it; an outsider
 * sees nothing.
 *
 * Run: cd server && node --test usecases/coworkDesks.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { pg, store } = require('../stores/coworkStore.testkit').coworkStoreOnPglite();
const { makeCoworkDesks, COWORK_DESKS_DDL } = require('../stores/coworkDesks.mts');
const { makeCoworkShares } = require('../stores/coworkShares.mts');
const { makeCoworkStarts } = require('../stores/coworkStarts.mts');
const desksUseCase = require('./coworkDesks.mts');

const desks = makeCoworkDesks({ ready: async () => { await store.initDB(); for (const sql of COWORK_DESKS_DDL) await pg.exec(sql); } });
const shares = makeCoworkShares({ ready: () => store.initDB() });
const starts = makeCoworkStarts({ ready: () => store.initDB() });

/** The notices that went out. @type {Array<{ userId: string, title: string, message: string, link: string }>} */
const notices = [];
/** @type {import('./coworkDesks.mts').DeskDeps} */
const deps = {
    notify: async (n) => { notices.push({ userId: n.userId, title: n.title, message: n.message, link: n.link }); },
    desks,
    getUser: async (id) => /** @type {any} */ ((await pg.query('SELECT * FROM users WHERE id = $1', [id])).rows[0] ?? null),
    listMembers: async (orgId) => /** @type {any} */ ((await pg.query(`SELECT * FROM users WHERE "organizationId" = $1 AND status = 'active' ORDER BY id`, [orgId])).rows),
    getSchedule: (id) => store.getSchedule(id),
    sharedWith: async (id, userId) => (await shares.roleOf(id, userId)) !== null,
};

before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT DEFAULT '', status TEXT DEFAULT 'active', "displayName" TEXT, username TEXT);
        INSERT INTO users (id, "organizationId", status, "displayName") VALUES ('ann', 'org-a', 'active', 'Ann'), ('bob', 'org-a', 'active', 'Bob'),
            ('cas', 'org-a', 'active', 'Cas'), ('eve', 'org-b', 'active', 'Eve'), ('lone', '', 'active', 'Lone') ON CONFLICT (id) DO NOTHING`);
});

/** @param {string} userId @param {string} title */
const item = async (userId, title) => /** @type {{ id: string }} */ (await store.createSchedule({ userId, title, prompt: 'P', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() })).id;
/** A refusal with this status. */
const refused = (/** @type {number} */ status) => (/** @type {any} */ e) => e.status === status;

test('a desk is made by a member of an organisation, and nobody else sees it', async () => {
    await assert.rejects(desksUseCase.createDesk({ userId: 'lone', name: 'Solo' }, deps), refused(403));
    const view = await desksUseCase.createDesk({ userId: 'ann', name: '  Invoices ' }, deps);
    assert.deepStrictEqual([view.desk.name, view.desk.isOwner, view.deskGoal], ['Invoices', true, null]);
    assert.deepStrictEqual(view.colleagues.map((c) => c.name), ['Ann', 'Bob', 'Cas'], 'the maker picks role holders among colleagues');
    await assert.rejects(desksUseCase.deskView('eve', view.desk.id, deps), refused(404));
    await assert.rejects(desksUseCase.deskView('bob', view.desk.id, deps), refused(404), 'not on it yet');
});

test('own coworks join at once; another owner\'s cowork is invited, seen only by the maker and its owner, and joins when its owner accepts', async () => {
    const { desk } = await desksUseCase.createDesk({ userId: 'ann', name: 'Flow' }, deps);
    const radar = await item('ann', 'Supplier radar');
    const intake = await item('bob', 'Invoice intake');
    const secret = await item('cas', 'Not shared');
    await desksUseCase.addToDesk({ userId: 'ann', deskId: desk.id, scheduleId: radar }, deps);
    await assert.rejects(desksUseCase.addToDesk({ userId: 'ann', deskId: desk.id, scheduleId: secret }, deps), refused(404), 'only a cowork shared with the maker can be invited');
    await shares.setShares(intake, [{ userId: 'ann', role: 'viewer' }], 'bob');
    const invited = await desksUseCase.addToDesk({ userId: 'ann', deskId: desk.id, scheduleId: intake }, deps);
    assert.deepStrictEqual(invited.members.map((m) => [m.title, m.ownerName, m.accepted]), [['Supplier radar', 'Ann', true], ['Invoice intake', 'Bob', false]]);
    assert.deepStrictEqual((await desksUseCase.itemDesk({ id: intake, userId: 'bob' }, deps)).desk, { id: desk.id, name: 'Flow', accepted: false, deskRole: null, invitedBy: 'Ann', plannedAfter: null });
    await assert.rejects(desksUseCase.planStartAfter({ userId: 'bob', deskId: desk.id, followerId: intake, leaderId: radar }, deps), refused(404), 'only the desk\'s maker plans the start of an invitation');
    await assert.rejects(desksUseCase.planStartAfter({ userId: 'ann', deskId: desk.id, followerId: radar, leaderId: intake }, deps), refused(404), 'an accepted cowork keeps its start its owner\'s');
    await assert.rejects(desksUseCase.acceptOnDesk({ userId: 'ann', deskId: desk.id, scheduleId: intake }, deps), refused(404), 'the maker cannot accept for the owner');
    const accepted = await desksUseCase.acceptOnDesk({ userId: 'bob', deskId: desk.id, scheduleId: intake }, deps);
    assert.deepStrictEqual(accepted.members.map((m) => [m.title, m.mine, m.accepted]), [['Supplier radar', false, true], ['Invoice intake', true, true]]);
    assert.deepStrictEqual(accepted.colleagues, [], 'only the maker gets the list of colleagues');
    assert.deepStrictEqual(await desksUseCase.myDesks('bob', deps), [{ id: desk.id, name: 'Flow', isOwner: false }]);
});

test('the view: in the order of hand-off, last status only, never what another owner\'s runs produced', async () => {
    const { desk } = await desksUseCase.createDesk({ userId: 'ann', name: 'Friday' }, deps);
    const report = await item('ann', 'Friday report');
    const radar = await item('ann', 'Supplier radar');
    const check = await item('bob', 'Payment check');
    await desksUseCase.addToDesk({ userId: 'ann', deskId: desk.id, scheduleId: report }, deps);
    await desksUseCase.addToDesk({ userId: 'ann', deskId: desk.id, scheduleId: radar }, deps);
    await shares.setShares(check, [{ userId: 'ann', role: 'viewer' }], 'bob');
    await desksUseCase.addToDesk({ userId: 'ann', deskId: desk.id, scheduleId: check }, deps);
    await desksUseCase.acceptOnDesk({ userId: 'bob', deskId: desk.id, scheduleId: check }, deps);
    await starts.setStart(check, 'after_cowork', { scheduleId: radar });
    await starts.setStart(report, 'after_cowork', { scheduleId: check });
    const runId = /** @type {string} */ (await store.markRunning(check, { triggerKind: 'manual' }));
    await store.markCompleted(check, 'IBAN NL00 BANK 0123 4567 89 paid', { runId });
    const view = await desksUseCase.deskView('ann', desk.id, deps);
    assert.deepStrictEqual(view.members.map((m) => m.title), ['Supplier radar', 'Payment check', 'Friday report']);
    assert.strictEqual(view.members[1].lastStatus, 'success');
    assert.ok(!JSON.stringify(view).includes('IBAN'), 'no run content in the view');
});

test('roles: set by the maker for colleagues only; the owner picks the role for its own cowork; leaving takes it off', async () => {
    const { desk } = await desksUseCase.createDesk({ userId: 'ann', name: 'Roles' }, deps);
    const mine = await item('bob', 'Invoice intake');
    await assert.rejects(desksUseCase.setDeskRoles({ userId: 'ann', deskId: desk.id, roles: [{ role: 'invoices', holderId: 'eve' }] }, deps), refused(404), 'no one of another organisation');
    await assert.rejects(desksUseCase.setDeskRoles({ userId: 'ann', deskId: desk.id, roles: [{ role: 'invoices', holderId: 'cas', standInId: 'cas' }] }, deps), refused(400));
    const set = await desksUseCase.setDeskRoles({ userId: 'ann', deskId: desk.id, roles: [{ role: 'invoices', holderId: 'cas', standInId: 'bob', awayUntil: '2099-01-01T00:00:00.000Z' }] }, deps);
    assert.deepStrictEqual(set.roles.map((r) => [r.role, r.holderName, r.standInName, r.away]), [['invoices', 'Cas', 'Bob', true]]);
    await assert.rejects(desksUseCase.setDeskRoles({ userId: 'bob', deskId: desk.id, roles: [] }, deps), refused(403), 'a stand-in sees the desk but does not set its roles');
    await desksUseCase.addToDesk({ userId: 'bob', deskId: desk.id, scheduleId: mine }, deps);
    await assert.rejects(desksUseCase.setItemRole({ userId: 'bob', deskId: desk.id, scheduleId: mine, deskRole: 'payments' }, deps), refused(404));
    assert.strictEqual((await desksUseCase.setItemRole({ userId: 'bob', deskId: desk.id, scheduleId: mine, deskRole: 'invoices' }, deps)).members[0].deskRole, 'invoices');
    await assert.rejects(desksUseCase.leaveDesk({ userId: 'cas', deskId: desk.id, scheduleId: mine }, deps), refused(404), 'a role holder does not take others\' coworks off');
    assert.deepStrictEqual(await desksUseCase.leaveDesk({ userId: 'bob', deskId: desk.id, scheduleId: mine }, deps), { removed: true });
    assert.deepStrictEqual((await desksUseCase.itemDesk({ id: mine, userId: 'bob' }, deps)).desk, null);
    await assert.rejects(desksUseCase.deleteDesk({ userId: 'bob', deskId: desk.id }, deps), refused(403));
    assert.deepStrictEqual(await desksUseCase.deleteDesk({ userId: 'ann', deskId: desk.id }, deps), { removed: true });
});

test('a colleague\'s cowork that starts after mine receives nothing until I allow it; I can withdraw it; nobody else decides', async () => {
    const { desk } = await desksUseCase.createDesk({ userId: 'cas', name: 'Consent' }, deps);
    const radar = await item('ann', 'Supplier radar');
    const intake = await item('bob', 'Invoice intake');
    const annsOwn = await item('ann', 'Weekly digest');
    for (const [userId, id] of [['ann', radar], ['bob', intake], ['ann', annsOwn]]) {
        await desks.addMember({ deskId: desk.id, scheduleId: id, addedBy: userId, accepted: true });
    }
    await starts.setStart(intake, 'after_cowork', { scheduleId: radar });
    await starts.setStart(annsOwn, 'after_cowork', { scheduleId: radar });
    const states = (/** @type {import('./coworkDesks.mts').DeskView} */ v) => Object.fromEntries(v.members.map((m) => [m.title, [m.handOff, m.decidesHandOff]]));

    assert.deepStrictEqual(states(await desksUseCase.deskView('ann', desk.id, deps)), {
        'Supplier radar': [null, false], 'Invoice intake': ['waiting', true], 'Weekly digest': [null, false],
    }, 'Ann decides about Bob\'s cowork; her own needs nothing');
    assert.deepStrictEqual(states(await desksUseCase.deskView('bob', desk.id, deps))['Invoice intake'], ['waiting', false], 'Bob sees that it waits');
    assert.deepStrictEqual(await desks.deskFollowers(radar).then((f) => f.map((i) => i.id)), [annsOwn], 'nothing of Ann goes to Bob yet');

    for (const userId of ['bob', 'cas', 'eve']) {
        await assert.rejects(desksUseCase.allowHandOff({ userId, deskId: desk.id, scheduleId: intake }, deps), refused(404), `${userId} does not decide for Ann`);
    }
    await assert.rejects(desksUseCase.allowHandOff({ userId: 'ann', deskId: desk.id, scheduleId: annsOwn }, deps), refused(404), 'her own cowork has nothing to allow');
    const allowed = await desksUseCase.allowHandOff({ userId: 'ann', deskId: desk.id, scheduleId: intake }, deps);
    assert.deepStrictEqual(states(allowed)['Invoice intake'], ['allowed', true]);
    assert.deepStrictEqual((await desks.deskFollowers(radar)).map((i) => i.id).sort(), [annsOwn, intake].sort());

    await assert.rejects(desksUseCase.withdrawHandOff({ userId: 'bob', deskId: desk.id, scheduleId: intake }, deps), refused(404));
    const withdrawn = await desksUseCase.withdrawHandOff({ userId: 'ann', deskId: desk.id, scheduleId: intake }, deps);
    assert.deepStrictEqual(states(withdrawn)['Invoice intake'], ['waiting', true]);
    assert.deepStrictEqual((await desks.deskFollowers(radar)).map((i) => i.id), [annsOwn], 'withdrawn: Bob\'s cowork receives nothing again');
});

test('when a role changes hands, the owners whose coworks use it are told: the title and the role only, never the maker', async () => {
    const { desk } = await desksUseCase.createDesk({ userId: 'ann', name: 'Questions' }, deps);
    const bobs = await item('bob', 'Invoice intake');
    const anns = await item('ann', 'Supplier radar');
    const other = await item('cas', 'Payment check');
    for (const [userId, id] of [['bob', bobs], ['ann', anns], ['cas', other]]) await desks.addMember({ deskId: desk.id, scheduleId: id, addedBy: userId, accepted: true });
    await desksUseCase.setDeskRoles({ userId: 'ann', deskId: desk.id, roles: [{ role: 'invoices', holderId: 'cas' }, { role: 'payments', holderId: 'bob' }] }, deps);
    await desks.setDeskRole(desk.id, bobs, 'invoices');
    await desks.setDeskRole(desk.id, anns, 'invoices');
    await desks.setDeskRole(desk.id, other, 'payments');
    notices.length = 0;

    await desksUseCase.setDeskRoles({ userId: 'ann', deskId: desk.id, roles: [{ role: 'invoices', holderId: 'cas' }, { role: 'payments', holderId: 'bob', awayUntil: '2099-01-01T00:00:00.000Z' }] }, deps);
    assert.deepStrictEqual(notices, [], 'the same holders and stand-ins: nobody is told');

    await desksUseCase.setDeskRoles({ userId: 'ann', deskId: desk.id, roles: [{ role: 'invoices', holderId: 'ann' }, { role: 'payments', holderId: 'bob' }] }, deps);
    assert.deepStrictEqual(notices.map((n) => [n.userId, n.link]), [['bob', `/app/cowork/${bobs}`]], 'only Bob: Ann made the change, Cas uses another role');
    assert.match(notices[0].message, /"invoices".*"Invoice intake"/);
    for (const name of ['Ann', 'Cas', 'ann', 'cas', 'Questions']) assert.ok(!JSON.stringify(notices[0]).includes(name), `no ${name} in the notice`);

    notices.length = 0;
    await desksUseCase.setDeskRoles({ userId: 'ann', deskId: desk.id, roles: [{ role: 'invoices', holderId: 'ann', standInId: 'cas' }, { role: 'payments', holderId: 'bob' }] }, deps);
    assert.deepStrictEqual(notices.map((n) => n.userId), ['bob'], 'a new stand-in is a change too');
});
