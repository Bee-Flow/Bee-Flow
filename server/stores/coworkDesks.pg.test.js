// @typecheck
/**
 * Desks on a real Postgres (PGlite): an item joins only once its owner accepted, the followers of a run are found
 * across owners on one desk only and only once the leading item's owner allowed the hand-off, and every read counts a person only while they are an active member of the desk's
 * organisation (a member who left stops counting, someone of another organisation never counts).
 *
 * Run: cd server && node --test stores/coworkDesks.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { pg, store } = require('./coworkStore.testkit').coworkStoreOnPglite();
const { makeCoworkDesks, COWORK_DESKS_DDL } = require('./coworkDesks.mts');
const { makeCoworkStarts } = require('./coworkStarts.mts');

const desks = makeCoworkDesks({ ready: async () => { await store.initDB(); for (const sql of COWORK_DESKS_DDL) await pg.exec(sql); } });
const starts = makeCoworkStarts({ ready: () => store.initDB() });

// The user store's own table is not part of the Cowork schema: the columns the desks read.
before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT DEFAULT '', status TEXT DEFAULT 'active');
        INSERT INTO users (id, "organizationId", status) VALUES ('ann', 'org-a', 'active'), ('bob', 'org-a', 'active'), ('cas', 'org-a', 'active'),
            ('dan', 'org-a', 'active'), ('eve', 'org-b', 'active') ON CONFLICT (id) DO NOTHING`);
});

/** @param {string} userId @param {string} title */
const item = async (userId, title) => /** @type {{ id: string }} */ (await store.createSchedule({ userId, title, prompt: 'P', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() })).id;

test('an item joins when its owner accepts; the desk is seen by its maker, its members and its role holders', async () => {
    const desk = await desks.createDesk({ organizationId: 'org-a', ownerId: 'ann', name: 'Invoices' });
    const radar = await item('ann', 'Supplier radar');
    const intake = await item('bob', 'Invoice intake');
    assert.strictEqual(await desks.addMember({ deskId: desk.id, scheduleId: radar, addedBy: 'ann', accepted: true }), true);
    assert.strictEqual(await desks.addMember({ deskId: desk.id, scheduleId: intake, addedBy: 'ann', accepted: false }), true);
    assert.deepStrictEqual((await desks.listMembers(desk.id)).map((m) => [m.title, m.ownerId, m.accepted]), [['Supplier radar', 'ann', true], ['Invoice intake', 'bob', false]]);
    assert.strictEqual(await desks.sameDesk(radar, intake), false, 'an invitation is no member yet');
    assert.strictEqual(await desks.acceptMember(desk.id, intake, 'ann'), false, 'only the owner of the item accepts it');
    assert.strictEqual(await desks.acceptMember(desk.id, intake, 'bob'), true);
    assert.strictEqual(await desks.sameDesk(radar, intake), true);
    const other = await desks.createDesk({ organizationId: 'org-a', ownerId: 'ann', name: 'Other' });
    assert.strictEqual(await desks.addMember({ deskId: other.id, scheduleId: radar, addedBy: 'ann', accepted: true }), false, 'one desk per item');
    await desks.setRoles(desk.id, [{ role: 'invoices', holderId: 'cas', standInId: 'dan', awayUntil: null }]);
    assert.deepStrictEqual((await desks.desksOf('cas')).map((d) => d.name), ['Invoices'], 'a role holder sees the desk');
    assert.deepStrictEqual((await desks.desksOf('bob')).map((d) => d.name), ['Invoices']);
    assert.deepStrictEqual((await desks.desksOf('eve')), [], 'someone of another organisation sees nothing');
    assert.deepStrictEqual((await desks.membershipOf(intake))?.accepted, true);
    await desks.setDeskRole(desk.id, intake, 'invoices');
    await pg.query('UPDATE cowork_schedules SET user_id = $2 WHERE id = $1', [intake, 'cas']);
    assert.strictEqual(await desks.questionRoleOf(intake), null, 'an item handed to a colleague waits for the new owner to accept');
    assert.strictEqual(await desks.sameDesk(radar, intake), false);
    await pg.query('UPDATE cowork_schedules SET user_id = $2 WHERE id = $1', [intake, 'bob']);
    assert.deepStrictEqual(await desks.questionRoleOf(intake), { deskId: desk.id, role: 'invoices', holderId: 'cas', standInId: 'dan', awayUntil: null });
    assert.strictEqual(await desks.removeMember(desk.id, intake), true);
    assert.strictEqual(await desks.membershipOf(intake), null);
});

