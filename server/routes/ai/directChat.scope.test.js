/**
 * The direct-chat stream handler always closes the stream it opened.
 *
 * The route body is one very long `try { … } catch { … } finally { … }`, and
 * twice a `let` the catch or the finally reads was declared INSIDE the try:
 * first `_persistInterruptedTurn`, then `_turnLock` (which fired on EVERY turn,
 * shared thread or not). Reading such a binding there throws a ReferenceError,
 * and because the throw happens in the catch/finally it skips `res.end()`.
 * Express then tears the socket down with the headers already sent, so the
 * browser sees a completed answer followed by a dead stream and reports it as
 * "interrupted". Both are invisible to `node --check` and to any test that only
 * reads the file: it parses fine, and it only breaks when the turn fails.
 *
 * So this drives the handler with every phase cut at the require seam and
 * FAILS turns on purpose: a crash before the tool loop, a crash inside it, a
 * lock release that throws, and a user pressing stop. Each one must still end
 * the response — and the two named regressions are exactly the paths where it
 * would not.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/directChat.scope.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

// ── What each phase does this turn ───────────────────────────────────
const fx = {
    /** Thrown by assembleToolStack — a crash before anything is armed. */
    toolStackError: null,
    /** Thrown by adapter.stream — a crash after the tool loop armed the hooks. */
    streamError: null,
    /** Thrown by conversationLockStore.releaseTurn inside the finally. */
    releaseError: null,
    /** The shared-thread lock claimSharedThreadTurn puts on the turn. */
    turnLock: null,
    /** Recorders. */
    events: [],
    ended: 0,
    released: [],
    persisted: [],
    orgProblems: [],
    /** Chat signals: what the input gates do, and what was handed to the counter. */
    gatesError: null,
    gatesEndedStream: false,
    gateArgs: null,
    counted: [],
};

const noop = () => {};
const silentLog = { info: noop, warn: noop, error: noop, debug: noop };

