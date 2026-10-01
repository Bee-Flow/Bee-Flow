/**
 * Outlook next to another login: a Google-SSO user who connected Microsoft 365
 * in Settings → Connections (vault credential).
 *
 * Before: the Outlook tools only existed when `session.oauthProvider` was
 * 'microsoft', so these users never got them, and the dispatcher would have
 * handed Graph the Google token anyway. Now getIntegrationTools adds them off
 * the vault credential, and executeTool runs them on a Microsoft-only shim:
 * the Graph call carries the MICROSOFT token, and the Google session is left
 * exactly as it was. outlook_compose follows gmail_compose's autoSend.
 *
 * DB-free: the data sources are patched on the cached module objects (style of
 * integrationTools.notebooks.test.js); global fetch is a fake Graph.
 *
 * Run: cd server && node --test core/integrations/integrationTools.outlookMultiProvider.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ── Patch destructure-at-load deps BEFORE requiring the modules under test ──
const permissions = require('../../auth/permissions');
permissions.hasPermission = async () => true;

const betaFeatures = require('../entitlements/betaFeatures');
betaFeatures.userHasBetaFeature = async () => false;

// ── Patch lazy-required data sources (looked up per call) ──────────────────
const configStore = require('../../stores/configStore');
configStore.getConfig = async () => null;
configStore.getSecret = async () => null;

const userStore = require('../../stores/userStore');
userStore.getUser = async () => ({ id: 'u1', organizationId: 'o1', groups: [], role: 'user' });
userStore.getOrganization = async () => ({ enabledIntegrations: null });
userStore.getAllGroups = async () => [];
userStore.getAppPassword = async () => null;

try {
    const mcpManager = require('../mcpManager');
    mcpManager.getAllToolsAsOpenAI = async () => [];
} catch (_) { /* appendMcpTools fails closed on its own */ }

// The vault: one Microsoft credential for u1, nothing else.
let msCred = null;
const routineAuth = require('../../auth/routineAuth');
routineAuth.getProviderAuth = async (userId, provider) => (provider === 'microsoft' && userId === 'u1' ? msCred : null);

const ent = require('../entitlements/entitlements');
ent.resolveEntitlements = async () => ({
    degraded: false,
    tier: 'enterprise',
    ceiling: { core: [], integration: ['gmail', 'outlook', 'outlook-readonly'], beta: [] },
    effective: { core: [], integration: ['gmail', 'outlook', 'outlook-readonly'], beta: [] },
});

const { getIntegrationTools } = require('./integrationTools');
const { executeTool } = require('../tools/toolDispatcher');

// ── Fake Graph ──────────────────────────────────────────────────────────────
const graphCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
    graphCalls.push({ url: String(url), method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body || null });
    if (String(url).includes('/me/sendMail')) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ value: [{ id: 'M1', subject: 'Hello', from: { emailAddress: { address: 'x@example.com' } } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
    });
};
test.after(() => { global.fetch = realFetch; });

const googleSession = () => ({
    user: { id: 'u1', role: 'user' },
    oauthProvider: 'google',
    accessToken: 'google-at',
    refreshToken: 'google-rt',
});
const names = (r) => r.tools.map(t => t.function.name);

test.beforeEach(() => {
    msCred = { userId: 'u1', orgId: 'o1', accessToken: 'ms-at', refreshToken: 'ms-rt', scope: 'Mail.Send' };
    graphCalls.length = 0;
});

test('a Google session WITHOUT a Microsoft connection gets no Outlook tools', async () => {
    msCred = null;
    const res = await getIntegrationTools({ userId: 'u1', session: googleSession(), isAdmin: false });
    assert.ok(names(res).includes('gmail_search'), 'Google tools still there');
    assert.ok(!names(res).some(n => n.startsWith('outlook_')), 'no Outlook tools');
});

test('a Google session WITH a Microsoft vault credential gets Outlook tools next to Gmail', async () => {
    const session = googleSession();
    const res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false });
    const list = names(res);
    assert.ok(list.includes('gmail_search'), 'Gmail stays');
    assert.ok(list.includes('outlook_search'), 'outlook_search added');
    assert.ok(list.includes('outlook_compose'), 'outlook_compose added');
    assert.ok(!list.includes('ms_calendar_list_events'), 'only Outlook is lifted, not the other Microsoft apps');
    assert.strictEqual(session.oauthProvider, 'google', 'the session is not re-labelled');
    assert.strictEqual(session.accessToken, 'google-at');
});

test('the Outlook call goes to Graph with the Microsoft token, never the Google one', async () => {
    const session = googleSession();
    const out = await executeTool('outlook_search', { query: 'hello' }, { userId: 'u1', session, egress: false });

    assert.strictEqual(out.results?.[0]?.id, 'M1');
    const graph = graphCalls.filter(c => c.url.startsWith('https://graph.microsoft.com/'));
    assert.strictEqual(graph.length, 1);
    assert.strictEqual(graph[0].auth, 'Bearer ms-at');
    assert.ok(!graphCalls.some(c => c.auth === 'Bearer google-at'), 'the Google token never reaches Graph');
    assert.strictEqual(session.accessToken, 'google-at');
});

test('outlook_compose: a draft in a chat, a sent mail under autoSend', async () => {
    const args = { to: 'boss@example.com', subject: 'Q3', body: 'Numbers.' };

    const draft = await executeTool('outlook_compose', args, { userId: 'u1', session: googleSession(), egress: false });
    assert.strictEqual(draft._action, 'email_draft');
    assert.ok(!graphCalls.some(c => c.method === 'POST'), 'nothing sent without approval');

    const sent = await executeTool('outlook_compose', args, { userId: 'u1', session: googleSession(), autoSend: true, egress: false });
    assert.strictEqual(sent.sent, true);
    const send = graphCalls.find(c => c.url.endsWith('/me/sendMail'));
    assert.ok(send, 'sendMail called');
    assert.strictEqual(send.method, 'POST');
    assert.strictEqual(send.auth, 'Bearer ms-at');
});

test('a routine session whose primary is Google uses routineProviders.microsoft', async () => {
    msCred = null; // the vault is not consulted: the routine already carries it
    const routine = {
        userId: 'u1', oauthProvider: 'google', accessToken: 'google-at', refreshToken: 'google-rt',
        routineProviders: { microsoft: { userId: 'u1', orgId: 'o1', accessToken: 'routine-ms-at', refreshToken: 'r' } },
    };
    const res = await getIntegrationTools({ userId: 'u1', session: routine, isAdmin: false });
    assert.ok(names(res).includes('outlook_compose'));

    await executeTool('outlook_search', { query: 'x' }, { userId: 'u1', session: routine, egress: false });
    const graph = graphCalls.filter(c => c.url.startsWith('https://graph.microsoft.com/'));
    assert.strictEqual(graph[0].auth, 'Bearer routine-ms-at');
});
