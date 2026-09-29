/**
 * `resolveUserOrgIds` — "gelezen nul" en "niet te lezen" zijn niet hetzelfde.
 *
 * De uitkomst is de sleutel waarop de EU-modus en de org-eigen tiermap worden
 * opgezocht (core/llm/modelResolver.js, routes/agents/persona.js,
 * routes/agents/tests.js). De catch onderaan de functie slikte élke storefout
 * en gaf een LEGE Set terug — die elke aanroeper leest als "deze gebruiker zit
 * in geen enkele org", oftewel de GLOBALE, niet-EU tiermap. De routes die
 * daarvoor een 503 hadden staan, hingen hun `catch` om een functie die nooit
 * gooide: een dode poort.
 *
 * Run: cd server && node --test --test-force-exit auth/permissions.orgIds.test.js
 */

process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const PERMISSIONS = path.join(SERVER, 'auth', 'permissions.js');

const fx = {
    user: { id: 'u1', role: 'user', groups: ['g1'], organizationId: 'orgA' },
    groups: [{ id: 'g1', organizationId: 'orgB' }],
    userThrows: false,
    groupsThrow: false,
};

const MOCKS = {
    '../stores/userStore': {
        getUser: async (id) => {
            if (fx.userThrows) throw new Error('user store unreachable');
            return id === fx.user.id ? fx.user : null;
        },
        getAllGroups: async () => {
            if (fx.groupsThrow) throw new Error('group store unreachable');
            return fx.groups;
        },
        getAllRoles: async () => [],
        touchLastSeen: async () => true,
    },
    '../db': { getRedis: () => null },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:org-ids:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // orgScope.js too: permissions.js delegates the org read to it, and a stub
    // keyed on the parent file alone would silently load the real userStore.
    if (parent && /auth[\\/](permissions|orgScope)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};
after(() => { Module._resolveFilename = originalResolve; });

delete require.cache[PERMISSIONS];
const { resolveUserOrgIds } = require(PERMISSIONS);

const REQ = (over = {}) => ({ session: { user: { id: 'u1', role: 'user' }, ...over } });

test.beforeEach(() => { fx.userThrows = false; fx.groupsThrow = false; });

test('de gewone lezing: eigen org plus die van elke groep', async () => {
    const ids = await resolveUserOrgIds(REQ());
    assert.deepEqual([...ids].sort(), ['orgA', 'orgB']);
});

test('zonder `strict` blijft het gedrag van elke bestaande aanroeper hetzelfde', async () => {
    fx.userThrows = true;
    const ids = await resolveUserOrgIds(REQ());
    assert.ok(ids instanceof Set, 'geen exception');
    assert.equal(ids.size, 0, 'een LEGE Set — precies het antwoord dat als "geen org" leest');
});

test('MET `strict` gooit een onleesbare lezing — dat is wat de 503-poorten nodig hebben', async () => {
    fx.userThrows = true;
    await assert.rejects(() => resolveUserOrgIds(REQ(), { strict: true }), /user store unreachable/);

    fx.userThrows = false;
    fx.groupsThrow = true;
    await assert.rejects(() => resolveUserOrgIds(REQ(), { strict: true }), /group store unreachable/);
});

test('strict verandert niets aan een GESLAAGDE lezing — ook niet aan een lege', async () => {
    fx.user = { id: 'u1', role: 'user', groups: [], organizationId: null };
    fx.groups = [];
    const ids = await resolveUserOrgIds(REQ(), { strict: true });
    assert.ok(ids instanceof Set);
    assert.equal(ids.size, 0, 'gelezen: deze gebruiker zit in geen org');
    fx.user = { id: 'u1', role: 'user', groups: ['g1'], organizationId: 'orgA' };
    fx.groups = [{ id: 'g1', organizationId: 'orgB' }];
});

test('de super-admin blijft `null` — geen org-filter, en dat is geen storing', async () => {
    assert.equal(await resolveUserOrgIds({ session: { isAdmin: true, user: { id: 'u1' } } }, { strict: true }), null);
    assert.equal(await resolveUserOrgIds({ session: { user: { id: 'u1', role: 'admin' } } }, { strict: true }), null);
});
