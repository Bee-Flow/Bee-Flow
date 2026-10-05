'use strict';

/**
 * Tests for GET /catalog's dynamic app_event provider list.
 *
 * The strict-gate house rule is enforced MECHANICALLY: the integrationTools
 * mock's getUserPermittedApps throws — availability may only derive from
 * getIntegrationTools (fail-closed), never the fail-open permitted-apps set.
 *
 * Route handler invoked directly (no supertest) — same require.cache Module
 * mock + findHandler technique as crud.multiTrigger.test.js.
 *
 * Run: node --test routes/automation/catalog.test.js
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

// Per-test mutable state read by the mocks.
let AVAILABLE_APPS = new Set();     // app ids getIntegrationTools exposes tools for
let BETA_FEATURES = new Set();      // enabled beta feature ids
let SUPPORT_INBOXES = [];
let PUBLIC_BASE_URL = null;
let BETA_THROWS = false;

const toolNameFor = (app) => `${app.replace(/-/g, '_')}_tool`;
const FAKE_REGISTRY = [
    { app: 'gmail', label: 'Gmail' },
    { app: 'google-calendar', label: 'Google Calendar' },
    { app: 'nextcloud-deck', label: 'Nextcloud Deck' },
    { app: 'outlook', label: 'Outlook' },
    { app: 'youtrack', label: 'YouTrack' },
];

mock(path.join(SERVER, 'stores/automationStore'), {
    getCallableStepsForUser: async () => [],
});
mock(path.join(SERVER, 'stores/configStore'), {
    getConfig: async () => null,
});
mock(path.join(SERVER, 'automation/toolRegistry'), {
    TOOL_REGISTRY: FAKE_REGISTRY,
    loadTools: (entry) => [{ function: { name: toolNameFor(entry.app) } }],
});
mock(path.join(SERVER, 'automation/sideEffectMap'), {
    isSideEffect: () => false,
    // The catalog now carries the three-way effect next to the two-way
    // dry-run flag; the agent tool picker labels and defaults on it.
    effectOf: (name) => (String(name).includes('gmail') ? 'sends' : 'reads'),
});
mock(path.join(SERVER, 'automation/outputSchemas'), {
    getOutputSchema: () => null,
    synthesizeDryRunOutput: () => ({}),
    // catalog.js also badges list-producing actions for App Studio connectors.
    // The mock predated that and made every request 500 with
    // "producesList is not a function".
    producesList: () => false,
    iterableFieldsOf: () => [],
});
mock(path.join(SERVER, 'core/integrations/integrationToolMap'), { resolveIntegration: () => null });
mock(path.join(SERVER, 'core/integrations/integrationTools'), {
    getIntegrationTools: async () => ({
        tools: [...AVAILABLE_APPS].map(app => ({ function: { name: toolNameFor(app) } })),
    }),
    getUserPermittedApps: () => { throw new Error('getUserPermittedApps must not be called — fails open'); },
});
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), {
    userHasBetaFeature: async (userId, featureId) => {
        if (BETA_THROWS) throw new Error('beta lookup down');
        return BETA_FEATURES.has(featureId);
    },
});
mock(path.join(SERVER, 'auth/audience'), {
    resolveAudienceContext: async () => ({ orgIds: [], userGroups: [] }),
});
mock(path.join(SERVER, 'stores/supportInboxStore'), {
    listInboxes: async () => SUPPORT_INBOXES,
});
mock(path.join(SERVER, 'automation/triggerBus'), {
    getPublicBaseUrl: () => PUBLIC_BASE_URL,
});
// Real trigger-catalog data behind the builderTools facade (the facade itself
// pulls heavy builder deps we don't want in this test).
mock(path.join(SERVER, 'automation/builderTools'), {
    buildTriggerOutputsCatalog: require(path.join(SERVER, 'automation/builderTools/triggerCatalog')).buildTriggerOutputsCatalog,
});

const catalogRouter = require('./catalog');

function findHandler(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
const catalogHandler = findHandler(catalogRouter, 'get', '/catalog');

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

function resetState() {
    AVAILABLE_APPS = new Set();
    BETA_FEATURES = new Set();
    SUPPORT_INBOXES = [];
    PUBLIC_BASE_URL = null;
    BETA_THROWS = false;
}

async function fetchCatalog() {
    const req = { session: { user: { id: 'user1', organizationId: 'org1' }, isAdmin: false } };
    const res = makeRes();
    await catalogHandler(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
}

function appEventProviders(body) {
    const entry = body.triggers.find(t => t.kind === 'app_event');
    assert.ok(entry, 'app_event trigger entry present');
    return entry.providers;
}

// Approvals is the one ALWAYS-ON provider: its events are produced by the
// approvals feature itself, which ships with automations (no connector, no
// beta flag, no base URL). Every exact-set assertion below therefore expects
// it alongside whatever the context makes available.
function withoutApprovals(providers) {
    assert.ok(providers.some(p => p.id === 'approvals'), 'the built-in approvals provider is always listed');
    return providers.filter(p => p.id !== 'approvals');
}

test('gmail-tools-only user gets exactly the gmail provider (rich object shape)', async () => {
    resetState();
    AVAILABLE_APPS = new Set(['gmail']);
    const body = await fetchCatalog();
    const providers = withoutApprovals(appEventProviders(body));
    assert.deepStrictEqual(providers.map(p => p.id), ['gmail']);
    assert.strictEqual(providers[0].label, 'Gmail');
    assert.strictEqual(providers[0].defaultEvent, 'mail.new');
    assert.deepStrictEqual(
        providers[0].events.map(e => e.id).sort(),
        ['label.added', 'mail.new']);
    assert.ok(providers[0].events.every(e => e.deliverability === 'ok'));
});

test('nothing available yields only the built-in approvals provider (github never listed)', async () => {
    resetState();
    const body = await fetchCatalog();
    assert.deepStrictEqual(appEventProviders(body).map(p => p.id), ['approvals']);
});

test('a nextcloud-* tool app exposes the nextcloud provider with connector deliverability on push-pending events', async () => {
    resetState();
    AVAILABLE_APPS = new Set(['nextcloud-deck']);
    const body = await fetchCatalog();
    const providers = withoutApprovals(appEventProviders(body));
    assert.deepStrictEqual(providers.map(p => p.id), ['nextcloud']);
    const evs = Object.fromEntries(providers[0].events.map(e => [e.id, e.deliverability]));
    assert.strictEqual(evs['file.new'], 'ok');
    // Deck moved to connector webhooks (deliverableEvents.js WEBHOOK_BACKED);
    // the share events are the push-pending ones that still read 'connector'.
    assert.strictEqual(evs['deck.card.created'], 'ok');
    assert.strictEqual(evs['share.created'], 'connector');
});

test('support appears only with the beta feature AND at least one inbox', async () => {
    resetState();
    BETA_FEATURES = new Set(['support_inbox']);
    SUPPORT_INBOXES = [];
    let body = await fetchCatalog();
    assert.deepStrictEqual(withoutApprovals(appEventProviders(body)), []);

    SUPPORT_INBOXES = [{ id: 'inbox-1' }];
    body = await fetchCatalog();
    const providers = withoutApprovals(appEventProviders(body));
    assert.deepStrictEqual(providers.map(p => p.id), ['support']);
    assert.strictEqual(providers[0].defaultEvent, 'ticket.resolved');
});

test('msgraph requires outlook tools AND a public base URL', async () => {
    resetState();
    AVAILABLE_APPS = new Set(['outlook']);
    PUBLIC_BASE_URL = null;
    let body = await fetchCatalog();
    assert.deepStrictEqual(withoutApprovals(appEventProviders(body)), [], 'no base URL — webhook can never fire');

    PUBLIC_BASE_URL = 'https://app.example.com';
    body = await fetchCatalog();
    assert.deepStrictEqual(withoutApprovals(appEventProviders(body)).map(p => p.id), ['msgraph']);

    AVAILABLE_APPS = new Set();
    body = await fetchCatalog();
    assert.deepStrictEqual(withoutApprovals(appEventProviders(body)), [], 'base URL without MS tools is absent');
});

test('a throwing check fails closed (200 with the provider absent)', async () => {
    resetState();
    BETA_FEATURES = new Set(['support_inbox']);
    SUPPORT_INBOXES = [{ id: 'inbox-1' }];
    BETA_THROWS = true;
    const body = await fetchCatalog();
    assert.deepStrictEqual(withoutApprovals(appEventProviders(body)), []);
});

test('response keeps legacy deliverability + triggerOutputs, and triggers carry no connection/secret data', async () => {
    resetState();
    AVAILABLE_APPS = new Set(['gmail']);
    BETA_FEATURES = new Set(['support_inbox']);
    SUPPORT_INBOXES = [{ id: 'inbox-1', email_address: 'inbox@example.com', oauth_token: 'nope' }];
    const body = await fetchCatalog();

    // Legacy top-level deliverability block unchanged (back-compat).
    assert.ok(Array.isArray(body.deliverability.pollerBacked.nextcloud));
    assert.ok(Array.isArray(body.deliverability.pushPending.nextcloud));
    // New catalog entries flow into triggerOutputs.
    assert.ok(body.triggerOutputs['support.ticket.resolved']);
    assert.ok(body.triggerOutputs['msgraph.mail.new']);
    // The trigger META (which trigger fired) is a sibling key, so the
    // byte-pinned triggerOutputs catalog stays untouched by it.
    assert.ok(Array.isArray(body.triggerMeta) && body.triggerMeta.length > 0, 'catalog.triggerMeta');
    for (const p of ['trigger.kind', 'trigger.source', 'trigger.event', 'trigger.firedAt']) {
        assert.ok(body.triggerMeta.some(f => f.path === p), `triggerMeta lists ${p}`);
    }
    assert.ok(!('kind' in body.triggerOutputs['msgraph.mail.new'].sample), 'meta never leaks into an event sample');

    // Booleans only decide listing — nothing about the inbox row may leak.
    const triggersJson = JSON.stringify(body.triggers);
    for (const needle of ['inbox@example.com', 'oauth_token', 'nope', 'inbox-1']) {
        assert.ok(!triggersJson.includes(needle), `triggers must not contain '${needle}'`);
    }
    // Provider entries stay the documented catalog shape.
    for (const p of appEventProviders(body)) {
        assert.deepStrictEqual(Object.keys(p).sort(), ['defaultEvent', 'events', 'id', 'label']);
    }
});

test('every authorable trigger kind is listed, including the hosted form', () => {
    // The builder's kind <select> and the AI builder both read this list, so a
    // kind that exists server-side but is missing here is unreachable.
    return fetchCatalog().then((body) => {
        assert.deepStrictEqual(
            body.triggers.map(t => t.kind),
            ['schedule', 'manual', 'webhook', 'form', 'app_event', 'agent_call'],
        );
        const form = body.triggers.find(t => t.kind === 'form');
        assert.match(form.label, /form/i);
        // The form's own fields are author-declared per automation, so the shared
        // catalog entry carries no fields — only the binding note.
        assert.deepStrictEqual(body.triggerOutputs.__form.fields, []);
        assert.match(body.triggerOutputs.__form.note, /trigger\.output\.<fieldName>/);
    });
});

test('every action carries the three-way effect next to the dry-run sideEffect flag', async () => {
    // `sideEffect` (may a dry-run do this for real?) and `effect` (does it
    // leave the building?) are different questions and must both survive: the
    // picker's "leest alleen" label and its default confirmation read `effect`,
    // the runner still reads `sideEffect`.
    AVAILABLE_APPS = new Set(['gmail']);
    const body = await fetchCatalog();
    const gmail = body.apps.find(a => a.id === 'gmail');
    assert.ok(gmail, 'gmail app present in the catalog');
    assert.strictEqual(gmail.actions[0].effect, 'sends');
    assert.strictEqual(gmail.actions[0].sideEffect, false);
    const deck = body.apps.find(a => a.id === 'nextcloud-deck');
    assert.strictEqual(deck.actions[0].effect, 'reads');
});

test('an action reads as what it does, without the app name the card already shows', async () => {
    // It used to be the tool id with spaces: "nextcloud deck tool" next to "Nextcloud Deck".
    AVAILABLE_APPS = new Set(['gmail']);
    const body = await fetchCatalog();
    assert.strictEqual(body.apps.find(a => a.id === 'gmail').actions[0].label, 'Tool');
    assert.strictEqual(body.apps.find(a => a.id === 'nextcloud-deck').actions[0].label, 'Tool');
    assert.strictEqual(body.apps.find(a => a.id === 'youtrack').actions[0].label, 'Tool');
});

// ── Meeting Notes (M5) ─────────────────────────────────────────────────
//
// De declaratie gaat op `availability: { kind:'check', check:'meeting_notes' }`
// en providerIsAvailable eist `checks.meeting_notes === true`. Die sleutel werd
// hier niet gezet, dus de provider was in het dropdown ONZICHTBAAR terwijl de
// dispatch, de variabelenkiezer en de bouw-agent hem al kenden. De drie tests
// hieronder pinnen de aanwezigheid, de afwezigheid én het faalgedrag vast.

test('meeting-notes verschijnt alleen met de capability meeting_notes', async () => {
    resetState();
    let body = await fetchCatalog();
    assert.ok(!appEventProviders(body).some(p => p.id === 'meeting-notes'),
        'zonder de capability is de provider niet te kiezen');

    BETA_FEATURES = new Set(['meeting_notes']);
    body = await fetchCatalog();
    const providers = withoutApprovals(appEventProviders(body));
    assert.deepStrictEqual(providers.map(p => p.id), ['meeting-notes']);
    assert.strictEqual(providers[0].defaultEvent, 'meeting.processed');
    // De provider hangt NIET aan een geïnstalleerde app: Meeting Notes is een
    // eigen feature, geen integratie in TOOL_REGISTRY.
    assert.deepStrictEqual([...AVAILABLE_APPS], []);
});

test('een kapotte capability-lookup laat meeting-notes weg (faalt dicht)', async () => {
    resetState();
    BETA_FEATURES = new Set(['meeting_notes']);
    BETA_THROWS = true;
    const body = await fetchCatalog();
    assert.ok(!appEventProviders(body).some(p => p.id === 'meeting-notes'));
});

test('de meeting-notes-velden zitten in triggerOutputs, ook zonder de capability', async () => {
    // Het uitvoercontract is NIET gegate: een automatisering die al op deze trigger
    // staat moet zijn trigger.output.*-bindingen blijven kunnen tonen, ook als
    // de licentie inmiddels weg is. Alleen het KIEZEN is gegate.
    resetState();
    const body = await fetchCatalog();
    const entry = body.triggerOutputs['meeting-notes.meeting.processed'];
    assert.ok(entry, 'het contract blijft resolveerbaar');
    assert.deepStrictEqual(entry.fields.map(f => f.key), ['transcriptionId', 'tags', 'orgId', 'reprocessed']);
    assert.ok(Array.isArray(entry.sample.tags));
});

// "Is about" (the topic classifier) follows the `code` contract: a strict
// boolean the editor can test, with the reason beside it, and the settings the
// operator needs. With no classify-service configured it is off, and says so.
test('topics: off with its reason when no classifier is configured', async () => {
    resetState();
    const saved = process.env.CLASSIFY_SERVICE_URL;
    delete process.env.CLASSIFY_SERVICE_URL;
    try {
        require('../../core/classify/classifierEndpoint').invalidateClassifierEndpointCache();
        require('../../core/classify/classifierClient')._resetClassifierState();
        const body = await fetchCatalog();
        assert.strictEqual(body.flags.topics, false);
        assert.strictEqual(body.flags.topicsReason, 'not_configured');
        assert.deepStrictEqual(body.topics, { defaultThreshold: 0.75, maxLabels: 16 });
    } finally {
        if (saved !== undefined) process.env.CLASSIFY_SERVICE_URL = saved;
    }
});
