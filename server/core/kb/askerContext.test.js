'use strict';

/**
 * `askerContext`: who is asking, outside a request.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────
 * This is the org resolution for every place that runs OUTSIDE a request: a stream, a tool round,
 * a background responder, and since M4 the gate that decides whether a writer may paste a line onto
 * the timeline of a meeting. The request-side of that same question is `auth.resolveUserOrgIds`, and
 * those two had diverged: this side read a field (`user.organizationIds`) that does not exist in
 * stores/, and did not count the orgs that follow from the GROUPS of the user. Someone who reached
 * his org only via a group could therefore open a meeting but file nothing from it.
 *
 * Run: cd server && node --test --test-force-exit core/kb/askerContext.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const fx = {
    users: {},
    groups: [],
    getUserThrows: false,
    getAllGroupsThrows: false,
    resolveGroupsThrows: false,
};

stub('../../stores/userStore', {
    getUser: async (id) => {
        if (fx.getUserThrows) throw new Error('users is down');
        return fx.users[id] || null;
    },
    getAllGroups: async () => {
        if (fx.getAllGroupsThrows) throw new Error('groups is down');
        return fx.groups;
    },
});
stub('../../auth/audience', {
    resolveUserGroups: async (id) => {
        if (fx.resolveGroupsThrows) throw new Error('auth is down');
        const u = fx.users[id];
        return Array.isArray(u?.groups) ? u.groups : [];
    },
});

const { askerContext } = require('./askerContext');

test.beforeEach(() => {
    fx.users = {};
    fx.groups = [];
    fx.getUserThrows = false;
    fx.getAllGroupsThrows = false;
    fx.resolveGroupsThrows = false;
});

test('de directe org-toewijzing telt mee', async () => {
    fx.users.u1 = { id: 'u1', organizationId: 'orgA', groups: [] };
    const ctx = await askerContext('u1');
    assert.deepStrictEqual([...ctx.orgIds], ['orgA']);
    assert.deepStrictEqual(ctx.userGroups, []);
});

test('een org die alleen via een GROEP wordt bereikt telt ook mee', async () => {
    // De populatie waarvoor de poort kapot was: `organizationId` is leeg
    // (createUser schrijft `organizationId || ''`), en org X komt uit de groep.
    fx.users.u2 = { id: 'u2', organizationId: '', groups: ['g-sales'] };
    fx.groups = [{ id: 'g-sales', organizationId: 'orgX' }, { id: 'g-other', organizationId: 'orgY' }];

    const ctx = await askerContext('u2');
    assert.deepStrictEqual([...ctx.orgIds], ['orgX'], 'precies de org van zijn eigen groep, niet meer');
    assert.deepStrictEqual(ctx.userGroups, ['g-sales']);
});

test('direct én via groepen, zonder dubbelingen', async () => {
    fx.users.u3 = { id: 'u3', organizationId: 'orgA', groups: ['g1', 'g2'] };
    fx.groups = [{ id: 'g1', organizationId: 'orgA' }, { id: 'g2', organizationId: 'orgB' }];
    const ctx = await askerContext('u3');
    assert.deepStrictEqual([...ctx.orgIds].sort(), ['orgA', 'orgB']);
});

test('een groep zonder org voegt niets toe', async () => {
    fx.users.u4 = { id: 'u4', organizationId: '', groups: ['g-loose'] };
    fx.groups = [{ id: 'g-loose', organizationId: null }];
    assert.deepStrictEqual([...(await askerContext('u4')).orgIds], []);
});

test('groepen als JSON-tekst op de rij worden ook gelezen', async () => {
    // De terugval als `resolveUserGroups` niets oplevert: `users.groups` kan
    // als tekstkolom terugkomen, precies zoals resolveUserOrgIds hem leest.
    fx.resolveGroupsThrows = true;
    fx.users.u5 = { id: 'u5', organizationId: '', groups: '["g1"]' };
    fx.groups = [{ id: 'g1', organizationId: 'orgZ' }];
    const ctx = await askerContext('u5');
    assert.deepStrictEqual([...ctx.orgIds], ['orgZ']);
    assert.deepStrictEqual(ctx.userGroups, [], 'de groepenlijst zelf blijft leeg — die kon niet worden opgehaald');
});

// ── Onbekend versmalt ────────────────────────────────────────────────

test('geen gebruiker-id → lege context', async () => {
    const ctx = await askerContext(null);
    assert.deepStrictEqual([...ctx.orgIds], []);
    assert.deepStrictEqual(ctx.userGroups, []);
});

test('een onbekende gebruiker levert geen orgs op', async () => {
    assert.deepStrictEqual([...(await askerContext('spook')).orgIds], []);
});

test('een omgevallen userStore VERSMALT — nooit een lege set die als "geen filter" leest', async () => {
    fx.getUserThrows = true;
    const ctx = await askerContext('u1');
    assert.ok(ctx.orgIds instanceof Set, 'altijd een Set, nooit null (null = super-admin verderop)');
    assert.deepStrictEqual([...ctx.orgIds], []);
});

test('een omgevallen groepenlijst laat de directe org staan en voegt niets toe', async () => {
    // The name of this test was already right; the assertion demanded the opposite
    // ([] with "half a resolution is no resolution"). That demand broke two suites in the
    // visibility layer, and rightly so: the two facts have different origins. `organizationId` came
    // back from a SUCCESSFUL read; the group expansion is a separate, ADDITIVE question.
    // Letting that second one fail does not make the first one unknown.
    //
    // Narrowing-when-unknown still applies where we really know nothing: if the USER read
    // fails, then the Set is empty (the test below).
    fx.users.u6 = { id: 'u6', organizationId: 'orgA', groups: ['g1'] };
    fx.getAllGroupsThrows = true;
    const ctx = await askerContext('u6');
    assert.deepStrictEqual([...ctx.orgIds], ['orgA'],
        'de direct gelezen org blijft; alleen de groeps-orgs vallen weg');
});

test('maar een omgevallen GEBRUIKERSlezing levert wel een lege set op', async () => {
    // The distinction that the test above makes, from the other side:
    // here we know nothing, so everything falls away.
    fx.getUserThrows = true;
    const ctx = await askerContext('u6');
    assert.deepStrictEqual([...ctx.orgIds], [], 'niets gelezen is niets toekennen');
});
