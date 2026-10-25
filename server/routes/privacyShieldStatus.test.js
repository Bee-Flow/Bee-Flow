/**
 * routes/privacyShieldStatus.js — the status behind every privacy claim.
 *
 * What is pinned here, per PLAN-APP verification rule 2 ("every privacy or
 * status claim has a test that makes it disappear or change under the
 * no-configuration"):
 *   - anonymous is 401'd BEFORE any resolution runs (accessRegistry:
 *     enforcement 'middleware', verifiedBy this file);
 *   - the response has exactly one shape — the same key set on, off and on
 *     failure — and carries no ids, names, addresses or error text, whatever
 *     the session, the shield or the guard's health body contain;
 *   - the no-configuration reads as off even with a healthy guard, and a
 *     shield that is "on" without a reachable guard reads guardReachable:false
 *     (KRITIEK #13: no green lock while the detector cannot scan);
 *   - the branch taken for `action` follows the message path (DLP mode when
 *     the shield has DLP, else the legacy masking set), `source` says which
 *     switch applied, and the Cowork gate needs an org plus the flag;
 *   - the guard probe is memoised and shared, and the breaker outvotes it;
 *   - an unreadable configuration degrades to "off" with 200, never a 500.
 *
 * The resolution layer is stubbed at the require boundary (testUtils/stubRequire,
 * keys exactly as the route writes them); piiDetection/categories is real —
 * the masking set is the contract under test, not a fixture.
 *
 * Run: cd server && node --test --test-force-exit routes/privacyShieldStatus.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../testUtils/stubRequire');

// ── Fixture state the stubs read on every call ───────────────────────
const fx = {};
function resetFixture() {
    fx.aiConfig = { piiDetectionEnabled: false, piiDetectionAction: 'block' };
    fx.orgId = null;            // resolveEffectiveOrgId
    fx.orgShield = null;        // resolveOrgShield
    fx.userShield = null;       // resolveUserShield
    fx.coworkFlag = { enabled: false, configured: false };
    fx.eu = { isEU: false, source: 'none' };
    fx.endpoint = { url: null, apiKey: '' };
    fx.health = null;           // probeGuardHealth
    fx.circuitOpen = false;
    fx.throwOn = null;          // 'orgId' | 'aiConfig' | 'orgShield' | 'userShield' | 'chatMonitoring'
    fx.monitoring = null;       // resolveChatMonitoring
    fx.calls = { resolveEffectiveOrgId: 0, resolveOrgShield: [], resolveUserShield: [], probe: 0, monitoring: [] };
}
resetFixture();

// What the real resolver answers when chat signals are off.
const OFF_MONITORING_RESOLVED = Object.freeze({
    state: 'off', version: null, from: null, surfaces: [], paused: [], signals: [], noticeUrl: null, visitorNoticeUrl: null, retentionDays: 90,
});
const CHAT_MONITORING_OFF = { state: 'off', from: null, version: null, surfaces: [], signals: [], noticeUrl: null };

// Free text that must never reach the client (BFSF-441).
const SECRET_ERROR = 'ECONNREFUSED postgres://beeflow:hunter2@db:5432/beeflow_core';
const GUARD_LOAD_ERROR = 'Traceback: /home/ada/models/gliner: CUDA out of memory';

const stubs = {
    '../auth/permissions': {
        // Mirrors the decision line of the real requireAuth (auth/permissions.js).
        requireAuth(req, res, next) {
            if (!req.session || !req.session.isAuthenticated || !req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            return next();
        },
    },
    '../core/llm/modelResolver': {
        async resolveEffectiveOrgId() {
            fx.calls.resolveEffectiveOrgId++;
            if (fx.throwOn === 'orgId') throw new Error(SECRET_ERROR);
            return fx.orgId;
        },
        async isEUModeActive() { return fx.eu; },
    },
    '../core/aiAgent': {
        async getAIConfig() {
            if (fx.throwOn === 'aiConfig') throw new Error(SECRET_ERROR);
            return fx.aiConfig;
        },
    },
    '../core/privacy/orgShield': {
        async resolveOrgShield(orgId) {
            fx.calls.resolveOrgShield.push(orgId);
            if (fx.throwOn === 'orgShield') throw new Error(SECRET_ERROR);
            return fx.orgShield;
        },
        async resolveUserShield(userId, opts) {
            fx.calls.resolveUserShield.push([userId, opts]);
            if (fx.throwOn === 'userShield') throw new Error(SECRET_ERROR);
            return fx.userShield;
        },
    },
    '../core/entitlements/coworkShieldFlag': {
        // The real reader: null org → off, never throws.
        async resolveCoworkShieldFlag(orgId) {
            return orgId ? fx.coworkFlag : { enabled: false, configured: false };
        },
    },
    '../core/privacy/piiDetection': {
        async getGuardEndpoint() { return fx.endpoint; },
    },
    '../core/privacy/piiDetection/requestShaping': {
        circuitIsOpen: () => fx.circuitOpen,
    },
    '../services/guardInstaller': {
        async probeGuardHealth() { fx.calls.probe++; return fx.health; },
    },
    '../core/entitlements/chatMonitoringFlag': {
        async resolveChatMonitoring(orgKey) {
            fx.calls.monitoring.push(orgKey);
            if (fx.throwOn === 'chatMonitoring') throw new Error(SECRET_ERROR);
            return fx.monitoring || OFF_MONITORING_RESOLVED;
        },
    },
};
const restore = installResolveStub(stubs);
const router = require('./privacyShieldStatus');
after(() => restore());

// ── Dispatch straight into the router (routes/documents.authz.test.js idiom) ─
function dispatch(session, url = '/') {
    return new Promise((resolve, reject) => {
        const req = { method: 'GET', url, body: {}, headers: {}, query: {}, session, get() { return undefined; } };
        const res = {
            statusCode: 200,
            headers: {},
            status(c) { this.statusCode = c; return this; },
            set(k, v) { this.headers[k] = v; return this; },
            setHeader(k, v) { this.headers[k] = v; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: GET ${url}`)));
    });
}

// Deliberately full of personal data — none of it may come back.
const USER = { id: 'u-4711', email: 'ada@example.org', name: 'Ada Lovelace', organizationId: 'org-acme-42' };
const SIGNED_IN = { isAuthenticated: true, user: USER };
const ANON = undefined;

const KEYS = ['action', 'chatMonitoring', 'coworkEnabled', 'enabled', 'euMode', 'failMode', 'guardReachable', 'source'];

// A resolved org shield the way resolveOrgShield returns it (subset).
const ORG_SHIELD = {
    enabled: true, piiDetectionAction: 'tokenize', piiFailureMode: 'fail_closed',
    dlpEnabled: false, dlpMode: 'ask', euModeEnabled: false,
    rulesWithNames: [{ name: 'IBAN of Ada' }], customSensitiveTerms: ['Project Nightingale'],
};
// The implicit personal default (userShieldDefaults) as resolveUserShield shapes it.
const USER_SHIELD = { enabled: true, piiDetectionAction: 'tokenize', piiFailureMode: 'fail_closed', dlpEnabled: false };

const healthyGuard = () => {
    fx.endpoint = { url: 'http://guard:8000', apiKey: 'k' };
    fx.health = { status: 'ok', pii_model: 'ok', load_error: null };
};

beforeEach(() => {
    resetFixture();
    router._resetGuardMemo();
});

// ── Gate ─────────────────────────────────────────────────────────────
test('anonymous is 401 before any resolution runs', async () => {
    const res = await dispatch(ANON);
    assert.equal(res.statusCode, 401);
    assert.equal(fx.calls.resolveEffectiveOrgId, 0, 'the gate must fall before the org lookup');
    assert.equal(fx.calls.probe, 0, 'and before any guard probe');
});

test('a half-built session (no isAuthenticated / no user) is still 401', async () => {
    assert.equal((await dispatch({ user: USER })).statusCode, 401);
    assert.equal((await dispatch({ isAuthenticated: true })).statusCode, 401);
});

// ── Shape and content ────────────────────────────────────────────────
test('signed in with an org shield and a healthy guard: the exact payload', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = ORG_SHIELD;
    healthyGuard();
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
        enabled: true,
        source: 'org',
        action: 'redact',
        failMode: 'fail_closed',
        guardReachable: true,
        euMode: false,
        coworkEnabled: false,
        chatMonitoring: CHAT_MONITORING_OFF,
    });
    assert.equal(res.headers['Cache-Control'], 'no-store', 'a proxy-cached claim is a stale green lock');
});

test('the key set is fixed and the payload carries no personal data, rules or guard text', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = ORG_SHIELD;
    healthyGuard();
    fx.health = { status: 'ok', pii_model: 'ok', load_error: GUARD_LOAD_ERROR, backend: 'cuda' };
    const res = await dispatch(SIGNED_IN);
    assert.deepEqual(Object.keys(res.body).sort(), KEYS);
    const wire = JSON.stringify(res.body);
    for (const leak of [USER.id, USER.email, 'Ada', 'Lovelace', USER.organizationId, 'IBAN', 'Nightingale', 'Traceback', 'cuda', 'guard:8000']) {
        assert.ok(!wire.includes(leak), `payload must not contain "${leak}": ${wire}`);
    }
    for (const [k, v] of Object.entries(res.body)) {
        if (k === 'chatMonitoring') continue; // its own allow-list, pinned below
        assert.ok(v === null || typeof v === 'boolean' || typeof v === 'string', 'booleans and enums only');
    }
});

test('every answer — on, off and on failure — has the same key set', async () => {
    assert.deepEqual(Object.keys(router.OFF).sort(), KEYS);
    const on = router.summarizeShield({
        aiConfig: fx.aiConfig, orgShield: ORG_SHIELD, userShield: null, orgId: 'o', coworkFlagOn: true, guardReachable: true, euMode: true,
    });
    assert.deepEqual(Object.keys(on), Object.keys(router.OFF), 'same keys in the same order as OFF');
});

// ── The no-configuration: nothing is claimed ─────────────────────────
test('nothing configured reads as off — a healthy guard alone is no claim', async () => {
    fx.orgId = 'org-acme-42';
    healthyGuard();
    const res = await dispatch(SIGNED_IN);
    assert.deepEqual(res.body, {
        enabled: false, source: 'off', action: null, failMode: 'fail_closed',
        guardReachable: true, euMode: false, coworkEnabled: false, chatMonitoring: CHAT_MONITORING_OFF,
    });
});

test('an org member whose org shield is off gets no implicit personal shield', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = null;
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.body.enabled, false);
    assert.deepEqual(fx.calls.resolveOrgShield, ['org-acme-42']);
    assert.deepEqual(fx.calls.resolveUserShield, [['u-4711', { allowImplicitDefault: false }]],
        'resolveShieldFor\'s rule: an org member only gets an EXPLICIT personal shield');
});

// ── KRITIEK #13: shield "on" is not enough ───────────────────────────
test('shield on but no guard configured: enabled true, guardReachable false, no probe', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = ORG_SHIELD;
    fx.endpoint = { url: null, apiKey: '' };
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.guardReachable, false, 'without a guard detectPii() is null and nothing is scanned');
    assert.equal(fx.calls.probe, 0, 'nothing to probe when no endpoint is configured');
});

test('shield on, guard configured but answering 503 (model loading / failed): guardReachable false', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = ORG_SHIELD;
    fx.endpoint = { url: 'http://guard:8000', apiKey: 'k' };
    fx.health = null; // probeGuardHealth returns null on any non-200
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.guardReachable, false);
    assert.equal(fx.calls.probe, 1);
});

test('an open breaker outvotes a fresh healthy memo', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = ORG_SHIELD;
    healthyGuard();
    assert.equal((await dispatch(SIGNED_IN)).body.guardReachable, true);
    fx.circuitOpen = true;
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.body.guardReachable, false, 'three failed scans moments ago beat a 15 s old /health');
    assert.equal(fx.calls.probe, 1, 'the breaker answers without probing');
});

// ── The probe is cheap: memoised and shared ──────────────────────────
test('the guard probe runs once per window and concurrent polls share it', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = ORG_SHIELD;
    healthyGuard();
    const [a, b] = await Promise.all([dispatch(SIGNED_IN), dispatch(SIGNED_IN)]);
    assert.equal(a.body.guardReachable, true);
    assert.equal(b.body.guardReachable, true);
    assert.equal(fx.calls.probe, 1, 'two concurrent requests, one /health call');
    await dispatch(SIGNED_IN);
    assert.equal(fx.calls.probe, 1, 'a third request inside the window reads the memo');
    router._resetGuardMemo();
    await dispatch(SIGNED_IN);
    assert.equal(fx.calls.probe, 2, 'an expired memo probes again');
});

test('a failed probe is memoised too (never throws)', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = ORG_SHIELD;
    fx.endpoint = { url: 'http://guard:8000', apiKey: 'k' };
    stubs['../services/guardInstaller'].probeGuardHealth = async () => { fx.calls.probe++; throw new Error(SECRET_ERROR); };
    try {
        const res = await dispatch(SIGNED_IN);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.guardReachable, false);
        await dispatch(SIGNED_IN);
        assert.equal(fx.calls.probe, 1, 'a broken guard is not re-probed on every poll');
        assert.ok(!JSON.stringify(res.body).includes('hunter2'));
    } finally {
        stubs['../services/guardInstaller'].probeGuardHealth = async () => { fx.calls.probe++; return fx.health; };
    }
});

// ── action follows the branch the message path takes ────────────────
test('with DLP enabled the DLP mode decides: ask / auto_redact / block, default ask', async () => {
    fx.orgId = 'org-acme-42';
    for (const [dlpMode, expected] of [['ask', 'ask'], ['auto_redact', 'redact'], ['block', 'block'], [undefined, 'ask']]) {
        fx.orgShield = { ...ORG_SHIELD, dlpEnabled: true, dlpMode, piiDetectionAction: 'tokenize' };
        assert.equal((await dispatch(SIGNED_IN)).body.action, expected, `dlpMode=${dlpMode}`);
    }
});

test('without DLP the legacy masking set decides: tokenize/redact/warn mask, block refuses', async () => {
    fx.orgId = 'org-acme-42';
    for (const [piiDetectionAction, expected] of [['tokenize', 'redact'], ['redact', 'redact'], ['warn', 'redact'], ['block', 'block']]) {
        fx.orgShield = { ...ORG_SHIELD, piiDetectionAction };
        assert.equal((await dispatch(SIGNED_IN)).body.action, expected, `piiDetectionAction=${piiDetectionAction}`);
    }
});

test('a stored "allow" scans nothing, so it reads as off', async () => {
    fx.aiConfig = { piiDetectionEnabled: true, piiDetectionAction: 'allow' };
    const res = await dispatch(SIGNED_IN);
    assert.deepEqual([res.body.enabled, res.body.source, res.body.action], [false, 'off', null]);
});

// ── source ──────────────────────────────────────────────────────────
test('a personal account without an org runs on its (implicit) personal shield', async () => {
    fx.orgId = null;
    fx.userShield = USER_SHIELD;
    healthyGuard();
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.body.source, 'personal');
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.action, 'redact');
    assert.deepEqual(fx.calls.resolveOrgShield, [], 'no org, no org lookup');
    assert.deepEqual(fx.calls.resolveUserShield, [['u-4711', { allowImplicitDefault: true }]]);
});

test('the global admin toggle alone reads as platform, with the global action', async () => {
    fx.orgId = 'org-acme-42';
    fx.aiConfig = { piiDetectionEnabled: true, piiDetectionAction: 'block' };
    let res = await dispatch(SIGNED_IN);
    assert.deepEqual([res.body.enabled, res.body.source, res.body.action], [true, 'platform', 'block']);
    fx.aiConfig = { piiDetectionEnabled: true, piiDetectionAction: 'tokenize' };
    res = await dispatch(SIGNED_IN);
    assert.equal(res.body.action, 'redact');
});

test('the org shield wins over the platform toggle for source and action', async () => {
    fx.orgId = 'org-acme-42';
    fx.aiConfig = { piiDetectionEnabled: true, piiDetectionAction: 'block' };
    fx.orgShield = ORG_SHIELD; // tokenize
    const res = await dispatch(SIGNED_IN);
    assert.deepEqual([res.body.source, res.body.action], ['org', 'redact']);
});

// ── failMode / euMode ───────────────────────────────────────────────
test('failMode follows the shield, defaults fail_closed, and unknown values read fail_closed', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = { ...ORG_SHIELD, piiFailureMode: 'fail_open' };
    assert.equal((await dispatch(SIGNED_IN)).body.failMode, 'fail_open');
    fx.orgShield = { ...ORG_SHIELD, piiFailureMode: undefined };
    assert.equal((await dispatch(SIGNED_IN)).body.failMode, 'fail_closed');
    fx.orgShield = { ...ORG_SHIELD, piiFailureMode: 'whatever' };
    assert.equal((await dispatch(SIGNED_IN)).body.failMode, 'fail_closed');
});

test('euMode mirrors modelResolver.isEUModeActive', async () => {
    fx.eu = { isEU: true, source: 'org' };
    assert.equal((await dispatch(SIGNED_IN)).body.euMode, true);
    fx.eu = { isEU: false, source: 'none' };
    assert.equal((await dispatch(SIGNED_IN)).body.euMode, false);
});

// ── Cowork: org + flag + gate ────────────────────────────────────────
test('coworkEnabled needs an org, the per-org flag AND the gate', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = ORG_SHIELD;
    fx.coworkFlag = { enabled: true, configured: true };
    assert.equal((await dispatch(SIGNED_IN)).body.coworkEnabled, true);

    fx.coworkFlag = { enabled: false, configured: true };
    assert.equal((await dispatch(SIGNED_IN)).body.coworkEnabled, false, 'flag off');

    fx.coworkFlag = { enabled: true, configured: true };
    fx.orgShield = null;
    assert.equal((await dispatch(SIGNED_IN)).body.coworkEnabled, false, 'gate off');

    fx.orgId = null;
    fx.userShield = USER_SHIELD;
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.body.enabled, true, 'the personal shield covers chat…');
    assert.equal(res.body.coworkEnabled, false, '…but the Cowork path has no org, hence no claim');
});

// ── Unreadable configuration: degrade, never 500 ─────────────────────
test('a resolution failure answers 200 with the off shape and no error text', async () => {
    fx.orgId = 'org-acme-42';
    healthyGuard();
    for (const stage of ['aiConfig', 'orgShield', 'userShield']) {
        fx.throwOn = stage;
        fx.orgShield = stage === 'userShield' ? null : ORG_SHIELD;
        const res = await dispatch(SIGNED_IN);
        assert.equal(res.statusCode, 200, `${stage}: no 500`);
        assert.deepEqual(res.body, router.OFF, `${stage}: the off shape, guardReachable included`);
        assert.ok(!JSON.stringify(res.body).includes('hunter2'), `${stage}: no error text`);
    }
});

test('an org lookup failure is treated as "no org", not as a failure', async () => {
    fx.throwOn = 'orgId';
    fx.userShield = USER_SHIELD;
    healthyGuard();
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.statusCode, 200);
    assert.deepEqual([res.body.enabled, res.body.source, res.body.guardReachable], [true, 'personal', true]);
});

// ── The status is always the caller's own ────────────────────────────
test('a query naming another org is refused, not answered with the caller\'s own status', async () => {
    // `?orgId=` was ignored under a 200, so whoever asked about org B read
    // org A's green lock as B's.
    fx.orgId = 'org-acme-42';
    fx.orgShield = ORG_SHIELD;
    healthyGuard();
    const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
    const res = await new Promise((resolve, reject) => {
        const req = { method: 'GET', url: '/?orgId=org-b', body: {}, headers: {}, query: { orgId: 'org-b' }, session: SIGNED_IN, get() { return undefined; } };
        const out = {
            statusCode: 200, headersSent: false, headers: {},
            status(c) { this.statusCode = c; return this; },
            set(k, v) { this.headers[k] = v; return this; },
            setHeader(k, v) { this.headers[k] = v; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, out, (err) => (err ? terminalErrorHandler(err, req, out, reject) : reject(new Error('fell through'))));
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'The Privacy Shield status is always your own; it takes no query parameters.');
    assert.equal(fx.calls.resolveEffectiveOrgId, 0, 'nothing was resolved for it');
});

// ── Chat signals: the in-chat notice rides on this status ────────────
const SCHEDULED = Object.freeze({
    state: 'scheduled', version: '2026-10-14T09:00:00.000Z', from: '2026-10-14',
    surfaces: ['direct', 'agent_public'], paused: [{ surface: 'agent', missing: ['works_council_pending'] }],
    signals: ['outcomes', 'kinds'], noticeUrl: 'https://acme.example/chat-signals', visitorNoticeUrl: 'https://acme.example/privacy',
    retentionDays: 30,
});

test('chat signals off: the off block, and it is the same in OFF', async () => {
    assert.deepEqual(router.OFF.chatMonitoring, CHAT_MONITORING_OFF);
    const res = await dispatch(SIGNED_IN);
    assert.deepEqual(res.body.chatMonitoring, CHAT_MONITORING_OFF);
});

test('chat signals scheduled: the chat types, the date and the version; paused types are never listed', async () => {
    fx.orgId = 'org-acme-42';
    fx.monitoring = SCHEDULED;
    const res = await dispatch(SIGNED_IN);
    assert.deepEqual(res.body.chatMonitoring, {
        state: 'scheduled', from: '2026-10-14', version: '2026-10-14T09:00:00.000Z',
        surfaces: ['direct', 'agent_public'], signals: ['outcomes', 'kinds'], noticeUrl: 'https://acme.example/chat-signals',
    });
    assert.deepEqual(fx.calls.monitoring, ['org-acme-42'], 'the caller\'s effective org, as the recorder keys it');
    const wire = JSON.stringify(res.body.chatMonitoring);
    for (const leak of ['agent"', 'works_council', 'paused', 'privacy', 'retention', 'org-acme-42']) {
        assert.ok(!wire.includes(leak), `chatMonitoring carries "${leak}": ${wire}`);
    }
});

test('chat signals: a caller without an org is told about the default bucket, independent of the shield', async () => {
    fx.monitoring = { ...SCHEDULED, state: 'on' };
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.body.enabled, false, 'no shield at all…');
    assert.equal(res.body.chatMonitoring.state, 'on', '…and still the notice: transparency does not depend on the shield');
    assert.deepEqual(fx.calls.monitoring, ['default']);
});

test('chat signals: a non-https notice link is dropped; unknown chat types and signals are filtered', async () => {
    fx.monitoring = { ...SCHEDULED, noticeUrl: 'http://acme.example/n', surfaces: ['direct', 'project_chat', 'talk'], signals: ['outcomes', 'health'] };
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.body.chatMonitoring.noticeUrl, null);
    assert.deepEqual(res.body.chatMonitoring.surfaces, ['direct']);
    assert.deepEqual(res.body.chatMonitoring.signals, ['outcomes']);
    fx.monitoring = { ...SCHEDULED, noticeUrl: 'javascript:alert(1)' };
    assert.equal((await dispatch(SIGNED_IN)).body.chatMonitoring.noticeUrl, null);
});

test('chat signals: a state that cannot be tied to a version reads off (no version, no marker, no notice)', async () => {
    for (const bad of [
        { ...SCHEDULED, version: null },
        { ...SCHEDULED, version: '14 October 2026' },
        { ...SCHEDULED, state: 'maybe' },
        { ...SCHEDULED, surfaces: [] },
        { ...SCHEDULED, signals: ['kinds'] },
    ]) {
        fx.monitoring = bad;
        assert.deepEqual((await dispatch(SIGNED_IN)).body.chatMonitoring, CHAT_MONITORING_OFF, JSON.stringify(bad));
    }
});

test('chat signals: a resolver failure reads off with 200 and no error text; the shield answer is unaffected', async () => {
    fx.orgId = 'org-acme-42';
    fx.orgShield = ORG_SHIELD;
    healthyGuard();
    fx.throwOn = 'chatMonitoring';
    const res = await dispatch(SIGNED_IN);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.chatMonitoring, CHAT_MONITORING_OFF);
    assert.equal(res.body.enabled, true);
    assert.ok(!JSON.stringify(res.body).includes('hunter2'));
});

test('chat signals: the pure fold sanitises whatever it is handed', () => {
    const on = router.summarizeShield({
        aiConfig: fx.aiConfig, orgShield: null, userShield: null, orgId: null, coworkFlagOn: false, guardReachable: false, euMode: false,
        chatMonitoring: { ...SCHEDULED, extra: 'org-acme-42', surfaces: ['agent', 'direct', 'agent'] },
    });
    assert.deepEqual(Object.keys(on.chatMonitoring).sort(), ['from', 'noticeUrl', 'signals', 'state', 'surfaces', 'version']);
    assert.deepEqual(on.chatMonitoring.surfaces, ['direct', 'agent'], 'vocabulary order, no duplicates');
    const none = router.summarizeShield({ aiConfig: fx.aiConfig, orgShield: null, userShield: null, orgId: null, coworkFlagOn: false, guardReachable: false, euMode: false });
    assert.deepEqual(none.chatMonitoring, CHAT_MONITORING_OFF, 'no answer is the off answer');
});