test('followers across owners: accepted members of the same desk that start after the item; a follower in another organisation never', async () => {
    const desk = await desks.createDesk({ organizationId: 'org-a', ownerId: 'ann', name: 'Hand-offs' });
    const a = await item('ann', 'A');
    const b = await item('bob', 'B');
    const outsider = await item('eve', 'E');
    const invited = await item('cas', 'C');
    for (const [id, accepted] of /** @type {Array<[string, boolean]>} */ ([[a, true], [b, true], [outsider, true], [invited, false]])) {
        const owner = /** @type {any} */ (await store.getSchedule(id)).userId;
        await desks.addMember({ deskId: desk.id, scheduleId: id, addedBy: accepted ? owner : 'ann', accepted });
    }
    for (const id of [b, outsider, invited]) await starts.setStart(id, 'after_cowork', { scheduleId: a });
    assert.deepStrictEqual(await desks.deskFollowers(a), [], 'nothing of Ann goes to Bob before Ann allows it');
    for (const id of [b, outsider, invited]) {
        const owner = /** @type {any} */ (await store.getSchedule(id)).userId;
        await desks.allowFollow({ deskId: desk.id, leaderId: a, followerId: id, followerOwner: owner, allowedBy: 'ann' });
    }
    assert.deepStrictEqual((await desks.deskFollowers(a)).map((i) => i.id), [b], 'not the outsider, not the invitation');
    assert.deepStrictEqual((await desks.listMembers(desk.id)).map((m) => m.title), ['A', 'B', 'C'], 'the outsider is no member of the desk');
    assert.strictEqual((await desks.listMembers(desk.id))[1].afterId, a);

    await pg.query(`UPDATE users SET status = 'disabled' WHERE id = 'bob'`);
    assert.deepStrictEqual(await desks.deskFollowers(a), [], 'a member who was switched off stops counting');
    await pg.query(`UPDATE users SET status = 'active', "organizationId" = 'org-b' WHERE id = 'bob'`);
    assert.deepStrictEqual(await desks.deskFollowers(a), [], 'and so does one who moved to another organisation');
    assert.strictEqual(await desks.sameDesk(a, b), false);
    await pg.query(`UPDATE users SET "organizationId" = 'org-a' WHERE id = 'bob'`);
    await pg.query(`UPDATE users SET "organizationId" = 'org-b' WHERE id = 'ann'`);
    assert.deepStrictEqual(await desks.deskFollowers(a), [], 'nor do the followers of an owner who left');
    await pg.query(`UPDATE users SET "organizationId" = 'org-a' WHERE id = 'ann'`);
    assert.deepStrictEqual((await desks.deskFollowers(a)).map((i) => i.id), [b]);
});

test('a role holder or stand-in counts only while they are an active member of the desk\'s organisation', async () => {
    const desk = await desks.createDesk({ organizationId: 'org-a', ownerId: 'ann', name: 'Roles' });
    await desks.setRoles(desk.id, [{ role: 'payments', holderId: 'dan', standInId: 'eve', awayUntil: '2030-01-01T00:00:00.000Z' }]);
    assert.deepStrictEqual(await desks.listRoles(desk.id), [{ role: 'payments', holderId: 'dan', standInId: null, awayUntil: '2030-01-01T00:00:00.000Z' }]);
    await pg.query(`UPDATE users SET status = 'disabled' WHERE id = 'dan'`);
    assert.deepStrictEqual((await desks.listRoles(desk.id))[0].holderId, null);
    await pg.query(`UPDATE users SET status = 'active' WHERE id = 'dan'`);
    await desks.deleteDesk(desk.id);
    assert.strictEqual(await desks.getDesk(desk.id), null);
    assert.deepStrictEqual(await desks.listRoles(desk.id), [], 'the roles go with the desk');
});

