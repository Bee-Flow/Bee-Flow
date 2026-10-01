/**
 * What /update-profile accepts, and what it says when it refuses
 * (auth/login/profileRoutes.js).
 *
 * The handler read three keys off the body and answered `{success:true}`
 * whatever it found: a mis-spelled `displayname` changed nothing under a 200,
 * and a `displayName` that was nothing but markup sanitised away to empty and
 * was then silently skipped — the person watched their name stay as it was
 * with the screen telling them it had saved. `avatarType` is what the renderer
 * branches on, so an unrecognised value quietly drew the default icon. What
 * this file pins:
 *
 *   - the 400 NAMES the field (`body.avatarType`), not just "invalid request";
 *   - the message is a sentence;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/login/profileRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/userStore': {
        updateUser: async (id, updates) => { touched.push({ what: 'updateUser', args: [id, updates] }); return true; },
    },
    '../permissions': { requireAuth: pass },
    '../../utils/htmlSanitizer': { sanitizePlainText: (v) => String(v).replace(/<[^>]*>/g, '').trim() },
    '../../utils/sessionToken': { deleteSessionToken: async () => {} },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:profile-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]profileRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./profileRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'u1' }, save(cb) { cb(); } }) });

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a misspelled name key is refused rather than answered "saved" with nothing changed', async () => {
    await refuses({ method: 'POST', url: '/update-profile', body: { displayname: 'Bob' } }, 'body');
});

test('an unknown avatar type is refused instead of quietly drawing the default icon', async () => {
    const res = await dispatch({ method: 'POST', url: '/update-profile', body: { avatar: 'x', avatarType: 'emojii' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'An avatar is an emoji, a url or an image.');
    assert.deepStrictEqual(touched, []);
});

test('a name that is nothing but markup is refused, not skipped under a 200', async () => {
    const res = await dispatch({ method: 'POST', url: '/update-profile', body: { displayName: '<b></b>' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'That display name is empty once markup is removed.');
    assert.deepStrictEqual(touched, []);
});

test('clearing the avatar is still a null, not a refusal', async () => {
    const res = await dispatch({ method: 'POST', url: '/update-profile', body: { avatar: null, avatarType: null } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateUser').args[1], { avatar: null, avatarType: null });
});

test('a name is sanitised once, on its way to the store', async () => {
    const res = await dispatch({ method: 'POST', url: '/update-profile', body: { displayName: '  <b>Bob</b>  ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateUser').args[1].displayName, 'Bob');
});
