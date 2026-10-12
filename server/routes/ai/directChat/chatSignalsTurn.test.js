/**
 * Direct chat → chat signals (./chatSignalsTurn.js), and the Swarm tier's call.
 *
 * Pinned here:
 *
 *   - countDirectTurn hands the recorder the outcome the gates decided: the
 *     DLP decision when DLP ran, else the PII gate's report (a shield that is
 *     off reads `unscanned`);
 *   - the org key is resolveEffectiveOrgId, or the 'default' bucket without
 *     one (and when the lookup fails);
 *   - the marker and the opt-out come from req.body, nothing else does;
 *   - fire-and-forget: synchronous, returns undefined, never throws, and the
 *     recorder is reached only after the request has moved on;
 *   - the Swarm tier counts `unscanned` with destination `unknown`, before its
 *     stream starts, and not when it refuses the turn.
 *
 * The recorder's countTurn is a spy and the org lookup a swap on its module
 * object (testUtils/swaps); the helpers and the Swarm branch are real.
 *
 * Run: cd server && node --test routes/ai/directChat/chatSignalsTurn.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../../testUtils/swaps');

const chatSignals = require('../../../core/privacy/chatSignals');
const modelResolver = require('../../../core/llm/modelResolver');
const chatSignalStore = require('../../../stores/chatSignalStore');
const { countDirectTurn, countFixedTurn } = require('./chatSignalsTurn');

const fx = { orgId: 'org-1', counted: [], lookups: 0 };
const { swap, restore } = makeSwaps();
swap(chatSignals, 'countTurn', (args) => { fx.counted.push(args); return undefined; });
swap(modelResolver, 'resolveEffectiveOrgId', async () => {
    fx.lookups++;
    if (fx.orgId instanceof Error) throw fx.orgId;
    return fx.orgId;
});
after(restore);

const settle = () => new Promise((r) => setImmediate(r));
const MARK = 'direct@2026-10-14T09:00:00.000Z';
const req = (body = {}) => ({ body, session: { user: { id: 'u-4711' } } });
const CONFIG = { providerType: 'mistral', url: 'https://api.mistral.ai/v1', apiKey: 'not-a-real-key', providerName: 'Mistral' };

beforeEach(() => {
    fx.orgId = 'org-1';
    fx.counted = [];
    fx.lookups = 0;
});

test('fire-and-forget: undefined, synchronous, and the recorder is reached only afterwards', async () => {
    const r = countDirectTurn({ req: req({ chatSignalsNotice: MARK }), userId: 'u-4711', chatSignal: { pii: { status: 'clean' }, dlp: null, allowlistedHosts: [] }, config: CONFIG });
    assert.equal(r, undefined);
    assert.equal(fx.counted.length, 0, 'nothing happens on the request path');
    await settle();
    assert.equal(fx.counted.length, 1);
});

test('the PII gate\'s report decides when DLP did not run; a shield that is off reads unscanned', async () => {
    const cases = [
        [{ status: 'disabled' }, 'unscanned'],
        [{}, 'unscanned'],
        [{ status: 'clean' }, 'clean'],
        [{ status: 'found', decision: 'tokenised', categories: ['EmailAddress'] }, 'protected'],
        [{ status: 'found', decision: 'blocked', categories: ['EmailAddress'] }, 'blocked'],
        [{ status: 'failed_closed' }, 'scan_failed_closed'],
        [{ status: 'guard_absent' }, 'scan_failed_open'],
    ];
    for (const [pii] of cases) {
        countDirectTurn({ req: req({ chatSignalsNotice: MARK }), userId: 'u-4711', chatSignal: { pii, dlp: null, allowlistedHosts: [] }, config: CONFIG });
    }
    await settle();
    assert.deepEqual(fx.counted.map(c => c.outcome), cases.map(([, o]) => o));
    assert.deepEqual(fx.counted[3].categories, ['EmailAddress']);
});

test('the DLP decision wins when DLP ran', async () => {
    countDirectTurn({
        req: req({ chatSignalsNotice: MARK }), userId: 'u-4711', config: CONFIG,
        chatSignal: { pii: {}, dlp: { outcome: 'redacted', scanStatus: 'ok', categories: ['IBAN'], override: false, tooShort: false }, allowlistedHosts: ['llm.internal.example'] },
    });
    await settle();
    assert.deepEqual([fx.counted[0].outcome, fx.counted[0].categories, fx.counted[0].allowlistedHosts], ['protected', ['IBAN'], ['llm.internal.example']]);
});

test('the org key is the effective org, else the default bucket (also when the lookup fails)', async () => {
    const signal = { pii: { status: 'clean' }, dlp: null, allowlistedHosts: [] };
    countDirectTurn({ req: req(), userId: 'u-4711', chatSignal: signal, config: CONFIG });
    await settle();
    fx.orgId = null;
    countDirectTurn({ req: req(), userId: 'u-4711', chatSignal: signal, config: CONFIG });
    await settle();
    fx.orgId = new Error('ECONNREFUSED postgres://beeflow:hunter2@db');
    countDirectTurn({ req: req(), userId: 'u-4711', chatSignal: signal, config: CONFIG });
    await settle();
    assert.deepEqual(fx.counted.map(c => c.orgKey), ['org-1', 'default', 'default']);
});

test('the marker and the opt-out come from req.body; the provider is type and URL only', async () => {
    const signal = { pii: { status: 'clean' }, dlp: null, allowlistedHosts: [] };
    countDirectTurn({ req: req({ chatSignalsNotice: MARK, chatSignalsOptOut: true }), userId: 'u-4711', chatSignal: signal, config: CONFIG });
    countDirectTurn({ req: req({}), userId: 'u-4711', chatSignal: signal, config: CONFIG });
    countDirectTurn({ req: req({ chatSignalsNotice: { v: MARK }, chatSignalsOptOut: 'true' }), userId: 'u-4711', chatSignal: signal, config: CONFIG });
    await settle();
    assert.deepEqual(fx.counted.map(c => [c.surface, c.notice, c.optOut, c.dryRun]), [
        ['direct', MARK, true, false],
        ['direct', null, false, false],
        ['direct', null, false, false],
    ]);
    assert.deepEqual(fx.counted[0].providerConfig, { providerType: 'mistral', url: 'https://api.mistral.ai/v1' }, 'never the key');
    assert.deepEqual(Object.keys(fx.counted[0]).sort(), [
        'allowlistedHosts', 'categories', 'dryRun', 'notice', 'optOut', 'orgKey', 'outcome', 'providerConfig', 'surface', 'userId',
    ]);
});

test('junk never throws into the chat', async () => {
    assert.doesNotThrow(() => countDirectTurn({ req: null, userId: null, chatSignal: null, config: null }));
    assert.doesNotThrow(() => countDirectTurn({}));
    assert.doesNotThrow(() => countFixedTurn({}));
    await settle();
    assert.ok(fx.counted.every(c => c.outcome === 'unscanned'));
});

test('a fixed turn without a provider config counts unscanned with destination unknown', async () => {
    countFixedTurn({ req: req({ chatSignalsNotice: MARK }), userId: 'u-4711' });
    await settle();
    const c = fx.counted[0];
    assert.deepEqual([c.surface, c.outcome, c.providerConfig, c.categories], ['direct', 'unscanned', null, []]);

    // What the recorder makes of it: an outcome row with destination unknown.
    chatSignals._resetForTests();
    const rows = [];
    const undo = swap(chatSignalStore, 'addCounts', async (r) => { rows.push(...r); });
    try {
        assert.equal(chatSignals.recordChatTurn({ orgKey: c.orgKey, surface: c.surface, outcome: c.outcome, categories: c.categories, providerConfig: c.providerConfig, allowlistedHosts: c.allowlistedHosts, signals: ['outcomes'] }), true);
        await chatSignals.flush();
        assert.equal(rows.length, 1);
        assert.deepEqual([rows[0].value, rows[0].destination, rows[0].provider_type], ['unscanned', 'unknown', '']);
    } finally {
        undo();
        chatSignals._resetForTests();
    }
});

// ── The Swarm tier (./swarmTurn.js) ─────────────────────────────────────
const swarmRuntime = require('../../../core/swarms/swarmRuntime');
const betaFeatures = require('../../../core/entitlements/betaFeatures');
const userStore = require('../../../stores/userStore');
const { runSwarmTierTurn } = require('./swarmTurn');

function fakeRes() {
    return {
        statusCode: 200, ended: false, events: [],
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; this.ended = true; return this; },
        writeHead(c) { this.statusCode = c; },
        write(chunk) { this.events.push(chunk); },
        end() { this.ended = true; },
    };
}

test('the Swarm tier counts the turn as unscanned before its stream starts', async () => {
    const undo = [
        swap(betaFeatures, 'userHasBetaFeature', async () => true),
        swap(swarmRuntime, 'loadSwarmById', () => ({ id: 'builtin:research_swarm' })),
        swap(swarmRuntime, 'runSwarmTurn', async () => { throw new Error('stop here'); }),
        swap(modelResolver, 'resolveModelForTier', async () => 'model-x'),
        swap(userStore, 'getUser', async () => ({ id: 'u-4711', organizationId: 'org-1' })),
    ];
    try {
        const res = fakeRes();
        await runSwarmTierTurn({ req: req({ chatSignalsNotice: MARK, modelTier: 'swarm' }), res, userId: 'u-4711', message: 'research this', conversationId: null, attachments: [] });
        await settle();
        assert.equal(res.statusCode, 200);
        assert.equal(fx.counted.length, 1, 'once');
        assert.deepEqual([fx.counted[0].surface, fx.counted[0].outcome, fx.counted[0].providerConfig, fx.counted[0].notice, fx.counted[0].orgKey],
            ['direct', 'unscanned', null, MARK, 'org-1']);

        // A refused turn (no model for the tier) never reached a model: not counted.
        const undoModel = swap(modelResolver, 'resolveModelForTier', async () => null);
        const refused = fakeRes();
        await runSwarmTierTurn({ req: req({ chatSignalsNotice: MARK }), res: refused, userId: 'u-4711', message: 'x', conversationId: null, attachments: [] });
        undoModel();
        await settle();
        assert.equal(refused.statusCode, 400);
        assert.equal(fx.counted.length, 1, 'still once');
    } finally {
        undo.reverse().forEach((u) => u());
    }
});
