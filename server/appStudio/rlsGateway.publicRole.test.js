/**
 * RLS gateway — the reserved `public` role DENIES BY DEFAULT.
 *
 * Every other role falls back to the table's `access.default`, and a table is
 * created with default 'app' — "everyone who can open the app may read every
 * row". That is the right default for colleagues and the wrong one for the open
 * internet: with plain inheritance, opening ONE intake screen to anonymous
 * visitors (routes/studioAppPublic.js) would have handed each of them read
 * access to every customer record in the app.
 *
 * So `public` is a reserved key the gateway recognises by name. A table grants
 * it explicitly, per action, or it grants nothing.
 *
 * Run: cd server && node --test appStudio/rlsGateway.publicRole.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// resolveViewerRole reaches for the PG store at require time — stub it, as the
// matrix test does, so this file stays a pure unit test.
const filename = require.resolve('../stores/studioAppDataStore');
require.cache[filename] = {
    id: filename, filename, loaded: true,
    exports: { getMemberRole: async () => null },
};

const gateway = require('./rlsGateway');
const { PUBLIC_ROLE_KEY } = require('./dataModel');

const table = (access) => ({
    id: 'tbl_1',
    key: 'aanvragen',
    fields: [{ key: 'naam', type: 'text' }],
    access,
});

const ACTIONS = ['read', 'update', 'delete'];

test('the reserved key is what the public router actually uses', () => {
    assert.equal(PUBLIC_ROLE_KEY, 'public');
});

test('access.default "app" does NOT leak to the anonymous role', () => {
    const t = table({ default: 'app', roles: {} });
    // The control: an ordinary role DOES inherit it — that is the behaviour
    // this exception is carved out of, so it must still hold.
    assert.equal(gateway.resolveScope(t, 'medewerker', 'read'), 'all');
    assert.equal(gateway.resolveScope(t, 'medewerker', 'create'), true);
    // The anonymous role does not.
    for (const action of ACTIONS) {
        assert.equal(gateway.resolveScope(t, PUBLIC_ROLE_KEY, action), 'none', `${action} must be denied`);
    }
    assert.equal(gateway.resolveScope(t, PUBLIC_ROLE_KEY, 'create'), false);
});

test('canRead is false for a table that never mentions the anonymous role', () => {
    assert.equal(gateway.canRead(table({ default: 'app', roles: {} }), PUBLIC_ROLE_KEY), false);
});

test('an explicit grant is honoured — opting in is how a public form writes', () => {
    const t = table({
        default: 'app',
        roles: { [PUBLIC_ROLE_KEY]: { create: true, read: 'own', update: 'none', delete: 'none' } },
    });
    assert.equal(gateway.resolveScope(t, PUBLIC_ROLE_KEY, 'create'), true);
    assert.equal(gateway.resolveScope(t, PUBLIC_ROLE_KEY, 'read'), 'own');
    assert.equal(gateway.resolveScope(t, PUBLIC_ROLE_KEY, 'update'), 'none');
    assert.equal(gateway.resolveScope(t, PUBLIC_ROLE_KEY, 'delete'), 'none');
});

test('a PARTIAL grant still denies the actions it does not name', () => {
    // The realistic authoring mistake: "create: true" and nothing else. Update
    // and delete must not fall through to access.default.
    const t = table({ default: 'app', roles: { [PUBLIC_ROLE_KEY]: { create: true } } });
    assert.equal(gateway.resolveScope(t, PUBLIC_ROLE_KEY, 'create'), true);
    assert.equal(gateway.resolveScope(t, PUBLIC_ROLE_KEY, 'read'), 'none');
    assert.equal(gateway.resolveScope(t, PUBLIC_ROLE_KEY, 'update'), 'none');
    assert.equal(gateway.resolveScope(t, PUBLIC_ROLE_KEY, 'delete'), 'none');
});

test('assertCanWrite refuses an anonymous write the table never granted', () => {
    const t = table({ default: 'app', roles: {} });
    assert.throws(
        () => gateway.assertCanWrite(t, PUBLIC_ROLE_KEY, 'create'),
        (err) => err.name === 'AccessError' && err.status === 403,
    );
});

test('the deny compiles to a real 1=0 predicate, not merely an empty filter', () => {
    const t = table({ default: 'app', roles: {} });
    const { where } = gateway.compileAccessFilter(t, PUBLIC_ROLE_KEY, { id: 'anon:abc' }, 'read');
    assert.match(where, /1\s*=\s*0/);
});

test('an "own" grant scopes rows to the visitor id, so two strangers are isolated', () => {
    const t = table({
        default: 'app',
        roles: { [PUBLIC_ROLE_KEY]: { create: true, read: 'own' } },
    });
    const { where, params } = gateway.compileAccessFilter(t, PUBLIC_ROLE_KEY, { id: 'anon:abc' }, 'read');
    assert.match(where, /created_by/);
    assert.deepEqual(params, ['anon:abc']);
});