test('a hand-off across owners needs the yes of the leading item\'s owner: once, until withdrawn or either item changes hands', async () => {
    const desk = await desks.createDesk({ organizationId: 'org-a', ownerId: 'cas', name: 'Consent' });
    const radar = await item('ann', 'Supplier radar');
    const intake = await item('bob', 'Invoice intake');
    const annsOwn = await item('ann', 'Ann\'s report');
    for (const id of [radar, intake, annsOwn]) {
        const owner = /** @type {any} */ (await store.getSchedule(id)).userId;
        await desks.addMember({ deskId: desk.id, scheduleId: id, addedBy: owner, accepted: true });
    }
    for (const id of [intake, annsOwn]) await starts.setStart(id, 'after_cowork', { scheduleId: radar });
    assert.deepStrictEqual((await desks.deskFollowers(radar)).map((i) => i.id), [annsOwn], 'following one\'s own cowork needs nothing; Bob\'s waits');
    const shown = async () => Object.fromEntries((await desks.listMembers(desk.id)).map((m) => [m.title, m.afterAllowed]));
    assert.deepStrictEqual(await shown(), { 'Supplier radar': false, 'Invoice intake': false, 'Ann\'s report': true });
    assert.strictEqual(await desks.followAllowed(radar, intake), false);

    await desks.allowFollow({ deskId: desk.id, leaderId: radar, followerId: intake, followerOwner: 'bob', allowedBy: 'bob' });
    assert.deepStrictEqual((await desks.deskFollowers(radar)).map((i) => i.id), [annsOwn], 'a yes of anyone but the leader\'s owner counts for nothing');
    await desks.allowFollow({ deskId: desk.id, leaderId: radar, followerId: intake, followerOwner: 'bob', allowedBy: 'ann' });
    assert.deepStrictEqual((await desks.deskFollowers(radar)).map((i) => i.id).sort(), [annsOwn, intake].sort());
    assert.strictEqual(await desks.followAllowed(radar, intake), true);
    assert.strictEqual((await shown())['Invoice intake'], true);

    /** Hand `id` to `to`, who accepts it on the desk again. */
    const handTo = async (/** @type {string} */ id, /** @type {string} */ to) => {
        await pg.query('UPDATE cowork_schedules SET user_id = $2 WHERE id = $1', [id, to]);
        assert.strictEqual(await desks.acceptMember(desk.id, id, to), true);
    };
    await handTo(radar, 'dan');
    assert.ok(!(await desks.deskFollowers(radar)).some((i) => i.id === intake), 'a leader handed to Dan: Dan is asked again');
    await handTo(radar, 'ann');
    await handTo(intake, 'cas');
    assert.ok(!(await desks.deskFollowers(radar)).some((i) => i.id === intake), 'a follower handed to Cas: Ann is asked again');
    await handTo(intake, 'bob');
    assert.ok((await desks.deskFollowers(radar)).some((i) => i.id === intake), 'back with the people Ann said yes to');

    assert.strictEqual(await desks.withdrawFollow(desk.id, radar, intake), true);
    assert.deepStrictEqual((await desks.deskFollowers(radar)).map((i) => i.id), [annsOwn], 'withdrawn: Bob\'s cowork receives nothing any more');
    assert.strictEqual(await desks.withdrawFollow(desk.id, radar, intake), false);

    await desks.allowFollow({ deskId: desk.id, leaderId: radar, followerId: intake, followerOwner: 'bob', allowedBy: 'ann' });
    assert.strictEqual(await desks.removeMember(desk.id, intake), true);
    await desks.addMember({ deskId: desk.id, scheduleId: intake, addedBy: 'bob', accepted: true });
    assert.strictEqual(await desks.followAllowed(radar, intake), false, 'taken off the desk and put back: Ann is asked again');
});
