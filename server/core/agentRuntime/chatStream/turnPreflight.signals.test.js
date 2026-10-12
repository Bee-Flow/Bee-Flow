/**
 * Agent chat → chat signals: the one recorder call in runTurnPreflight.
 *
 * Pinned here, by running the preflight:
 *
 *   - a website visitor (`guest_…`) counts as `agent_public`, a member of the
 *     agent's own organisation as `agent`, both under the AGENT's org;
 *   - a member of another org, a super admin (no caller org) and an agent
 *     without an org are not handed to the recorder at all: that org could
 *     not have told them;
 *   - a test chat and a "Test as" preview are dry runs;
 *   - a DLP block is counted before the turn throws, and every turn is
 *     counted exactly once;
 *   - the outcome is the decision the PII gate or DLP already made, and the
 *     categories are that decision's ids;
 *   - the marker and the opt-out come from the turn's metadata;
 *   - nothing else travels: no agent id or name, no conversation, no text
 *     (amendment 24).
 *
 * The preflight's collaborators are swapped on their module objects before it
 * loads (testUtils/swaps); the recorder's countTurn is a spy.
 *
 * Run: cd server && node --test core/agentRuntime/chatStream/turnPreflight.signals.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../../testUtils/swaps');

const contextBuilder = require('../contextBuilder');
const guardrailsRunner = require('../guardrailsRunner');
const orgShield = require('../../privacy/orgShield');
const contextEnrichment = require('../contextEnrichment');
const streamUntokeniser = require('../streamUntokeniser');
const dlpRunner = require('../../dlp/dlpRunner');
const dlpPreflight = require('../../dlp/dlpPreflight');
const chatSignals = require('../../privacy/chatSignals');
const chatMonitoringFlag = require('../../entitlements/chatMonitoringFlag');
const objections = require('../../../stores/chatSignalObjectionStore');

/** The recorder's own countTurn, kept for the one test that runs it. */
const realCountTurn = chatSignals.countTurn;
const ON = Object.freeze({
    state: 'on', version: '2026-10-14T09:00:00.000Z', from: '2026-10-14', surfaces: ['direct', 'agent', 'agent_public'],
    paused: [], signals: ['outcomes'], noticeUrl: null, visitorNoticeUrl: null, retentionDays: 90,
});

const fx = { shield: null, piiReport: null, dlp: null, counted: [] };
const { swap, restore } = makeSwaps();
// The preflight destructures these when it loads: swap them first.
swap(contextBuilder, 'buildSystemPrompt', async () => ({ stable: 'SYS', volatile: '' }));
swap(guardrailsRunner, 'runInputGuardrails', async ({ userMessage }) => ({
    moderationViolation: null, guardrailViolation: null, processedUserMessage: userMessage,
    regexConfig: null, piiReport: fx.piiReport,
}));
swap(orgShield, 'resolveShieldFor', async () => fx.shield);
swap(contextEnrichment, 'resolveMemoryContext', async () => null);
swap(contextEnrichment, 'injectProjectAndKnowledgeContext', async ({ systemPrompt, volatileSystemPrompt }) => ({ systemPrompt, volatileSystemPrompt }));
swap(streamUntokeniser, 'createUntokenisingEventWrapper', ({ onEvent }) => ({ onEvent, _ut: null, _captureRaw: null }));
swap(dlpRunner, 'preWarmPiiScan', () => {});
swap(dlpRunner, 'getConversationTokenMapAsync', async () => ({}));
swap(dlpPreflight, 'runDlpPreflight', async () => fx.dlp);
swap(chatSignals, 'countTurn', (args) => { fx.counted.push(args); return undefined; });
const { runTurnPreflight } = require('./turnPreflight');
after(restore);

const AGENT = { id: 'agent-7f3a', name: 'Contract reader', organization_id: 'org-1', config: {} };
const MEMBER = 'u-4711';
const GUEST = 'guest_0f0f0f0f0f0f0f0f0f0f0f0f';
const MARKED = { notice: 'agent@2026-10-14T09:00:00.000Z', optOut: false };

function preflight({ agent = AGENT, userId = MEMBER, metadata = {} } = {}) {
    return runTurnPreflight({
        agent, agentId: agent.id, userId, userMessage: 'hello there', userAuth: {},
        messageMetadata: { orgId: 'org-1', chatSignals: MARKED, ...metadata },
        globalConfig: {}, config: { providerType: 'openai', url: 'https://api.openai.com/v1' }, modelToUse: 'gpt-x',
        conversation: { id: 'conv-99', messages: [] }, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello there' }],
        tools: [], validProjectId: null, validProject: null, isStandardTier: false,
        onEvent: () => {}, userSave: null, promptUserMsg: null,
    });
}

beforeEach(() => {
    fx.shield = { enabled: true, dlpEnabled: false, dlpAllowlistedHosts: ['llm.internal.example'] };
    fx.piiReport = { status: 'found', decision: 'tokenised', categories: ['EmailAddress'] };
    fx.dlp = null;
    fx.counted = [];
});

