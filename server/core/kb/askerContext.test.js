'use strict';

/**
 * `askerContext` — wie er vraagt, buiten een request om.
 *
 * ── WAAROM DIT BESTAAT ──────────────────────────────────────────────
 * Dit is de org-resolutie voor elke plek die BUITEN een request draait: een
 * stream, een toolronde, een achtergrondbeantwoorder, en sinds M4 de poort die
 * beslist of een schrijver een regel op de tijdlijn van een vergadering mag
 * plakken. De request-kant van diezelfde vraag is `auth.resolveUserOrgIds`, en
 * die twee liepen uiteen: deze kant las een veld (`user.organizationIds`) dat
 * nergens in stores/ bestaat, en telde de orgs die uit de GROEPEN van de
 * gebruiker volgen niet mee. Iemand die zijn org alleen via een groep bereikt
 * kon een vergadering dus openen maar er niets uit filen.
 *
 * Draaien: cd server && node --test --test-force-exit core/kb/askerContext.test.js
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
stub('../../auth', {
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
    // De naam van deze test was al goed; de assertie eiste het tegendeel
    // ([] met "een halve resolutie is geen resolutie"). Die eis brak twee
    // suites in de zichtbaarheidslaag, en dat was terecht: de twee feiten
    // hebben verschillende herkomst. `organizationId` kwam terug uit een
    // GESLAAGDE lezing; de groepsuitbreiding is een losse, ADDITIEVE vraag.
    // Die tweede laten mislukken maakt de eerste niet onbekend.
    //
    // Versmallen-bij-onbekend blijft gelden waar we werkelijk niets weten:
    // valt de GEBRUIKERSlezing om, dan is de Set leeg (de test hieronder).
    fx.users.u6 = { id: 'u6', organizationId: 'orgA', groups: ['g1'] };
    fx.getAllGroupsThrows = true;
    const ctx = await askerContext('u6');
    assert.deepStrictEqual([...ctx.orgIds], ['orgA'],
        'de direct gelezen org blijft; alleen de groeps-orgs vallen weg');
});

test('maar een omgevallen GEBRUIKERSlezing levert wel een lege set op', async () => {
    // Het onderscheid dat de test hierboven maakt, van de andere kant:
    // hier weten we niets, dus valt alles weg.
    fx.getUserThrows = true;
    const ctx = await askerContext('u6');
    assert.deepStrictEqual([...ctx.orgIds], [], 'niets gelezen is niets toekennen');
});
