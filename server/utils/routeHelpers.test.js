/**
 * `getUserAuth` — the workspace in which the MODEL CHOICE is looked up.
 *
 * This helper fills `userOrgId`, and that field travels as `messageMetadata.userOrgId` to
 * core/agentRuntime/modelResolver.js and chatStream.js. There it is the key under which the EU
 * override and the org's own tier map are found: `globalConfig?.organizationId || globalConfig?.userOrgId`.
 * If it is null, resolution happens against the GLOBAL (non-EU) tier map.
 *
 * The call to `resolveUserOrgIds` lacked an `await`, so `orgIds` was a Promise: `.size` is `undefined`,
 * `undefined > 0` is false, and `userOrgId` was ALWAYS null. The route's test suite hid that by stubbing
 * `getUserAuth` itself with a field that the real source never filled.
 *
 * Run: cd server && node --test --test-force-exit utils/routeHelpers.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..');

const fx = { orgIds: new Set(['orgA']), orgThrows: false, strictCalls: [] };

const MOCKS = {
    '../auth/permissions': {
        resolveUserOrgIds: async (req, opts) => {
            fx.strictCalls.push(opts || null);
            if (fx.orgThrows) throw new Error('user store unreachable');
            return fx.orgIds;
        },
    },
    '../stores/configStore': { getConfig: async () => ({}) },
    '../stores/userStore': { getAppPassword: async () => null },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const id = `mock:routeHelpers:${request}`;
    MOCK_IDS[request] = id;
    require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /utils[\\/]routeHelpers\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { getUserAuth } = require(path.join(SERVER, 'utils/routeHelpers'));

const REQ = (over = {}) => ({
    session: { user: { id: 'u1', organizationId: 'orgFromSession' }, ...over },
});

test.beforeEach(() => {
    fx.orgIds = new Set(['orgA']);
    fx.orgThrows = false;
    fx.strictCalls = [];
});

test('de workspace wordt AFGEWACHT — anders is userOrgId altijd null', async () => {
    const auth = await getUserAuth(REQ());
    assert.strictEqual(auth.userOrgId, 'orgA',
        'zonder await is dit een Promise, is .size undefined, en valt alles op null terug');
    assert.strictEqual(auth.userOrgUnknown, false);
});

test('de STRIKTE lezing wordt gevraagd: "niet te lezen" mag hier geen lege Set worden', async () => {
    await getUserAuth(REQ());
    assert.deepStrictEqual(fx.strictCalls, [{ strict: true }]);
});

test('een gelezen NUL blijft null — dat is geen storing', async () => {
    fx.orgIds = new Set();
    const auth = await getUserAuth(REQ());
    assert.strictEqual(auth.userOrgId, null);
    assert.strictEqual(auth.userOrgUnknown, false, 'geen org is een antwoord');

    // Super admin: `null` uit de resolver betekent "geen org-filter".
    fx.orgIds = null;
    const admin = await getUserAuth(REQ());
    assert.strictEqual(admin.userOrgId, null);
    assert.strictEqual(admin.userOrgUnknown, false);
});

test('een ONLEESBARE lezing valt terug op de org uit de sessie, en zegt het als die er niet is', async () => {
    fx.orgThrows = true;
    const auth = await getUserAuth(REQ());
    assert.strictEqual(auth.userOrgId, 'orgFromSession',
        'een tweede bron die geen store-lezing nodig heeft — beter dan de globale tiermap');
    assert.strictEqual(auth.userOrgUnknown, false);

    const zonder = await getUserAuth({ session: { user: { id: 'u1' } } });
    assert.strictEqual(zonder.userOrgId, null);
    assert.strictEqual(zonder.userOrgUnknown, true,
        '"ik kon het niet lezen" is een ander antwoord dan "er is er geen"');
});
