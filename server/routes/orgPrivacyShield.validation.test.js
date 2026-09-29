/**
 * What the two Privacy Shield saves accept, and what they say when they refuse
 * (routes/orgPrivacyShield.js, PUT /:orgId and PUT /user/me).
 *
 * Both saves rebuild the whole row from the body, and every field was read
 * with a fall-back. The fall-backs are what this file pins shut, because each
 * one answered "saved" while writing something else:
 *
 *   - `dlpEnabled: "false"` (a string) switched DLP ON;
 *   - `attachmentLargeInputPolicy: 'fail_closd'` became fail_OPEN;
 *   - `piiDetectionConfidenceThreshold: 70` was stored, and nothing scores 70;
 *   - `customSensitiveTerms: {…}` wiped every custom term;
 *   - `dlpEnabeld: true` was dropped, and the rebuild wrote DLP off;
 *   - `scope: { userInput: true }` switched output scanning OFF;
 *   - `privacy_scan_knowledge_bases: false` was never written at all.
 *
 * And the one thing the schema must NOT do: refuse the keys an older release
 * wrote into the row, which the admin page sends straight back.
 *
 * Run: cd server && node --test routes/orgPrivacyShield.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const rows = {};
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/configStore': {
        getConfig: async (key) => (rows[key] !== undefined ? rows[key] : null),
        setConfig: async (key, value) => { touched.push({ what: 'setConfig', args: [key, value] }); rows[key] = value; return true; },
    },
    '../stores/userStore': {},
    '../auth': { resolveUserOrgIds: async () => new Set(['org1']) },
    '../auth/permissions': {
        requireAuth: pass,
        isOrgAdminForOrg: async (req, orgId) => req.session.user.orgAdmin === true && orgId === 'org1',
    },
    '../license': { resolveTier: async () => 'enterprise', tiers: { tierHasFeature: () => true } },
    '../core/dlp/customTerms': { invalidate() {} },
    '../compliance/events': { EVENTS: { DLP_CONFIG_CHANGED: 'x' }, emit() {} },
    '../core/privacy/orgShield': { resolveOrgShield: async () => null },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:org-privacy-shield-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]orgPrivacyShield\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./orgPrivacyShield');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body, orgAdmin = true }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1', orgAdmin } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const ORG_KEY = 'org_privacy_shield_org1';
const USER_KEY = 'user_privacy_shield_u1';

/**
 * What the admin page really sends for an org that never saved: the GET's
 * default document, with the page's own fields laid over it
 * (agent-hub useOrgShield.js buildPayload).
 */
function pageBody(over = {}) {
    return {
        enabled: true, collectionIds: [], scope: { userInput: true, agentOutput: true }, action: 'delete',
        euModeEnabled: false, piiDetectionCategories: ['Person'], piiDetectionConfidenceThreshold: 0.7,
        piiDetectionAction: 'block', piiFailureMode: 'fail_closed', attachmentLargeInputPolicy: 'fail_open',
        webSearchGuardPiiCategories: [], toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
        monitorIntegrations: false, applyToAutomations: true, piiAllowTerms: [], piiAllowPublicOrgs: true,
        webSearchGuardEnabled: false, disableSearchOnUpload: false, privacy_scan_knowledge_bases: true,
        showRawPayload: false, dlpEnabled: false, dlpMode: 'ask', dlpAlwaysReview: false, customSensitiveTerms: [],
        ...over,
    };
}

