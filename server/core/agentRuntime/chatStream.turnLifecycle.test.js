/**
 * chatStream — how a streaming turn ENDS.
 *
 * The agentic loop has three exits that are not "the model stopped calling
 * tools": a client disconnect (twice) and the repeated-tool-failure bail. All
 * three used to `break` into a post-loop `if (fullResponse)` guard that could
 * never be true — `fullResponse` is assigned in exactly one place, and that
 * branch returns immediately — so every one of them fell through to
 * `throw new Error('Agent exceeded maximum tool call iterations')`. The user got
 * a hard error banner and no saved reply for a stop the runtime had chosen on
 * purpose, and the terminations table logged `max_iterations` for aborts.
 *
 * Two more end-of-turn defects are pinned here:
 *   - the end-of-turn `content_replace` (XML/think-tag strip) bypassed the DLP
 *     un-tokeniser wrapper, so the finished bubble was overwritten with
 *     [person_1]/[email_1] placeholders after having streamed real values;
 *   - processAttachments() re-ran on every loop iteration, targeting the newest
 *     TOOL RESULT from round 2 on instead of the user turn.
 *
 * HOW THIS RUNS WITHOUT POSTGRES: the turn is driven end-to-end through the real
 * chatWithAgentStream with a scripted fake provider adapter. `ephemeral: true`
 * makes the conversation in-memory (persistDurable is a no-op) and the stores /
 * heavy collaborators are swapped through testUtils/stubRequire — keys are the
 * require strings exactly as chatStream.js writes them.
 *
 * Run: node --test core/agentRuntime/chatStream.turnLifecycle.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { installResolveStub } = require('../../testUtils/stubRequire');

// ── Mutable per-test state, read by the stubs below ──────────────────
const S = {
    round: 0,
    drive: null,            // (cb, options) => void — the scripted "model"
    tools: [],
    tokenMap: {},
    events: [],
    terminations: [],
    toolsOfferedPerRound: [],
    attachmentTargets: [],
    signal: null,
};

function reset(cfg = {}) {
    S.round = 0;
    S.drive = cfg.drive || (() => {});
    S.tools = cfg.tools || [];
    S.tokenMap = cfg.tokenMap || {};
    S.events = [];
    S.terminations = [];
    S.toolsOfferedPerRound = [];
    S.attachmentTargets = [];
    S.signal = cfg.signal || null;
}

const adapter = {
    stream: async (apiKey, url, model, messages, options, cb) => {
        S.toolsOfferedPerRound.push(Array.isArray(options?.tools) ? options.tools.length : 0);
        await S.drive(cb, options, S.round++);
    },
};

const AGENT = {
    id: 'agent-1', name: 'Test Agent', model: 'claude-x', organization_id: null,
    owner_id: 'u1', config: { disableExternalTools: true }, embed_enabled: false,
};

const STUBS = {
    '../aiAgent': {
        getAIConfig: async () => ({}),
        getProviderForModel: async () => ({
            url: 'http://provider.invalid', apiKey: 'k',
            providerType: 'claude', providerName: 'claude',
        }),
        resolveModelId: async (m) => m,
    },
    '../providers': { getAdapter: () => adapter },
    '../cms/componentManager': {},
    '../executionEngine': {},
    '../../stores/agentStore': {
        getAgent: async () => AGENT,
        getForRuntime: async () => AGENT,
        getAgentToolsWithParams: async () => [],
        getConversationMeta: async () => ({}),
        updateConversation: async () => {},
        getConversationById: async () => null,
        getOrCreateConversation: async () => ({ id: 'c1', messages: [] }),
        createNewConversation: async () => ({ id: 'c1', messages: [] }),
    },
    '../../stores/usageStore': { logUsage: async () => {} },
    '../../stores/terminationStore': { logTermination: async (row) => { S.terminations.push(row); } },
    '../../stores/guardrailEventStore': {
        logGuardrailEvent: async () => {},
        logAttachmentPiiFindings: async () => {},
        logAttachmentScanIncomplete: async () => {},
    },
    '../../stores/configStore': { getConfig: async () => null },
    './agentTools': { getAgentTools: async () => S.tools },
    './modelResolver': { resolveAgentModel: async () => 'claude-x' },
    './contextBuilder': { buildSystemPrompt: async () => ({ systemPrompt: 'SYS', volatileSystemPrompt: '' }) },
    './knowledgeSearch': { performKnowledgeSearch: async () => ({}), quickKBSearch: async () => [] },
    './guardrailsRunner': { runInputGuardrails: async ({ userMessage }) => ({ processedUserMessage: userMessage }) },
    './attachmentProcessor': {
        // Faithful to the real one in the way that matters here: it mutates its
        // target in place, turning a string `content` into a block array and
        // appending the extracted text, with no idempotence guard.
        processAttachments: async (attachments, target) => {
            S.attachmentTargets.push({ role: target?.role, content: target?.content });
            const extracted = '\n\n[Attachment: notes.txt]\n---\nSECRET BODY TEXT\n---\n';
            if (typeof target.content === 'string') {
                target.content = [{ type: 'text', text: target.content + extracted }];
            } else if (Array.isArray(target.content)) {
                target.content.push({ type: 'text', text: extracted });
            }
            return {};
        },
    },
    './historyHydrator': { hydrateHistoryAttachments: async (m) => m },
    '../llm/compaction': {
        compactMessages: (m) => ({ messages: m, newSummary: null, didSummarize: false }),
        needsSummarization: () => false,
    },
    '../../telemetry/metrics': { recordAgentRun: () => {} },
    '../llm/promptClassifier': { classifyPromptComplexity: () => ({}) },
    '../documents/ocr': { mistralOCR: async () => '' },
    '../privacy/orgShield': {
        resolveShieldFor: async () => null,
        mergeWithOrgShield: (a) => a,
        classifyToolClass: () => 'internal',
        isBlockedForTool: () => ({ blocked: false, blockedCategories: [], toolClass: 'internal' }),
    },
    // The `boom` tool always throws, which the runtime turns into the
    // `[Tool '…' failed: …]` result string that the repeat-failure guard keys on.
    '../tools/toolDispatcher': {
        executeTool: async (name) => { throw new Error(`permission denied for ${name}`); },
    },
    '../llm/promptUtils': { processSystemPrompt: async (s) => s },
    '../llm/promptCacheStability': { toolSetFingerprint: () => 'tf', systemPrefixFingerprint: () => 'sf' },
    '../privacy/guardrails': { checkRegexPatterns: () => [] },
    // The conversation token vault. The real un-tokeniser (untokeniseStream) is
    // deliberately NOT stubbed — this suite asserts on what it actually emits.
    '../dlp/dlpRunner': {
        getConversationTokenMap: () => S.tokenMap,
        getConversationTokenMapAsync: async () => S.tokenMap,
        mergeTokenMap: () => {},
    },
};

// chatStream became a FOLDER (chatStream/index.js + the turn's phases), so the
// modules under test now write every require one '../' deeper than they used
// to. installResolveStub matches the request string exactly as the module
// writes it, so each stub is registered at BOTH depths: the shallow key still
// covers the agentRuntime modules that did not move, the deeper one covers the
// ones that did. Missing a key here fails SILENTLY — the real module loads and
// the turn dies on a live Postgres connect somewhere unrelated.
const atBothDepths = (map) => {
    const out = { ...map };
    for (const [request, exportsObj] of Object.entries(map)) {
        const deeper = request.startsWith('./') ? '../' + request.slice(2)
            : request.startsWith('../') ? '../' + request
                : null;
        if (deeper && !(deeper in out)) out[deeper] = exportsObj;
    }
    return out;
};
const restore = installResolveStub(atBothDepths(STUBS));

const { chatWithAgentStream } = require('./chatStream');

test.after(() => restore());

const FAILING_TOOL = [{
    type: 'function',
    function: { name: 'boom', description: 'always fails', parameters: { type: 'object', properties: {} } },
}];

async function runTurn(meta = {}) {
    const events = S.events;
    const onEvent = (type, data) => events.push([type, data]);
    let result = null, error = null;
    try {
        result = await chatWithAgentStream(
            'agent-1', 'u1', 'hi',
            { userId: 'u1', encryptionKey: null, session: {} },
            onEvent, null,
            { ephemeral: true, signal: S.signal, ...meta },
        );
    } catch (e) { error = e; }
    return { result, error, events };
}

const textOf = (events, type) => events.filter(([t]) => t === type).map(([, d]) => d?.text);

test('repeated tool failure ends the turn with a real answer, not a max_iterations error', async () => {
    reset({
        tools: FAILING_TOOL,
        // A plausible model: it retries the failing tool for as long as tools are
        // offered, and answers in prose once they are withheld.
        drive: (cb, options) => {
            if (options?.tools?.length) {
                cb('tool_use', { id: `call_${Math.random().toString(36).slice(2)}`, name: 'boom', input: { q: 'same' } });
            } else {
                cb('text', { text: 'The boom tool keeps failing, so I stopped retrying it.' });
            }
            cb('done', {});
        },
    });

    const { result, error, events } = await runTurn();

    assert.strictEqual(error, null, 'a graceful loop bail must not throw');
    assert.ok(events.some(([t]) => t === 'tool_loop_broken'), 'the client is told the loop was stopped on purpose');
    assert.ok(!events.some(([t]) => t === 'error'), 'no error frame for a deliberate stop');
    assert.match(result.message, /stopped retrying/,
        'the turn must produce (and return) an assistant answer — before the fix this threw ' +
        '"Agent exceeded maximum tool call iterations" and no assistant message was built at all');
    assert.deepStrictEqual(S.terminations.map(t => t.termination_type), [],
        'a deliberate bail is not a max_iterations termination');
});

test('the wrap-up round withholds the tools and happens exactly once', async () => {
    reset({
        tools: FAILING_TOOL,
        drive: (cb, options) => {
            if (options?.tools?.length) {
                cb('tool_use', { id: `call_${Math.random().toString(36).slice(2)}`, name: 'boom', input: { q: 'same' } });
            } else {
                cb('text', { text: 'done' });
            }
            cb('done', {});
        },
    });

    await runTurn();

    // MAX_TOOL_REPEAT = 3 failing rounds with tools, then one tool-free round.
    assert.strictEqual(S.toolsOfferedPerRound.length, 4, 'exactly one extra round after the bail');
    assert.ok(S.toolsOfferedPerRound.slice(0, 3).every(n => n > 0), 'the first rounds offer tools');
    assert.strictEqual(S.toolsOfferedPerRound[3], 0,
        'the wrap-up round must offer no tools — otherwise it can loop again');
});

test('a client disconnect logs exactly one termination row and raises an AbortError', async () => {
    const controller = new AbortController();
    reset({
        tools: FAILING_TOOL,
        signal: controller.signal,
        drive: (cb) => {
            cb('tool_use', { id: 'call_a', name: 'boom', input: { q: 1 } });
            cb('done', {});
            controller.abort();   // client goes away mid-turn
        },
    });

    const { error } = await runTurn();

    assert.ok(error, 'the turn stops');
    assert.strictEqual(error.name, 'AbortError',
        'routes/agents/chat.js keys its silent-abort branch off AbortError / signal.aborted');
    assert.strictEqual(error._terminationLogged, true, 'the abort row is already written; callers must not re-log');
    assert.deepStrictEqual(S.terminations.map(t => t.termination_type), ['aborted'],
        'an abort must not also be counted as max_iterations');
});

test('end-of-turn content_replace is un-tokenised for display while the stored text stays tokenised', async () => {
    reset({
        tokenMap: { '[person_1]': 'Tom Smit' },
        drive: (cb) => {
            cb('text', { text: 'Hello [person_1], ' });
            // The stray <tool_call> block makes the strip step change the length,
            // which is what fires content_replace.
            cb('text', { text: 'here is the answer.<tool_call>{"x":1}</tool_call>' });
            cb('done', {});
        },
    });

    const { result, events } = await runTurn();

    assert.deepStrictEqual(textOf(events, 'content'), ['Hello Tom Smit, ', 'here is the answer.<tool_call>{"x":1}</tool_call>'],
        'live content is un-tokenised by the streaming wrapper');
    assert.deepStrictEqual(textOf(events, 'content_replace'), ['Hello Tom Smit, here is the answer.'],
        'the replacement that overwrites the rendered bubble must carry the real value, ' +
        'not [person_1] — the wrapper has to intercept content_replace like it does content');
    assert.strictEqual(result.message, 'Hello [person_1], here is the answer.',
        'storage stays tokenised by design (reads restore on the way out)');
});

test('attachments are processed once, against the user turn — never against a tool result', async () => {
    reset({
        tools: FAILING_TOOL,
        drive: (cb, options, round) => {
            if (round === 0) cb('tool_use', { id: 'call_a', name: 'boom', input: { q: 1 } });
            else cb('text', { text: 'done' });
            cb('done', {});
        },
    });

    await runTurn({ attachments: [{ name: 'notes.txt', type: 'text/plain', content: 'SECRET BODY TEXT' }] });

    assert.strictEqual(S.attachmentTargets.length, 1,
        'processAttachments re-ran per loop iteration: paid OCR/upload + DLP scan every tool round');
    assert.strictEqual(S.attachmentTargets[0].role, 'user',
        'from round 2 the last message is the newest tool result — hydrating the attachment onto it ' +
        'corrupts a role-`tool` message that is shared with durableMessages and written to Postgres');
});

// ── Structural guard ────────────────────────────────────────────────
// Cheap, cannot rot with the dependency graph, and pins the exact regression:
// re-introducing a `break` for the loop bail silently restores the bogus
// "exceeded maximum tool call iterations" ending.
test('the repeated-failure bail continues into the wrap-up round instead of breaking', () => {
    // chatStream is a folder: read every module in it, so the bail cannot move
    // into a sibling and take this guard's coverage with it.
    const dir = path.join(__dirname, 'chatStream');
    const src = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
        .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const idx = src.indexOf("onEvent('tool_loop_broken'");
    assert.ok(idx > 0, 'the loop-bail moved — re-check where tool_loop_broken is emitted');
    const tail = src.slice(idx, idx + 900);
    const stop = tail.search(/\bbreak;|\bcontinue;/);
    assert.ok(stop >= 0, 'the bail must end the round explicitly');
    assert.ok(tail.slice(stop).startsWith('continue;'),
        'the bail must `continue` into the tool-free wrap-up round; `break` drops the turn into ' +
        'the max_iterations throw at the end of chatWithAgentStreamImpl');
});
