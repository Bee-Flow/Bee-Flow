/**
 * Personal data travelling through MULTIPLE NODES of one routine.
 *
 * This is the scenario the whole token vault exists for: node 1 reads a
 * contact, node 2 has an AI write about them, node 3 reshapes it, node 4 sends
 * it out, node 5 emails the owner. The bugs this pins:
 *
 *  - `guardToolOutput` dropped its token map, so node 1's tokenized result
 *    entered runState as a literal `[person_1]` that NOTHING could restore —
 *    and it travelled from there into the outgoing email verbatim.
 *  - every node minted its own token namespace, so `[person_1]` in node 2 and
 *    `[person_1]` in node 5 could be different people.
 *  - the next node's guard cannot see a placeholder (a placeholder is not
 *    personal data), so an upstream token could never be restored at egress.
 *
 * The real engine runs here — only I/O is stubbed (stores, provider, tool
 * dispatcher) plus the PII detector, which is a deterministic fixture matcher.
 * tokenizeText/restoreTokens are the REAL implementations.
 *
 * Run: node --test server/core/automationRunner.tokenflow.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

process.env.NODE_ENV = 'test';

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// ── the fixture detector ───────────────────────────────────────────────────
// Absolute-path require on purpose: requiring '../privacy/piiDetection' with that exact
// specifier from this directory would poison Node's relative-resolve cache and
// safety.js's own lazy require would bypass the hook below.
const realPii = require(path.join(__dirname, 'privacy', 'piiDetection'));
const FIXTURES = [
    { category: 'Person', label: 'Person Name', text: 'Jan de Vries' },
    { category: 'Email', label: 'Email Address', text: 'jan@acme.nl' },
];
const piiStub = {
    ...realPii,
    async detectPii(text) {
        const entities = [];
        for (const f of FIXTURES) {
            let from = 0;
            for (;;) {
                const i = String(text).indexOf(f.text, from);
                if (i < 0) break;
                entities.push({ category: f.category, label: f.label, offset: i, length: f.text.length, text: f.text, confidence: 0.99 });
                from = i + f.text.length;
            }
        }
        return { hasPii: entities.length > 0, entities, degraded: false };
    },
};
const STUB_PII = path.join(__dirname, 'automationRunner', '__stub_pii_flow__.js');
require.cache[STUB_PII] = { id: STUB_PII, filename: STUB_PII, loaded: true, exports: piiStub };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename ? parent.filename : '';
    if (request === '../privacy/piiDetection' && from.endsWith(path.join('automationRunner', 'safety.js'))) return STUB_PII;
    return origResolve.call(this, request, parent, ...rest);
};

// ── captured I/O ───────────────────────────────────────────────────────────
const captured = {
    toolCalls: [],        // { name, args }
    recordedSteps: [],    // recordRunStep payloads
    notifications: [],    // in-app bell
    savedTokenMaps: [],   // vault write-through
    aiMessages: [],       // what the model received
    guardrailEvents: [],
};

// ── the org shield document (read by orgShield.resolveOrgShield) ───────────
let shieldDoc = null;
mock('../stores/configStore', {
    getConfig: async (key) => (key === 'org_privacy_shield_org1' ? shieldDoc : null),
    setConfig: async () => {},
});

mock('../stores/automationStore', {
    initDB: async () => {},
    createRun: async (o) => ({ id: 'run-1', ...o }),
    updateRun: async () => true,
    markRunning: async () => true,
    recordRunStep: async (row) => { captured.recordedSteps.push(row); },
    updateAutomation: async () => true,
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    getRun: async (id) => ({ id, cancelRequested: false, status: 'success' }),
    requestCancelRun: async () => null,
    getAutomation: async () => null,
    getRunTokenMap: async () => null,
    saveRunTokenMap: async (runId, map) => { captured.savedTokenMaps.push({ runId, map }); return true; },
});
mock('../stores/notificationStore', { createNotification: async (n) => { captured.notifications.push(n); } });
mock('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
mock('../stores/usageStore', { logUsage: () => Promise.resolve() });
mock('../stores/terminationStore', { logTermination: () => Promise.resolve() });
mock('../stores/guardrailEventStore', { logGuardrailEvent: async (e) => { captured.guardrailEvents.push(e); } });
mock('../stores/integrationActivityStore', { logIntegrationActivity: async () => {} });
mock('../db', { pool: { query: async () => ({ rows: [] }) } });
mock('./aiAgent', {
    getProviderForModel: async () => ({ providerType: 'test', url: '', apiKey: 'k' }),
    getAIConfig: async () => ({ model: 'test-model', piiDetectionEnabled: false }),
});
mock('./providers', {
    getAdapter: () => ({
        chat: async (_k, _u, _m, messages) => {
            captured.aiMessages.push(JSON.parse(JSON.stringify(messages)));
            // The model echoes the placeholder it was given, the way a real
            // model would when told to preserve tokens verbatim.
            const user = messages.find(m => m.role === 'user')?.content || '';
            const token = (user.match(/\[person_\d+\]/) || ['someone'])[0];
            return { content: `Beste ${token}, bedankt voor je bericht.`, usage: {} };
        },
    }),
});
mock('./llm/modelResolver', {
    getEUAwareTiers: async () => ({ fast: { modelId: 'test-model' } }),
    getUserTierMap: async () => ({ fast: { modelId: 'test-model' } }),
    isEUModeActive: async () => ({ isEU: false }),
    resolveModelForTierName: async () => 'test-model',
});
mock('./tools/toolDispatcher', {
    executeTool: async (name, args) => {
        captured.toolCalls.push({ name, args: JSON.parse(JSON.stringify(args)) });
        if (name === 'nextcloud_read_contact') {
            return { name: 'Jan de Vries', email: 'jan@acme.nl', note: 'Belt liefst s ochtends' };
        }
        return { ok: true, id: 'sent-1' };
    },
});
mock('./integrations/integrationTools', {
    getIntegrationTools: async () => ({
        tools: [
            { function: { name: 'nextcloud_read_contact' } },
            { function: { name: 'gmail_send_email' } },
        ],
    }),
});
mock('./http/outboundProbe', { runWithProbe: async (fn) => ({ result: await fn(), probe: null }), markLocal: () => {} });
mock('../automation/shapeCache', { recordShape: async () => {} });
mock('../auth/routineAuth', { buildUserAuth: async () => null });
mock('../auth/audience', { resolveUserGroups: async () => [] });
mock('../utils/emailService', { getServiceEmailConfig: async () => ({ configured: false }) });

const runner = require('./automationRunner');

// ── the routine under test ─────────────────────────────────────────────────
function definition() {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            {
                id: 'read', type: 'integration_action', tool: 'nextcloud_read_contact',
                inputs: { id: { kind: 'literal', value: 'c1' } },
            },
            {
                id: 'draft', type: 'ai_step',
                prompt: 'Schrijf een korte reactie aan {{steps.read.output.name}}.',
                inputs: { contact: { kind: 'ref', path: 'steps.read.output' } },
            },
            {
                id: 'shape', type: 'set',
                fields: {
                    to: { kind: 'ref', path: 'steps.read.output.email' },
                    body: { kind: 'ref', path: 'steps.draft.output' },
                },
            },
            {
                id: 'send', type: 'integration_action', tool: 'gmail_send_email',
                inputs: {
                    to: { kind: 'ref', path: 'steps.shape.output.to' },
                    body: { kind: 'ref', path: 'steps.shape.output.body' },
                },
            },
            {
                id: 'tell', type: 'notification', channels: ['notification'],
                title: 'Verstuurd', body: 'Mail aan {{steps.read.output.name}} is de deur uit.',
            },
        ],
        edges: [
            { from: 'trg', to: 'read' }, { from: 'read', to: 'draft' },
            { from: 'draft', to: 'shape' }, { from: 'shape', to: 'send' }, { from: 'send', to: 'tell' },
        ],
    };
}

const automation = () => ({
    id: 'auto-1', userId: 'u1', organizationId: 'org1', title: 'Contact opvolgen',
    version: 1, definition: definition(),
});

function resetCaptures() {
    captured.toolCalls.length = 0;
    captured.recordedSteps.length = 0;
    captured.notifications.length = 0;
    captured.savedTokenMaps.length = 0;
    captured.aiMessages.length = 0;
    captured.guardrailEvents.length = 0;
}

const SHIELD = (over = {}) => ({
    enabled: true,
    piiDetectionAction: 'tokenize',
    dlpScope: 'external',
    monitorIntegrations: true,
    scope: { userInput: true, agentOutput: true },
    ...over,
});

/** Every string anywhere in a value. */
function strings(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(v => strings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, out));
    return out;
}
const LEAKED_TOKEN = /\[(person|email)_\d+\]/;