const MOCKS = {
    '../../../telemetry/log': silentLog,
    '../../../stores/configStore': { getConfig: async () => null },
    '../../../stores/agentStore': {
        getDirectConversation: async () => ({ messages: [] }),
        updateDirectConversation: async (convId, msgs) => { fx.persisted.push({ convId, msgs }); },
    },
    '../../../core/tools/sessionSkillRuntime': {
        ACTIVATE_SESSION_SKILL_TOOL_NAME: 'activate_session_skill',
        COMPLETE_SESSION_SKILL_TOOL_NAME: 'complete_session_skill',
    },
    '../../../integrations/workspaceTools': { syncClientWorkspaceContent: async () => ({ seeded: false }) },
    '../../../core/dlp/applyTokenMapToOutbound': { applyTokenMapToMessages: ({ messages }) => messages },
    './directChat/toolExec': { executeDirectChatToolCall: async () => ({}) },
    '../../../services/orgHealth': {
        problem: (kind, meta) => fx.orgProblems.push({ kind, meta }),
        resolve: noop,
    },
    './directChat/shared': {
        encryptionOpts: () => ({}),
        emitThreadEvent: async () => {},
        _resolveChatProblemsThrottled: noop,
    },
    '../../../core/agentRuntime/phaseEvents': { emitPhase: noop, emitPhaseEnd: noop },
    '../../../core/http/sseHelpers': { startSseHeartbeat: noop },
    '../../../utils/routeHelpers': { getUserAuth: () => ({ userId: 'alice' }) },
    '../../../auth/permissions': { requireAuth: (req, res, next) => next() },
    './directChat/swarmTurn': { runSwarmTierTurn: async () => {} },

    // ── The turn's phases ────────────────────────────────────────────
    './directChat/turnSetup': {
        resolveTurnSetup: async () => ({
            resolvedTier: 'standard', tier: 'standard', modelId: 'm1',
            config: { providerType: 'claude', providerName: 'Claude' },
            adapter: { stream: async () => { if (fx.streamError) throw fx.streamError; } },
            apiKey: 'k', apiUrl: 'u', userOrgForTiers: 'org-1', orgIdsForTiers: new Set(['org-1']),
        }),
    },
    './directChat/toolStackAssembly': {
        assembleToolStack: async () => {
            if (fx.toolStackError) throw fx.toolStackError;
            return { directChatTools: [], canUseNotebooks: false, toolCatalogText: '' };
        },
    },
    './directChat/promptAssembly': {
        buildPromptAndHistory: async () => {
            const volatileMessage = { role: 'system', content: 'Now: …' };
            return {
                messages: [{ role: 'system', content: 'STABLE' }, volatileMessage, { role: 'user', content: 'hi' }],
                volatileMessage, resolvedHistory: [], usableKbIds: [],
            };
        },
    },
    './directChat/sharedThreadLock': {
        claimSharedThreadTurn: async (turn) => {
            turn._turnLock = fx.turnLock;
            turn._sharedThread = fx.turnLock ? { projectId: 'p1' } : null;
            return true;
        },
    },
    './directChat/sessionSkillSetup': {
        setupSessionSkills: async () => ({
            sessionSkills: [], activatedSessionSkillIds: [], completedSessionSkillIds: [],
            sessionSkillsCompletions: {}, isStandardTier: true,
        }),
    },
    './directChat/stageModelSwap': { swapModelForActiveStage: async () => {} },
    './directChat/attachmentIntake': {
        processAttachmentsAndUserMessage: async () => ({ convId: 'c1', persistedAttachments: [], tokenizedMessage: 'hi' }),
    },
    './directChat/inputGates': {
        runInputGates: async (args) => {
            fx.gateArgs = args;
            if (fx.gatesError) throw fx.gatesError;
            return fx.gatesEndedStream ? undefined : { userOrgId: 'org-1', piiTokenMap: null, tokenizedMessage: 'hi' };
        },
    },
    './directChat/chatSignalsTurn': { countDirectTurn: (args) => { fx.counted.push(args); } },
    './directChat/compactionPhase': { compactConversation: async () => {} },
    './directChat/chatOptions': { buildChatOptions: (turn) => { turn.chatOptions = {}; } },
    './directChat/stepMachine': {
        computeStepMachineGuard: () => ({ systemAppend: '', toolChoice: undefined, mode: 'auto', mute: false }),
        pipelineNeedsWrapUp: () => false,
        callAdapterWithFallback: async (call, tc) => call(tc),
    },
    './directChat/toolRefresh': { applyLoadTools: noop, onSkillsActivated: noop },
    './directChat/toolContext': { createToolContextFactory: () => () => ({}) },
    './directChat/streamCallbacks': {
        createUntokeniserSink: noop,
        createStreamCallbacks: () => ({ primary: noop, follow: noop }),
        snapshotThinkingParts: () => [],
    },
    './directChat/toolResultEvents': { emitToolResultEvents: async () => {} },
    './directChat/turnUsage': { logTurnUsage: async () => {} },
    './directChat/finalizeTurn': { finalizeDirectChatTurn: async () => ({}) },

    // ── Lazily required inside the handler ───────────────────────────
    './directChat/interruptedTurn': { buildInterruptedTurnMessages: ({ errorNote }) => [{ role: 'assistant', content: errorNote }] },
    '../../../stores/conversationLockStore': {
        releaseTurn: async (lock) => {
            if (fx.releaseError) throw fx.releaseError;
            fx.released.push(lock);
        },
    },
    '../../../core/dlp/dlpRunner': { getConversationTokenMap: () => ({}) },
};

