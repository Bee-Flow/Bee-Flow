'use strict';

/**
 * R2 — de agentpoort op de SAVE- en ACTIVEER-routes, als BEDRADING.
 *
 * De pure regel (`ai_step.agent_unavailable`) en de catalogus
 * (`automation/agentCatalog.js`) hebben allebei hun eigen tests. Wat die niet
 * dekken is de draad ertussen: de route die de catalogus bouwt en hem aan
 * `validateDefinition` meegeeft. Haal `availableAgents` uit de aanroep in
 * crud.js en elk bestaand testbestand onder routes/automation/ blijft groen —
 * geen enkele noemt `agentId`. Dit bestand is de bijt-toets: het draait de
 * ECHTE `validateDefinition` en de ECHTE `agentCatalogForOwner`, en alleen de
 * database eronder is een double.
 *
 * Tweede ding dat hier wordt vastgelegd: WELKE identiteit de vraag stelt. De
 * route las de STEMPEL op de automation-rij (`a.organizationId`) met de org van
 * degene die op Activeren drukte als terugval; de run meet het huidige
 * lidmaatschap van de EIGENAAR. Voor een org-loos opgeslagen automatisering geven die
 * twee een ander antwoord, en het verschil is onzichtbaar: scherm en activatie
 * zeggen ja, elke geplande run zegt `agent_unavailable`.
 *
 * Draaien: node --test --test-reporter=tap routes/automation/crud.agentGate.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

let AUTOMATIONS = {};
let AGENTS = {};
let USERS = {};
let GROUPS = {};
const agentLookups = [];
const userLookups = [];

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    updateAutomation: async (id, updates) => { AUTOMATIONS[id] = { ...AUTOMATIONS[id], ...updates }; return AUTOMATIONS[id]; },
    createAutomation: async (row) => { const a = { id: 'new1', ...row }; AUTOMATIONS[a.id] = a; return a; },
    getSubscriptionsForAutomation: async () => [],
    deleteSubscriptionsForAutomation: async () => {},
    createSubscription: async () => ({ id: 'sub1' }),
    updateSubscription: async () => true,
});
mock(path.join(SERVER, 'automation/cron'), { nextRunAt: () => null });
mock(path.join(SERVER, 'automation/summarise'), { summariseDefinition: () => ({ summary: '' }) });
mock(path.join(SERVER, 'automation/deliverableEvents'), { getDeliverableEvents: () => [] });
mock(path.join(SERVER, 'automation/toolRegistry'), { TOOL_REGISTRY: [], loadTools: () => [] });
mock(path.join(SERVER, 'automation/triggerBus'), {
    getPublicBaseUrl: () => null, loadSession: async () => null, revokeSubscription: async () => {},
    fetchLatestGmailMatch: async () => null, dispatchEvent: async () => [],
});
mock(path.join(SERVER, 'automation/triggerBus/dispatch'), { dispatchEvent: async () => [], dispatchToSubscription: () => [] });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });
mock(path.join(SERVER, 'core/integrations/integrationTools'), { getUserPermittedApps: async () => new Set() });
mock(path.join(SERVER, 'stores/integrationConnectionStore'), { listAccessibleConnections: async () => [] });
mock(path.join(SERVER, 'core/kb/automationKbCheck'), { kbStepFindings: async () => [] });
mock(path.join(SERVER, 'core/kb/kbSourceSync'), { syncKbSources: async () => {} });
mock(path.join(SERVER, 'automation/datatableUsageSync'), { syncDatatableUsage: async () => {}, purgeDatatableUsage: async () => {} });
mock(path.join(SERVER, 'automation/scheduleSync'), { syncSchedules: async () => {}, scheduleFingerprint: () => 'fp' });
mock(path.join(SERVER, 'automation/subscriptionSync'), {
    syncAppEventSubscription: async () => {}, revokeRemoteSubscriptions: async () => {},
    hasAppEventTrigger: () => false, appEventFingerprint: () => 'fp',
});
mock(path.join(SERVER, 'automation/approvalService'), { validateApprovalAssignees: async () => [] });
mock(path.join(SERVER, 'automation/portability'), {
    buildExport: () => ({}), sanitizeImport: () => ({ automation: null, errors: [] }),
    rebindDatatables: (d) => d, rekeyDefinition: (d) => ({ definition: d }), collectPinnedNodes: () => [],
});
// De identiteitslaag: dit is wat `agentCatalogForOwner` leest.
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => { userLookups.push(id); return USERS[id] || null; },
});
mock(path.join(SERVER, 'auth/audience'), { resolveUserGroups: async (id) => GROUPS[id] || [] });
mock(path.join(SERVER, 'stores/agentStore'), {
    getForRuntime: async (id) => { agentLookups.push(id); return AGENTS[id] || null; },
});
mock(path.join(SERVER, 'auth/datatableAccess'), {
    resolveDatatablePrincipal: async (req) => ({
        userId: req.session.user.id,
        orgId: (USERS[req.session.user.id] || {}).organizationId || null,
        organizationId: (USERS[req.session.user.id] || {}).organizationId || null,
        identityError: null,
    }),
});

const crudRouter = require('./crud');

function findHandler(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

const activate = findHandler(crudRouter, 'post', '/:id/activate');
const put = findHandler(crudRouter, 'put', '/:id');

const DEF = (agentId) => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [{ id: 'ai1', type: 'ai_step', prompt: 'Answer it.', agentId }],
    edges: [{ from: 'trg', to: 'ai1' }],
});
const agentRow = (over = {}) => ({
    id: 'agt_1', name: 'Bea', owner_id: 'u2', is_published: true, published_version: 2,
    organization_id: 'org1', shared_groups: [], config: {},
    ...over,
});

function reset() {
    AUTOMATIONS = {}; AGENTS = {}; GROUPS = {};
    USERS = { u1: { id: 'u1', organizationId: 'org1' }, u2: { id: 'u2', organizationId: 'org1' } };
    agentLookups.length = 0; userLookups.length = 0;
}

const codes = (res) => (res.body && res.body.details || []).map((d) => d.code);

test('activation REFUSES an automation whose ai_step names an agent its owner may not use', async () => {
    reset();
    AGENTS.agt_1 = agentRow({ organization_id: 'org2' });   // een andere organisatie
    AUTOMATIONS.a1 = { id: 'a1', userId: 'u1', organizationId: 'org1', isActive: false, isDraft: true, definition: DEF('agt_1') };

    const res = makeRes();
    await activate({ params: { id: 'a1' }, session: { user: { id: 'u1' } }, body: {} }, res);

    assert.strictEqual(res.statusCode, 400, 'an automation that cannot run must not go live');
    assert.ok(codes(res).includes('ai_step.agent_unavailable'), `expected the agent rule, got ${JSON.stringify(codes(res))}`);
    assert.strictEqual(AUTOMATIONS.a1.isActive, false, 'and nothing was armed');
});

test('activation lets a published, shared agent of the owner\'s own org through', async () => {
    reset();
    AGENTS.agt_1 = agentRow();
    AUTOMATIONS.a2 = { id: 'a2', userId: 'u1', organizationId: 'org1', isActive: false, isDraft: true, definition: DEF('agt_1') };

    const res = makeRes();
    await activate({ params: { id: 'a2' }, session: { user: { id: 'u1' } }, body: {} }, res);

    assert.strictEqual(res.statusCode, 200, res.body && JSON.stringify(res.body));
    assert.strictEqual(AUTOMATIONS.a2.isActive, true);
});

test('a STALE organisation stamp on the automation row does not decide', async () => {
    // The old rule was `a.organizationId || orgOf(req)` — the column on the
    // automations row first. That column does not move when an admin transfers
    // the owner to another organisation, so an automation stamped org2 kept being
    // judged against org2 while its runs (which resolve the owner's current
    // membership) had long since moved to org1. Read the OWNER, like the run
    // does, and the two answers are one answer.
    reset();
    AGENTS.agt_1 = agentRow({ organization_id: 'org1' });        // where u1 lives NOW
    AUTOMATIONS.a3 = { id: 'a3', userId: 'u1', organizationId: 'org2', isActive: false, isDraft: true, definition: DEF('agt_1') };

    const res = makeRes();
    await activate({ params: { id: 'a3' }, session: { user: { id: 'u1' } }, body: {} }, res);

    assert.strictEqual(res.statusCode, 200, res.body && JSON.stringify(res.body));
    assert.ok(userLookups.includes('u1'), 'the identity read is the automation owner\'s, not a column');
});

test('an automation stored WITHOUT an organisation is judged on the owner\'s membership', async () => {
    // The old rule was `a.organizationId || orgOf(req)`: for an org-less
    // automation that fell back to the presser's org and said yes, while the run
    // (which has no session on a schedule) said no. Fail-closed is not the
    // point — agreeing with the run is.
    reset();
    AGENTS.agt_1 = agentRow();                                   // org1, published
    AUTOMATIONS.a4 = { id: 'a4', userId: 'u1', organizationId: null, isActive: false, isDraft: true, definition: DEF('agt_1') };

    const res = makeRes();
    await activate({ params: { id: 'a4' }, session: { user: { id: 'u1' } }, body: {} }, res);
    assert.strictEqual(res.statusCode, 200, 'u1 IS in org1, so the org1 agent is his to use');
});

test('a lookup outage skips the rule rather than refusing what it could not check', async () => {
    reset();
    AGENTS.agt_1 = agentRow();
    AUTOMATIONS.a5 = { id: 'a5', userId: 'u1', organizationId: 'org1', isActive: false, isDraft: true, definition: DEF('agt_1') };
    const store = require(path.join(SERVER, 'stores/agentStore'));
    const real = store.getForRuntime;
    store.getForRuntime = async () => { throw new Error('database is down'); };
    try {
        const res = makeRes();
        await activate({ params: { id: 'a5' }, session: { user: { id: 'u1' } }, body: {} }, res);
        assert.strictEqual(res.statusCode, 200, 'an outage must not make every automation unactivatable');
    } finally { store.getForRuntime = real; }
});

test('a draft save WARNS about an unusable agent instead of blocking the build', async () => {
    // `ai_step.agent_unavailable` is a completeness code, so the draft stage
    // downgrades it. It has to be REPORTED, though: without availableAgents on
    // the PUT the editor never sees it, and rewriting an already-active automation
    // was the one path that could re-point a step at an unchecked agent.
    reset();
    AGENTS.agt_1 = agentRow({ organization_id: 'org2' });
    AUTOMATIONS.a6 = { id: 'a6', userId: 'u1', organizationId: 'org1', isActive: true, isDraft: false, definition: DEF(null) };

    const res = makeRes();
    await put({ params: { id: 'a6' }, session: { user: { id: 'u1' } }, body: { definition: DEF('agt_1') } }, res);

    assert.strictEqual(res.statusCode, 200, 'a half-built flow stays saveable');
    const warned = (res.body.warnings || []).map((w) => w.code);
    assert.ok(warned.includes('ai_step.agent_unavailable'), `expected a warning, got ${JSON.stringify(warned)}`);
});

test('an automation with no agent step asks nothing of the agent store at all', async () => {
    reset();
    AUTOMATIONS.a7 = {
        id: 'a7', userId: 'u1', organizationId: 'org1', isActive: false, isDraft: true,
        definition: { trigger: { id: 'trg', kind: 'manual' }, steps: [{ id: 'ai1', type: 'ai_step', prompt: 'p' }], edges: [{ from: 'trg', to: 'ai1' }] },
    };
    const res = makeRes();
    await activate({ params: { id: 'a7' }, session: { user: { id: 'u1' } }, body: {} }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(agentLookups.length, 0, 'no agent named, no lookups');
    assert.strictEqual(userLookups.length, 0, 'and no identity read either');
});