async function refused(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.ok(res.body.details.some((d) => d.path === field), `the 400 must name ${field}: ${JSON.stringify(res.body.details)}`);
    assert.ok(!/Required|Invalid enum value|Expected/.test(res.body.error), `a sentence, not zod: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'a refused save writes nothing');
    return res;
}

test.beforeEach(() => {
    touched.length = 0;
    for (const k of Object.keys(rows)) delete rows[k];
});

// ═══ The org shield ═════════════════════════════════════════════════

test('the page\'s own body for a fresh org still saves', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: pageBody() });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(rows[ORG_KEY].enabled, true);
});

test('dlpEnabled "false" (a string) is refused, not read as ON', async () => {
    await refused({ method: 'PUT', url: '/org1', body: pageBody({ dlpEnabled: 'false' }) }, 'body.dlpEnabled');
});

test('a misspelled fail_closed is refused, not stored as fail_open', async () => {
    const res = await refused({
        method: 'PUT', url: '/org1', body: pageBody({ attachmentLargeInputPolicy: 'fail_closd' }),
    }, 'body.attachmentLargeInputPolicy');
    assert.strictEqual(res.body.error, 'attachmentLargeInputPolicy is fail_closed or fail_open.');
});

test('a threshold given as a percentage is refused, not stored where nothing scores', async () => {
    await refused({ method: 'PUT', url: '/org1', body: pageBody({ piiDetectionConfidenceThreshold: 70 }) }, 'body.piiDetectionConfidenceThreshold');
});

test('custom terms that are not a list are refused instead of wiping the list', async () => {
    rows[ORG_KEY] = pageBody({ customSensitiveTerms: [{ id: 't1', label: 'Project', pattern: 'Apollo', type: 'literal' }] });
    await refused({ method: 'PUT', url: '/org1', body: pageBody({ customSensitiveTerms: { id: 't1' } }) }, 'body.customSensitiveTerms');
    assert.strictEqual(rows[ORG_KEY].customSensitiveTerms.length, 1, 'the stored term is still there');
});

test('a body that does not say whether the shield is on is refused in words', async () => {
    const body = pageBody();
    delete body.enabled;
    const res = await refused({ method: 'PUT', url: '/org1', body }, 'body.enabled');
    assert.strictEqual(res.body.error, 'Say whether the Privacy Shield is on: enabled is true or false.');
});

test('a scope that leaves out agentOutput keeps output scanning ON, as a missing scope always did', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: pageBody({ scope: { userInput: true } }) });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(rows[ORG_KEY].scope, { userInput: true, agentOutput: true });
});

test('a scope flag of "false" (a string) or a misspelled one is refused', async () => {
    await refused({ method: 'PUT', url: '/org1', body: pageBody({ scope: { userInput: true, agentOutput: 'false' } }) }, 'body.scope.agentOutput');
    const res = await refused({ method: 'PUT', url: '/org1', body: pageBody({ scope: { userInput: true, agentOuput: false } }) }, 'body.scope.agentOuput');
    assert.strictEqual(res.body.error, 'scope.agentOuput is not a Privacy Shield setting.');
});

test('the legacy tool flags of an old scope are accepted when the page sends them back', async () => {
    rows[ORG_KEY] = { ...pageBody(), scope: { userInput: true, agentOutput: false, toolInput: true, toolOutput: true } };
    const res = await dispatch({
        method: 'PUT', url: '/org1',
        body: pageBody({ scope: { userInput: true, agentOutput: false, toolInput: true, toolOutput: true } }),
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(rows[ORG_KEY].scope, { userInput: true, agentOutput: false }, 'and dropped on write');
});

test('a misspelled setting is refused, not dropped while the rebuild writes it off', async () => {
    const res = await refused({ method: 'PUT', url: '/org1', body: pageBody({ dlpEnabeld: true }) }, 'body.dlpEnabeld');
    assert.strictEqual(res.body.error, 'dlpEnabeld is not a Privacy Shield setting.');
});

test('a key an older release wrote into the row is accepted when the page sends it back', async () => {
    rows[ORG_KEY] = { ...pageBody(), moderationEnabled: false, azurePiiEnabled: true, updatedAt: 'x', updatedBy: 'u0' };
    const res = await dispatch({
        method: 'PUT', url: '/org1',
        body: pageBody({ moderationEnabled: false, azurePiiEnabled: true, stalenessWarnings: [], clamped_fields: [], updatedAt: 'x' }),
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(!('moderationEnabled' in rows[ORG_KEY]), 'and dropped on write, as before');
    assert.ok(!('stalenessWarnings' in rows[ORG_KEY]), 'a response-only key is never persisted');
});

test('switching knowledge-base scanning off now sticks', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: pageBody({ privacy_scan_knowledge_bases: false }) });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(rows[ORG_KEY].privacy_scan_knowledge_bases, false);
    await dispatch({ method: 'PUT', url: '/org1', body: pageBody({ privacy_scan_knowledge_bases: undefined }) });
    assert.strictEqual(rows[ORG_KEY].privacy_scan_knowledge_bases, true, 'absent stays ON, like the runtime reads it');
});

test('a custom term with an unknown type or a string caseSensitive is reported, not saved', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/org1',
        body: pageBody({
            customSensitiveTerms: [
                { id: 'a', label: 'Dot', pattern: 'a.b', type: 'litteral' },
                { id: 'b', label: 'Acme', pattern: 'ACME', type: 'literal', caseSensitive: 'false' },
                { id: 'c', label: 'Kept', pattern: 'Apollo', type: 'literal', caseSensitive: false },
            ],
        }),
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.termErrors.map((e) => e.id), ['a', 'b']);
    assert.deepStrictEqual(rows[ORG_KEY].customSensitiveTerms.map((t) => t.id), ['c']);
});

test('a non-admin is still answered 403 for a well-formed body', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: pageBody(), orgAdmin: false });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(touched, []);
});

// ═══ The personal shield ════════════════════════════════════════════

/** What both clients send: the GET's document with their change laid over it. */
function personalBody(over = {}) {
    return {
        enabled: true, euModeEnabled: false, disableSearchOnUpload: false, piiDetectionEnabled: true,
        piiDetectionCategories: [], piiDetectionConfidenceThreshold: 0.7, piiDetectionAction: 'tokenize',
        piiFailureMode: 'fail_closed', showRawPayload: false, implicitDefault: true,
        ...over,
    };
}

test('the mobile app\'s echo of the secure default saves', async () => {
    const res = await dispatch({ method: 'PUT', url: '/user/me', body: personalBody() });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(rows[USER_KEY].enabled, true);
    assert.ok(!('implicitDefault' in rows[USER_KEY]));
});

test('a personal save that leaves out `enabled` is refused, not read as "shield off"', async () => {
    const body = personalBody();
    delete body.enabled;
    await refused({ method: 'PUT', url: '/user/me', body }, 'body.enabled');
});

test('a personal threshold of 70 is refused instead of clamped to 1', async () => {
    await refused({ method: 'PUT', url: '/user/me', body: personalBody({ piiDetectionConfidenceThreshold: 70 }) }, 'body.piiDetectionConfidenceThreshold');
});

test('a personal action the personal shield does not have is refused, not read as tokenize', async () => {
    await refused({ method: 'PUT', url: '/user/me', body: personalBody({ piiDetectionAction: 'warn' }) }, 'body.piiDetectionAction');
});

test('a misspelled personal setting is refused', async () => {
    await refused({ method: 'PUT', url: '/user/me', body: personalBody({ euMode: true }) }, 'body.euMode');
});