// The handler's own requires are relative to routes/ai/directChat/; this file
// sits one level up, so the mock keys above are rewritten to the paths the
// module under test actually asks for.
const IDS = {};
for (const [key, exportsObj] of Object.entries(MOCKS)) {
    const request = key.startsWith('./directChat/') ? `./${key.slice('./directChat/'.length)}` : key;
    const id = `mock:directchat-scope:${request}`;
    IDS[request] = id;
    require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /directChat[\\/]streamTurn\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(IDS, request)) {
        return IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./directChat/streamTurn');

test.after(() => { Module._resolveFilename = originalResolve; });

/** The POST /chat/direct/stream handler, past requireAuth. */
function handler() {
    const layer = router.stack.find(l => l.route && l.route.path === '/chat/direct/stream');
    assert.ok(layer, 'the streamed direct-chat route is no longer mounted here');
    const handlers = layer.route.stack.map(s => s.handle);
    return handlers[handlers.length - 1];
}

function makeRes() {
    return {
        writableEnded: false,
        destroyed: false,
        headersSent: false,
        writeHead() { this.headersSent = true; },
        write(chunk) {
            const m = /^event: ([^\n]+)\ndata: ([\s\S]*)\n\n$/.exec(chunk);
            if (m) fx.events.push({ event: m[1], data: JSON.parse(m[2]) });
        },
        end() { this.writableEnded = true; fx.ended++; },
        on() {},
    };
}

async function runTurn() {
    fx.events.length = 0;
    fx.ended = 0;
    fx.released.length = 0;
    fx.persisted.length = 0;
    fx.orgProblems.length = 0;

    const req = {
        body: { message: 'hi', conversationId: 'c1', modelTier: 'standard' },
        session: { user: { id: 'alice', organizationId: 'org-1' } },
    };
    const res = makeRes();
    await handler()(req, res);
    return res;
}

function reset() {
    fx.toolStackError = null;
    fx.streamError = null;
    fx.releaseError = null;
    fx.turnLock = null;
    fx.gatesError = null;
    fx.gatesEndedStream = false;
    fx.gateArgs = null;
    fx.counted.length = 0;
}

// ═══ 1. A crash still closes the stream ══════════════════════════

test('a turn that dies before the tool loop still ends the response', async () => {
    reset();
    fx.toolStackError = new Error('tool stack blew up');
    const res = await runTurn();

    assert.strictEqual(fx.ended, 1, 'the SSE stream was left open — the browser reports a hung answer');
    assert.ok(res.writableEnded);
    const err = fx.events.find(e => e.event === 'error');
    assert.ok(err, 'the client was never told the turn failed');
});

test('a turn that dies mid-stream persists what already happened AND ends the response', async () => {
    reset();
    fx.streamError = new Error('provider hung up');
    const res = await runTurn();

    // `_persistInterruptedTurn` is read by the outer catch. Declared inside the
    // try it throws a ReferenceError there — which skips both of these.
    assert.strictEqual(fx.persisted.length, 1, 'the interrupted turn was not saved — the next turn re-runs the side effects');
    assert.strictEqual(fx.ended, 1, 'the SSE stream was left open');
    assert.ok(res.writableEnded);
    assert.ok(fx.events.some(e => e.event === 'error'), 'the client was never told the turn failed');
    assert.ok(fx.orgProblems.some(p => p.kind === 'chat.provider_error'), 'a provider failure must reach org health');
});

// ═══ 2. The shared-thread lock ═══════════════════════════════════

test('a crash releases the shared-thread turn lock instead of holding it for its TTL', async () => {
    reset();
    fx.turnLock = { conversationId: 'c1', runId: 'run_1' };
    fx.streamError = new Error('provider hung up');
    await runTurn();

    assert.deepStrictEqual(fx.released, [{ conversationId: 'c1', runId: 'run_1' }]);
    assert.strictEqual(fx.ended, 1);
});

test('a release that throws does not strand the stream', async () => {
    reset();
    fx.turnLock = { conversationId: 'c1', runId: 'run_1' };
    fx.releaseError = new Error('lock store unreachable');
    const res = await runTurn();

    assert.strictEqual(fx.ended, 1, 'work in the finally ran unguarded before res.end()');
    assert.ok(res.writableEnded);
});

test('a turn with no shared thread releases nothing and still ends', async () => {
    reset();
    const res = await runTurn();
    assert.deepStrictEqual(fx.released, [], 'a solo conversation never took a lock');
    assert.strictEqual(fx.ended, 1);
    assert.ok(res.writableEnded);
});

// ═══ 3. The user pressed stop ════════════════════════════════════

test('a cancelled turn closes quietly — no error event, no org-health outage', async () => {
    reset();
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    fx.streamError = abort;
    const res = await runTurn();

    assert.strictEqual(fx.ended, 1);
    assert.ok(res.writableEnded);
    assert.ok(!fx.events.some(e => e.event === 'error'), 'a cancel is not a failure to report to the client');
    assert.deepStrictEqual(fx.orgProblems, [], 'a cancelled answer must not poison the org-health signal');
});

// ═══ 4. Chat signals: one count per turn that reached the gates ═══

test('chat signals: a turn the gates let through is counted once, with what the gates filled in', async () => {
    reset();
    await runTurn();
    assert.strictEqual(fx.counted.length, 1);
    const c = fx.counted[0];
    assert.strictEqual(c.chatSignal, fx.gateArgs.chatSignal, 'the accumulator the gates wrote into is the one counted');
    assert.deepStrictEqual(c.chatSignal, { pii: {}, dlp: null, allowlistedHosts: [] });
    assert.strictEqual(c.userId, 'alice');
    assert.deepStrictEqual(c.config, { providerType: 'claude', providerName: 'Claude' }, 'the turn\'s model config, for internal vs external');
});

test('chat signals: a gate that ended the stream is counted once too', async () => {
    reset();
    fx.gatesEndedStream = true;
    await runTurn();
    assert.strictEqual(fx.counted.length, 1, 'a blocked turn is exactly what the coverage check needs to see');
});

test('chat signals: a throw from the gates is not counted', async () => {
    reset();
    fx.gatesError = new Error('shield resolution failed');
    const res = await runTurn();
    assert.strictEqual(fx.counted.length, 0, 'an unexpected error is never a Shield outcome');
    assert.ok(res.writableEnded);
});

test('chat signals: a turn that dies before the gates is not counted', async () => {
    reset();
    fx.toolStackError = new Error('tool stack blew up');
    await runTurn();
    assert.strictEqual(fx.counted.length, 0, 'it never reached the Shield');
});