// ── tests ──────────────────────────────────────────────────────────────────

test('scope external: the outside mail gets placeholders, and NOT a single node leaks one downstream', async () => {
    resetCaptures();
    shieldDoc = SHIELD();
    await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live' });

    const send = captured.toolCalls.find(c => c.name === 'gmail_send_email');
    assert.ok(send, 'the send step ran');
    // Gmail is a third party and the org keeps personal data tokenized there.
    assert.strictEqual(send.args.to, '[email_1]');
    assert.match(send.args.body, /\[person_1\]/);
    assert.doesNotMatch(JSON.stringify(send.args), /Jan de Vries|jan@acme\.nl/);

    // The in-app bell is NOT a third party → real values, no placeholder.
    const bell = captured.notifications.at(-1);
    assert.match(bell.message, /Jan de Vries/, 'the owner must read a name, not a placeholder');
    assert.doesNotMatch(bell.message, LEAKED_TOKEN);

    // And nothing that was persisted as a step output carries an unresolvable
    // placeholder — this is the bug that put `[person_1]` into real emails.
    for (const row of captured.recordedSteps) {
        for (const s of strings(row.output)) {
            assert.doesNotMatch(s, LEAKED_TOKEN, `step ${row.stepId} leaked a placeholder downstream: ${s}`);
        }
    }
});

