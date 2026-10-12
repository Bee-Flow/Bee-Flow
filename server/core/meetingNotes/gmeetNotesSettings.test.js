/**
 * Google Meet → Meeting Notes settings tests.
 *
 * Pins the org/user resolution contract (org wins scalars, exclusion arrays
 * unioned), the per-meeting/per-series import toggle, the Meet scope helpers
 * and the /api/gmeet-notes-settings routes (auth gates + connection block
 * derivation from live session / vault credential).
 *
 * Deps are stubbed via the Module resolve hook (configStore in-memory,
 * automationCredentialStore + auth fixtures for the router).
 *
 * Run: cd server && node --test core/meetingNotes/gmeetNotesSettings.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    docs: new Map(),        // configStore backing map
    cred: null,             // automationCredentialStore.getCredential fixture
    orgIds: new Set(['orgA']), // resolveUserOrgIds fixture (null = all orgs)
    isOrgAdmin: false,
};

const MOCKS = [
    {
        parentRe: /core[\\/]meetingNotes[\\/]gmeetNotesSettings\.js$/,
        request: '../../stores/configStore',
        exports: {
            getConfig: async (k) => (fx.docs.has(k) ? fx.docs.get(k) : null),
            setConfig: async (k, v) => { fx.docs.set(k, v); },
        },
    },
    {
        parentRe: /routes[\\/]gmeetNotesSettings\.js$/,
        request: '../auth',
        exports: { resolveUserOrgIds: async () => fx.orgIds },
    },
    {
        parentRe: /routes[\\/]gmeetNotesSettings\.js$/,
        request: '../auth/permissions',
        exports: {
            requireAuth: (req, res, next) => {
                if (!req.session || !req.session.user) return res.status(401).json({ error: 'Authentication required' });
                next();
            },
            isOrgAdminForOrg: async () => fx.isOrgAdmin,
        },
    },
    {
        parentRe: /routes[\\/]gmeetNotesSettings\.js$/,
        request: '../stores/automationCredentialStore',
        exports: { getCredential: async () => fx.cred },
    },
];
for (const mock of MOCKS) {
    mock.id = `mock:gmeet:${mock.request}`;
    require.cache[mock.id] = { id: mock.id, filename: mock.id, loaded: true, exports: mock.exports };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent) {
        const hit = MOCKS.find(m => m.request === request && m.parentRe.test(parent.filename));
        if (hit) return hit.id;
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const gmeetNotes = require('./gmeetNotesSettings');
const router = require('../../routes/gmeetNotesSettings');

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.docs.clear();
    fx.cred = null;
    fx.orgIds = new Set(['orgA']);
    fx.isOrgAdmin = false;
}

function makeSession(extra = {}) {
    return { user: { id: 'u1', email: 'tom@example.com' }, ...extra };
}

function dispatch({ method = 'GET', url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const request = { method, url, body, headers: {}, session };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

// ═══ resolution precedence ══════════════════════════════════════════

test('resolve: org wins scalars; de uitsluitingen zitten hier NIET meer in', async () => {
    resetFx();
    fx.docs.set('org_gmeet_notes_orgA', { autoImport: true, language: 'en', excludedEventIds: ['e1'], excludedMeetingCodes: ['abc-defg-hij'] });
    fx.docs.set('user_gmeet_notes_u1', { autoImport: false, language: 'de', lookbackHours: 48, excludedEventIds: ['e2', 'e1'], excludedMeetingCodes: ['xyz-xyzx-yzx'] });
    const s = await gmeetNotes.resolveGmeetNotesSettings({ orgId: 'orgA', userId: 'u1' });
    assert.strictEqual(s.autoImport, true, 'org scalar wins over user');
    assert.strictEqual(s.language, 'en');
    assert.strictEqual(s.lookbackHours, 48, 'user value used when org doc lacks the key');

    // M5: de per-vergadering keuze is verhuisd naar stores/meetingPrefsStore.
    // Resolve mag die arrays NIET meer teruggeven — een lezer die hier was
    // blijven hangen zou een lege lijst zien en dus importeren wat iemand had
    // uitgezet. Ze staan nog wél in het opgeslagen document (rollback).
    assert.ok(!('excludedEventIds' in s), 'verhuisd naar meeting_prefs');
    assert.ok(!('excludedMeetingCodes' in s), 'verhuisd naar meeting_prefs');
    assert.deepStrictEqual(fx.docs.get('user_gmeet_notes_u1').excludedEventIds, ['e2', 'e1'], 'het document blijft ongemoeid');
});

test('resolve: user fallback, then defaults; bad values coerced', async () => {
    resetFx();
    fx.docs.set('user_gmeet_notes_u1', { autoImport: true, importScope: 'bogus', lookbackHours: 'NaN' });
    const s = await gmeetNotes.resolveGmeetNotesSettings({ orgId: 'orgA', userId: 'u1' });
    assert.strictEqual(s.autoImport, true, 'user scalar used when no org doc');
    assert.strictEqual(s.importScope, 'organizer', 'invalid importScope coerced to default');
    assert.strictEqual(s.lookbackHours, 24, 'non-numeric lookback falls back to default');
    assert.strictEqual(s.autoRecordConfig, false, 'missing keys → DEFAULTS');
});

// ═══ de per-vergadering toggle is verhuisd ══════════════════════════

test('setMeetingImport bestaat hier niet meer — de toggle schrijft meeting_prefs', () => {
    // Stond er als exclusielijst-mutator. De route schrijft nu rechtstreeks
    // meetingPrefsStore.setRecord (per gebruiker, driewaardig). Blijft deze
    // functie bestaan, dan is er een tweede waarheid en wint per ongeluk de
    // oudste schrijver — precies wat deze verhuizing moest opheffen.
    assert.strictEqual(gmeetNotes.setMeetingImport, undefined);
});

// ═══ scope helpers ══════════════════════════════════════════════════

test('hasMeetScopes/hasSettingsScope: null-safe, exact space-split match', () => {
    assert.strictEqual(gmeetNotes.hasMeetScopes(null), false);
    assert.strictEqual(gmeetNotes.hasMeetScopes(''), false);
    assert.strictEqual(gmeetNotes.hasMeetScopes('openid email'), false);
    // Prefix/substring must not count as granted.
    assert.strictEqual(gmeetNotes.hasMeetScopes(`${gmeetNotes.SCOPE_MEET_READONLY}.extra`), false);
    assert.strictEqual(gmeetNotes.hasMeetScopes(`openid ${gmeetNotes.SCOPE_MEET_READONLY} email`), true);
    // Settings scope alone: settings true, readonly false.
    assert.strictEqual(gmeetNotes.hasMeetScopes(gmeetNotes.SCOPE_MEET_SETTINGS), false);
    assert.strictEqual(gmeetNotes.hasSettingsScope(gmeetNotes.SCOPE_MEET_SETTINGS), true);
    assert.strictEqual(gmeetNotes.hasSettingsScope(null), false);
});

// ═══ routes: auth gates ═════════════════════════════════════════════

test('routes: 401 unauthenticated on user + org endpoints', async () => {
    resetFx();
    let res = await dispatch({ url: '/user/me', session: {} });
    assert.strictEqual(res.statusCode, 401);
    res = await dispatch({ method: 'PUT', url: '/user/me', session: {} });
    assert.strictEqual(res.statusCode, 401);
    res = await dispatch({ url: '/orgA', session: {} });
    assert.strictEqual(res.statusCode, 401);
});

test('org GET: 403 for non-members, config for members (null orgIds = all)', async () => {
    resetFx();
    fx.orgIds = new Set(['otherOrg']);
    let res = await dispatch({ url: '/orgA', session: makeSession() });
    assert.strictEqual(res.statusCode, 403);

    resetFx();
    res = await dispatch({ url: '/orgA', session: makeSession() });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.autoImport, false, 'defaults returned for an unconfigured org');

    resetFx();
    fx.orgIds = null; // super admin
    res = await dispatch({ url: '/orgA', session: makeSession() });
    assert.strictEqual(res.statusCode, 200);
});

test('org PUT: admin-only; saved doc is sanitized and stamped', async () => {
    resetFx();
    let res = await dispatch({ method: 'PUT', url: '/orgA', session: makeSession(), body: { autoImport: true } });
    assert.strictEqual(res.statusCode, 403, 'non-admin member rejected');

    // A number 1, an unknown key or a non-string id is REFUSED now rather than
    // coerced — routes/gmeetNotesSettings.validation.test.js pins that. What
    // stays the core's job is the clamp and the stamp.
    fx.isOrgAdmin = true;
    res = await dispatch({
        method: 'PUT', url: '/orgA', session: makeSession(),
        body: { autoImport: true, importScope: 'calendar', lookbackHours: 900, excludedEventIds: ['e1'], updatedBy: 'someone-else' },
    });
    assert.strictEqual(res.statusCode, 200);
    const stored = fx.docs.get('org_gmeet_notes_orgA');
    assert.strictEqual(stored.autoImport, true);
    assert.strictEqual(stored.importScope, 'calendar');
    assert.strictEqual(stored.lookbackHours, 168, 'lookback clamped');
    assert.deepStrictEqual(stored.excludedEventIds, ['e1']);
    assert.strictEqual(stored.updatedBy, 'u1', 'the stamp is the server\'s, whatever the echoed GET said');
});

test('user PUT: a valid body is stored per user, language trimmed', async () => {
    resetFx();
    const res = await dispatch({
        method: 'PUT', url: '/user/me', session: makeSession(),
        body: { autoImport: true, autoRecordConfig: false, importScope: 'calendar', language: '  en  ' },
    });
    assert.strictEqual(res.statusCode, 200);
    const stored = fx.docs.get('user_gmeet_notes_u1');
    assert.strictEqual(stored.autoImport, true);
    assert.strictEqual(stored.autoRecordConfig, false);
    assert.strictEqual(stored.importScope, 'calendar');
    assert.strictEqual(stored.language, 'en', 'language trimmed');
});

// ═══ routes: connection derivation ══════════════════════════════════

test('user GET: active credential with Meet scopes → fully connected block', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: `openid ${gmeetNotes.SCOPE_MEET_READONLY} ${gmeetNotes.SCOPE_MEET_SETTINGS}` };
    const res = await dispatch({ url: '/user/me', session: makeSession() });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.autoImport, false, 'settings doc fields present');
    assert.deepStrictEqual(res.body.connection, {
        googleConnected: true, meetScopesGranted: true, hasSettingsScope: true, needsReauth: false,
    });
});

test('user GET: active credential WITHOUT Meet scopes → reconnect hint', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: 'openid email https://www.googleapis.com/auth/calendar' };
    const res = await dispatch({ url: '/user/me', session: makeSession() });
    assert.deepStrictEqual(res.body.connection, {
        googleConnected: true, meetScopesGranted: false, hasSettingsScope: false, needsReauth: false,
    });
});

test('user GET: needs_reauth credential → not connected, needsReauth flagged', async () => {
    resetFx();
    fx.cred = { status: 'needs_reauth', scope: gmeetNotes.SCOPE_MEET_READONLY };
    const res = await dispatch({ url: '/user/me', session: makeSession() });
    assert.deepStrictEqual(res.body.connection, {
        googleConnected: false, meetScopesGranted: true, hasSettingsScope: false, needsReauth: true,
    });
});

test('user GET: no credential + live Google session → connected, scopes unknown → false', async () => {
    resetFx();
    fx.cred = null;
    const res = await dispatch({ url: '/user/me', session: makeSession({ oauthProvider: 'google', accessToken: 'at' }) });
    assert.deepStrictEqual(res.body.connection, {
        googleConnected: true, meetScopesGranted: false, hasSettingsScope: false, needsReauth: false,
    });
});

test('user GET: no credential, no Google session → disconnected block', async () => {
    resetFx();
    const res = await dispatch({ url: '/user/me', session: makeSession({ oauthProvider: 'microsoft', accessToken: 'ms' }) });
    assert.deepStrictEqual(res.body.connection, {
        googleConnected: false, meetScopesGranted: false, hasSettingsScope: false, needsReauth: false,
    });
});

// ── org "no opinion" (tri-state) ────────────────────────────────────
//
// sanitizePatch coerces every field, so an org doc always carried every key and
// `k in org` was always true — the documented user fallback could never fire.
// An admin who merely opened the org settings page overrode every member's own
// choice with the form defaults, permanently.

test('an org field set to null falls through to the user setting', async () => {
    fx.docs.clear();
    await gmeetNotes.saveOrgSettings('org1', { autoImport: null, importScope: null, language: null }, 'admin');
    await gmeetNotes.saveUserSettings('u1', { autoImport: true, importScope: 'organizer', language: 'en' });

    const eff = await gmeetNotes.resolveGmeetNotesSettings({ orgId: 'org1', userId: 'u1' });
    assert.strictEqual(eff.autoImport, true, 'the user decides');
    assert.strictEqual(eff.importScope, 'organizer');
    assert.strictEqual(eff.language, 'en');
});

test('an org field set to false still overrides the user', async () => {
    fx.docs.clear();
    await gmeetNotes.saveOrgSettings('org1', { autoImport: false }, 'admin');
    await gmeetNotes.saveUserSettings('u1', { autoImport: true });

    const eff = await gmeetNotes.resolveGmeetNotesSettings({ orgId: 'org1', userId: 'u1' });
    assert.strictEqual(eff.autoImport, false, 'a deliberate org "off" is not "inherit"');
});

test('a null on both docs lands on the built-in default', async () => {
    fx.docs.clear();
    await gmeetNotes.saveOrgSettings('org1', { language: null }, 'admin');
    await gmeetNotes.saveUserSettings('u1', { language: null });

    const eff = await gmeetNotes.resolveGmeetNotesSettings({ orgId: 'org1', userId: 'u1' });
    assert.strictEqual(eff.language, 'nl');
});
