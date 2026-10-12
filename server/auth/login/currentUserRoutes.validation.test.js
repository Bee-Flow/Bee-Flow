/**
 * What /consents/optional accepts, and what it says when it refuses
 * (auth/login/currentUserRoutes.js).
 *
 * This route writes a CONSENT LEDGER ROW — the record of what a person decided
 * about their own data, and for the voiceprint consent a withdrawal also
 * deletes the stored template. It read the decision as `granted === true`, so
 * `"true"`, `1` and a body that forgot the field altogether ALL meant WITHDRAW,
 * and the row was filed as `consent_withdraw` as if the person had asked for
 * it. What this file pins:
 *
 *   - the 400 NAMES the field (`body.granted`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the ledger is never written, so a refused request records no decision.
 *
 * Run: cd server && node --test --test-force-exit auth/login/currentUserRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const hit = (what) => (...args) => { touched.push({ what, args }); };

const MOCKS = {
    '../../stores/userStore': {
        getUser: async (id) => ({ id, email: 'u@example.test', organizationId: null }),
        recordConsentAcceptance: async (row) => { touched.push({ what: 'recordConsentAcceptance', args: [row] }); },
        getOptionalConsents: async () => ({}),
        setOptionalConsents: async (id, state) => { touched.push({ what: 'setOptionalConsents', args: [id, state] }); },
    },
    '../../legal/documentRegistry': {
        optionalConsents: () => [],
        getOptionalConsent: (id) => (id === 'marketing' ? { id: 'marketing', version: '1', enabled: true } : null),
        VOICEPRINT_CONSENT_ID: 'voiceprint',
    },
    '../../stores/voiceprintStore': { deleteVoiceprintForUser: hit('deleteVoiceprintForUser') },
    '../consentGuards': { auditClientIp: () => '203.0.113.1' },
    '../permissions': { loadConfig: async () => ({ oauth: {} }) },
    '../../stores/encryptionAvailability': { isEncryptionEnabledForUser: async () => false },
    '../../stores/configStore': { getConfig: async () => null },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:current-user-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]currentUserRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./currentUserRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ isAuthenticated: true, user: { id: 'u1' } }) });

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

test('a consent change that does not say yes or no is refused, not filed as a withdrawal', async () => {
    const res = await dispatch({ method: 'POST', url: '/consents/optional', body: { id: 'marketing' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Say whether the consent is given or withdrawn.');
    assert.ok(res.body.details.some((d) => d.path === 'body.granted'));
    assert.deepStrictEqual(touched, [], 'no ledger row may be written for a decision nobody made');
});

test('the string "true" is refused instead of meaning its opposite', async () => {
    await refuses({ method: 'POST', url: '/consents/optional', body: { id: 'marketing', granted: 'true' } }, 'body.granted');
});

test('a misspelled key is refused rather than read as a withdrawal', async () => {
    await refuses({ method: 'POST', url: '/consents/optional', body: { id: 'marketing', grantd: true } }, 'body');
});

test('a real grant still reaches the ledger as a grant', async () => {
    const res = await dispatch({ method: 'POST', url: '/consents/optional', body: { id: 'marketing', granted: true } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'recordConsentAcceptance').args[0].method, 'consent_grant');
});