test('a member of the agent\'s own org counts as agent, under the agent\'s org, once', async () => {
    await preflight();
    assert.equal(fx.counted.length, 1, 'exactly one call per turn');
    const c = fx.counted[0];
    assert.deepEqual(
        { orgKey: c.orgKey, surface: c.surface, userId: c.userId, outcome: c.outcome, categories: c.categories, dryRun: c.dryRun },
        { orgKey: 'org-1', surface: 'agent', userId: MEMBER, outcome: 'protected', categories: ['EmailAddress'], dryRun: false },
    );
    assert.deepEqual(c.providerConfig, { providerType: 'openai', url: 'https://api.openai.com/v1' });
    assert.deepEqual(c.allowlistedHosts, ['llm.internal.example']);
});

test('a website visitor counts as agent_public under the agent\'s org', async () => {
    await preflight({ userId: GUEST, metadata: { orgId: null, chatSignals: { notice: 'agent_public@2026-10-14T09:00:00.000Z', optOut: true } } });
    assert.equal(fx.counted.length, 1);
    assert.deepEqual([fx.counted[0].surface, fx.counted[0].orgKey], ['agent_public', 'org-1']);
    assert.equal(fx.counted[0].notice, 'agent_public@2026-10-14T09:00:00.000Z');
    assert.equal(fx.counted[0].optOut, true, 'the embed\'s session switch travels');
});

test('another org\'s member, a super admin and an agent without an org are not recorded', async () => {
    await preflight({ metadata: { orgId: 'org-2' } });
    await preflight({ metadata: { orgId: null } });
    await preflight({ agent: { ...AGENT, organization_id: null } });
    await preflight({ agent: { ...AGENT, organization_id: null }, userId: GUEST });
    assert.deepEqual(fx.counted, []);
});

test('a test chat and a "Test as" preview are dry runs: the recorder counts neither', async () => {
    await preflight({ metadata: { testChat: true } });
    await preflight({ metadata: { testAs: { groupId: 'g1', orgId: 'org-1' } } });
    await preflight();
    assert.deepEqual(fx.counted.map(c => c.dryRun), [true, true, false]);

    // Hand the same three turns to the REAL recorder, with chat signals on
    // for the agent's org and the marker matching: only the ordinary turn
    // becomes a counter.
    chatSignals._resetForTests();
    const undo = [
        swap(chatMonitoringFlag, 'resolveChatMonitoring', async () => ON),
        swap(objections, 'isObjecting', async () => false),
    ];
    try {
        for (const c of fx.counted) realCountTurn(c);
        await new Promise((r) => setImmediate(r));
        assert.equal(chatSignals._pendingKeys(), 1, 'one counter key, from the ordinary turn only');
    } finally {
        undo.reverse().forEach((u) => u());
        chatSignals._resetForTests();
    }
});

test('a DLP block is counted before the throw, from the DLP decision', async () => {
    fx.shield = { ...fx.shield, dlpEnabled: true };
    fx.piiReport = { status: 'deferred_to_dlp', decision: null, categories: [] };
    fx.dlp = { outcome: 'blocked', blocked: true, reason: 'policy_block', scanStatus: 'ok', categories: ['IBAN', 'EmailAddress'], tooShort: false };
    await assert.rejects(() => preflight(), (e) => e.code === 'DLP_BLOCKED');
    assert.equal(fx.counted.length, 1, 'counted once, before the throw');
    assert.deepEqual([fx.counted[0].outcome, fx.counted[0].categories], ['blocked', ['IBAN', 'EmailAddress']]);
});

test('a turn the DLP let through is counted once, from the DLP decision', async () => {
    fx.shield = { ...fx.shield, dlpEnabled: true };
    fx.piiReport = { status: 'deferred_to_dlp', decision: null, categories: [] };
    fx.dlp = { outcome: 'allow', blocked: false, scanStatus: 'ok', categories: ['EmailAddress'], tooShort: false, override: true };
    await preflight();
    assert.equal(fx.counted.length, 1);
    assert.equal(fx.counted[0].outcome, 'sent_unprotected');
});

test('without a PII report (an older runner) the turn reads unscanned, and never throws', async () => {
    fx.piiReport = undefined;
    await preflight();
    assert.equal(fx.counted[0].outcome, 'unscanned');
    assert.deepEqual(fx.counted[0].categories, []);
});

test('the marker and the opt-out come from the metadata; an unmarked turn carries null', async () => {
    await preflight({ metadata: { chatSignals: undefined } });
    assert.deepEqual([fx.counted[0].notice, fx.counted[0].optOut], [null, false]);
    await preflight({ metadata: { chatSignals: { notice: 42, optOut: 'yes' } } });
    assert.deepEqual([fx.counted[1].notice, fx.counted[1].optOut], [null, false], 'only a string marker and a literal true');
});

test('nothing but the recorder\'s own keys travels: no agent, conversation or text', async () => {
    await preflight();
    const c = fx.counted[0];
    assert.deepEqual(Object.keys(c).sort(), [
        'allowlistedHosts', 'categories', 'dryRun', 'notice', 'optOut', 'orgKey', 'outcome', 'providerConfig', 'surface', 'userId',
    ]);
    const wire = JSON.stringify(c);
    for (const leak of [AGENT.id, AGENT.name, 'conv-99', 'hello there', 'gpt-x']) {
        assert.ok(!wire.includes(leak), `the recorder was handed "${leak}"`);
    }
});