test('one namespace for the whole run: the same person keeps one placeholder in every node', async () => {
    resetCaptures();
    shieldDoc = SHIELD();
    await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live' });

    const saved = captured.savedTokenMaps.at(-1);
    assert.ok(saved, 'the vault is written through so a resume can restore');
    const persons = Object.entries(saved.map).filter(([k]) => k.startsWith('[person_'));
    const emails = Object.entries(saved.map).filter(([k]) => k.startsWith('[email_'));
    assert.strictEqual(persons.length, 1, `one person appeared under ${persons.length} placeholders: ${JSON.stringify(saved.map)}`);
    assert.strictEqual(emails.length, 1);
    assert.strictEqual(persons[0][1], 'Jan de Vries');
    assert.strictEqual(emails[0][1], 'jan@acme.nl');

    // The model saw the placeholder, never the name.
    const prompt = JSON.stringify(captured.aiMessages);
    assert.doesNotMatch(prompt, /Jan de Vries/, 'the AI must not receive the real name');
    assert.match(prompt, /\[person_1\]/);
});

test('scope all is stricter than external: even the on-box destination gets placeholders', async () => {
    resetCaptures();
    shieldDoc = SHIELD({ dlpScope: 'all' });
    await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live' });
    const read = captured.toolCalls.find(c => c.name === 'nextcloud_read_contact');
    assert.ok(read, 'the on-box read still ran');
    // The bell is on-box too — under 'all' it must be tokenized as well.
    const bell = captured.notifications.at(-1);
    assert.match(bell.message, LEAKED_TOKEN, "'all' must never be weaker than 'external'");
});

test('redact really redacts: the third party gets a mask, not the value, and not a counter', async () => {
    resetCaptures();
    shieldDoc = SHIELD({ piiDetectionAction: 'redact' });
    await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live' });
    const send = captured.toolCalls.find(c => c.name === 'gmail_send_email');
    assert.strictEqual(send.args.to, '[email]');
    assert.doesNotMatch(JSON.stringify(send.args), /Jan de Vries|jan@acme\.nl/,
        'redact used to tokenize and then restore, i.e. protect nothing');
    assert.doesNotMatch(JSON.stringify(send.args), /_\d\]/, 'a mask carries no counter');
});

test('block stops the send and leaves an audit row behind', async () => {
    resetCaptures();
    shieldDoc = SHIELD({ piiDetectionAction: 'block' });
    await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live' });
    assert.strictEqual(captured.toolCalls.filter(c => c.name === 'gmail_send_email').length, 0,
        'nothing may leave under a block policy');
    assert.ok(captured.guardrailEvents.some(e => e.action_taken === 'blocked'));
});

test('applyToAutomations=false is a real opt-out: real values everywhere, no tokens', async () => {
    resetCaptures();
    shieldDoc = SHIELD({ applyToAutomations: false });
    await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live' });
    const send = captured.toolCalls.find(c => c.name === 'gmail_send_email');
    assert.strictEqual(send.args.to, 'jan@acme.nl');
    assert.strictEqual(captured.savedTokenMaps.length, 0, 'no vault writes when the shield does not apply');
});

test('a resumed run reuses the earlier process placeholders', async () => {
    resetCaptures();
    shieldDoc = SHIELD();
    const store = require('../stores/automationStore');
    const origGet = store.getRunTokenMap;
    // The prior run already minted [person_4] for this contact.
    store.getRunTokenMap = async () => ({ '[person_4]': 'Jan de Vries' });
    try {
        await runner.executeAutomation(automation(), { triggerKind: 'manual', mode: 'live', parentRunId: 'run-0' });
    } finally {
        store.getRunTokenMap = origGet;
    }
    const send = captured.toolCalls.find(c => c.name === 'gmail_send_email');
    assert.match(send.args.body, /\[person_4\]/, 'the resumed run must not re-number a value the first process already tokenized');
});

test('the trigger payload is scanned too — its values get the run placeholder', async () => {
    resetCaptures();
    shieldDoc = SHIELD();
    await runner.executeAutomation(automation(), {
        triggerKind: 'webhook',
        triggerPayload: { reporter: 'Jan de Vries', ref: 'TICKET-9' },
        mode: 'live',
    });
    const saved = captured.savedTokenMaps.at(-1);
    assert.ok(saved, 'the webhook body used to arrive completely unseen');
    assert.ok(Object.values(saved.map).includes('Jan de Vries'));
    // The value stays real in runState — this is detection + seeding, not
    // transformation — so downstream bindings keep working.
    const readRow = captured.recordedSteps.find(r => r.stepId === 'read');
    assert.ok(readRow, 'the run still executed');
});

test.after(() => { Module._resolveFilename = origResolve; });
