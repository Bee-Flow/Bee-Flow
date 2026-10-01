/**
 * What POST /settings accepts, and what it says when it refuses
 * (auth/login/instanceSettingsRoutes.js).
 *
 * This is a WHOLE-FORM save of the installation's own OAuth credentials, and
 * it wrote both visible fields unconditionally: `config.oauth.clientId =
 * clientId || ''`. So a body carrying only `clientId` BLANKED the Nextcloud
 * URL, and a body that mis-spelled `clientSecret` answered 200 while the
 * operator believed they had rotated the instance secret. What this file pins:
 *
 *   - the 400 NAMES the field (`body.nextcloudUrl`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - a partial save is refused rather than erasing the half it omits;
 *   - the config is never written, so a refused save changes nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/login/instanceSettingsRoutes.validation.test.js
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
    '../permissions': {
        requireSuperAdmin: pass,
        loadConfig: async () => ({ oauth: { nextcloudUrl: 'https://nc.example.test', clientId: 'cid', clientSecret: 'kept' } }),
        saveConfig: (cfg) => { touched.push({ what: 'saveConfig', args: [cfg] }); return true; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:instance-settings-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]instanceSettingsRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./instanceSettingsRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'root' }, isAdmin: true }) });

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

test('a save that names only the client id is refused instead of blanking the URL', async () => {
    await refuses({ method: 'POST', url: '/settings', body: { clientId: 'cid' } }, 'body.nextcloudUrl');
});

test('a missing field is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/settings', body: { nextcloudUrl: 'https://nc.example.test' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Enter the OAuth client id of this installation.');
});

test('a misspelled secret is refused rather than answered "saved" with nothing rotated', async () => {
    await refuses({
        method: 'POST', url: '/settings',
        body: { nextcloudUrl: 'https://nc.example.test', clientId: 'cid', clientSecrett: 'new' },
    }, 'body');
});

test('a whole-form save still writes all three, and a blank secret keeps the stored one', async () => {
    const res = await dispatch({
        method: 'POST', url: '/settings',
        body: { nextcloudUrl: ' https://nc.example.test ', clientId: ' cid2 ' },
    });
    assert.strictEqual(res.statusCode, 200);
    const saved = touched.find((t) => t.what === 'saveConfig').args[0];
    assert.strictEqual(saved.oauth.nextcloudUrl, 'https://nc.example.test');
    assert.strictEqual(saved.oauth.clientId, 'cid2');
    assert.strictEqual(saved.oauth.clientSecret, 'kept');
});
