/**
 * What POST /ai/user-settings accepts, and what it says when it refuses
 * (routes/ai/config/userSettings.js).
 *
 * The handler read each key by hand and wrote as it went, so a refusal
 * half-way left the fields before it already saved; `memoryEnabled: "false"`
 * was stored as true; `enabledApps` was stored as whatever arrived; and the
 * SignRequest subdomain was pasted into a URL unchecked. What this pins:
 *
 *   - nothing is written when anything in the body is refused;
 *   - a boolean is a boolean — the text "false" is a 400, not a "yes";
 *   - the 400 names the field and says what it takes.
 *
 * Run: cd server && node --test routes/ai/config/userSettings.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every config write lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../../stores/configStore': {
        getConfig: async () => null,
        getSecret: async () => null,
        setSecret: async (key, value) => { touched.push({ what: 'setSecret', key, value }); },
        setConfig: async (key, value) => { touched.push({ what: 'setConfig', key, value }); },
    },
    // The shapes below are the real modules' own (afasTools, nmbrsTools,
    // vplanTools); mocked so the test does not load the integrations.
    '../../../integrations/afasTools': {
        normalizeAfasToken: (raw) => (/^[0-9A-Fa-f]{16,128}$/.test(String(raw || '').trim()) ? `<token>${raw}</token>` : null),
    },
    '../../../integrations/nmbrsTools': {
        SUBDOMAIN_RE: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i,
        TOKEN_RE: /^[\x21-\x7E]{16,512}$/,
        EMAIL_RE: /^[^\s@,;]{1,128}@[^\s@,;]{1,128}$/,
    },
    '../../../integrations/vplanTools': {
        API_KEY_RE: /^[A-Za-z0-9._~-]{16,512}$/,
        API_ENV_RE: /^[A-Za-z0-9._~-]{4,128}$/,
    },
    '../../../learning/progressValidation': {
        sanitizeLearningProgress: (input) => (JSON.stringify(input).length > 1000
            ? { map: null, dropped: [], error: 'too_large' }
            : { map: input, dropped: [], error: null }),
        mergeLearningProgress: (a, b) => ({ ...a, ...b }),
    },
    '../../../stores/memoryQueries': {
        deleteSensitiveForUser: async (userId) => { touched.push({ what: 'deleteSensitive', key: userId }); return 0; },
    },
    '../../../learning/certificates': { readServerProgress: async () => ({}) },
    '../../../auth/permissions': { requireAuth: pass },
    '../../../auth/orgScope': { orgScope: async () => ({ orgId: null, homeOrgId: null }) },
    '../../../core/memory/memoryPolicy': {
        memoryEnabledKey: (userId) => `memory_enabled_user_${userId}`,
        memorySensitiveOptInKey: (userId) => `memory_sensitive_opt_in_user_${userId}`,
        isMemoryEnabledForUser: async () => true,
        getOrgMemorySettings: async () => ({ enabled: true, sensitiveOptInAllowed: orgAllowsSensitive, maxPerUser: 1000 }),
        ORG_DEFAULTS: { enabled: true, sensitiveOptInAllowed: false, maxPerUser: 1000 },
    },
};

let orgAllowsSensitive = false;
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:user-settings-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /config[\\/]userSettings\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./userSettings');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function post(body) {
    const url = '/user-settings';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('fell through: POST /user-settings'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const written = (key) => touched.find((t) => t.key === key);

test.beforeEach(() => { touched.length = 0; orgAllowsSensitive = false; });

test('memory switched off as the text "false" is refused, not stored as ON', async () => {
    const res = await post({ memoryEnabled: 'false' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.memoryEnabled'));
    assert.deepStrictEqual(touched, []);
});

test('memory switched off as a boolean is stored as off', async () => {
    const res = await post({ memoryEnabled: false });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written('memory_enabled_user_u1').value, false);
});

test('sensitive opt-in is refused with 403 when the organisation does not allow it', async () => {
    const res = await post({ memorySensitiveOptIn: true });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'sensitive_not_allowed');
    assert.deepStrictEqual(touched, []);
});

test('sensitive opt-in as the text "true" is refused', async () => {
    const res = await post({ memorySensitiveOptIn: 'true' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('sensitive opt-in on is stored when the organisation allows it, and deletes nothing', async () => {
    orgAllowsSensitive = true;
    const res = await post({ memorySensitiveOptIn: true });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written('memory_sensitive_opt_in_user_u1').value, true);
    assert.ok(!touched.some((t) => t.what === 'deleteSensitive'));
});

test('sensitive opt-in OFF is stored and hard-deletes the sensitive memories', async () => {
    const res = await post({ memorySensitiveOptIn: false });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written('memory_sensitive_opt_in_user_u1').value, false);
    assert.ok(touched.some((t) => t.what === 'deleteSensitive' && t.key === 'u1'));
});

test('a refused NMBRS token leaves the API mode as it was — nothing is half-saved', async () => {
    const res = await post({ nmbrsApiMode: 'rest', nmbrsEnv: 'sandbox', nmbrsToken: 'has spaces in it and more' });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /NMBRS token is invalid/);
    assert.deepStrictEqual(touched, []);
});

test('a refused AFAS token leaves the member number as it was', async () => {
    const res = await post({ afasMemberNumber: '12345', afasToken: 'not a token', afasEnvType: 'production' });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /AFAS token is not a valid AppConnector token/);
    assert.deepStrictEqual(touched, []);
});

test('the SignRequest subdomain is one DNS label, not a place to send a token', async () => {
    for (const sub of ['evil.example:8443/x?', 'team.signrequest.com', 'a b']) {
        const res = await post({ signrequestSubdomain: sub, signrequestToken: 'tok' });
        assert.strictEqual(res.statusCode, 400, sub);
        assert.ok(res.body.details.some((d) => d.path === 'body.signrequestSubdomain'));
    }
    assert.deepStrictEqual(touched, []);
    const ok = await post({ signrequestSubdomain: 'your-team' });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(written('signrequest_subdomain_user_u1').value, 'your-team');
});

test('enabledApps is a list: one app as text is refused, not stored for substring matching', async () => {
    const res = await post({ enabledApps: 'gmail' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
    const ok = await post({ enabledApps: ['gmail', 'google-drive'] });
    assert.strictEqual(ok.statusCode, 200);
    assert.deepStrictEqual(written('enabled_apps_user_u1').value, ['gmail', 'google-drive']);
});

test('the YouTrack URL has to be an http(s) address', async () => {
    const res = await post({ youtrackUrl: 'yourcompany.youtrack.cloud' });
    assert.strictEqual(res.statusCode, 400);
    const ok = await post({ youtrackUrl: 'https://yourcompany.youtrack.cloud' });
    assert.strictEqual(ok.statusCode, 200);
});

test('a learning path outside the list, or a reset as text, is refused instead of ignored', async () => {
    for (const body of [{ learningPath: 'Builder' }, { learningProgressReset: 'true' }, { simpleMode: 'false' }]) {
        const res = await post(body);
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(touched, []);
});

test('a misspelled key is refused, and the legacy EU switch says where EU mode lives now', async () => {
    const typo = await post({ firefliesApikey: 'k' });
    assert.strictEqual(typo.statusCode, 400);
    const eu = await post({ userEuModeEnabled: true });
    assert.strictEqual(eu.statusCode, 400);
    assert.match(eu.body.error, /Privacy Shield/);
    assert.deepStrictEqual(touched, []);
});

test('a too-large learning blob is refused before the other fields are written', async () => {
    const res = await post({ simpleMode: true, learningProgress: { lesson: 'x'.repeat(2000) } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('disconnect still clears with empty strings', async () => {
    const res = await post({ afasMemberNumber: '', afasToken: '', afasEnvType: '' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.map((t) => [t.key, t.value]), [
        ['afas_member_number_user_u1', ''],
        ['afas_token_user_u1', ''],
        ['afas_env_type_user_u1', ''],
    ]);
});

test('the NMBRS form as the settings screen sends it is accepted and stored lowercased', async () => {
    const res = await post({ nmbrsApiMode: 'SOAP', nmbrsEnv: 'production', nmbrsSubdomain: 'mycompany', nmbrsEmail: 'a@b.nl', nmbrsToken: 'abcdefghijklmnop1234' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written('nmbrs_api_mode_user_u1').value, 'soap');
});
