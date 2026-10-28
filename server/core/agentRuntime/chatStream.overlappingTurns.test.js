// @typecheck
/**
 * Two turns on one agent conversation at the same time (issue #419).
 *
 * The real chatWithAgentStream (agentTurn.testkit.js: a scripted provider, the
 * heavy collaborators stubbed) on the REAL conversation store, backed by
 * PGlite (testUtils/pglitePool.js). Each turn read the stored history when it
 * started. An agent turn used to save that history plus its own rows as a
 * full replace, so a turn that finished in the meantime (a second tab or
 * device, the Nextcloud embed next to the web app, a question asked again
 * after a dropped stream while the server was still answering) was deleted.
 *
 * Pinned: both turns survive, each right after the history it was asked on,
 * in the order they were asked; an edit/retry still rewrites the history.
 *
 * Run: cd server && node --test core/agentRuntime/chatStream.overlappingTurns.test.js
 */
'use strict';

require('../../boot/featureModules'); // core looks feature modules up by name (core/featureModules.js)
const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
// The real store, loaded before the kit swaps the runtime's require of it.
const agentConversations = require('../../stores/agent/agentConversations');
const convMessages = require('../../stores/agent/conversationMessages');
const { saveConversationTurn } = require('../../stores/agent/conversationTurns');
const { initDB } = require('../../stores/agent/initSchema');
const { installAgentTurnHarness, turnState, resetTurnState } = require('./agentTurn.testkit');

const USER = 'u1';

/** @type {import('./agentTurn.testkit').TurnState & { gates: Map<string, { reached: () => void, release: Promise<void> }> }} */
const S = { ...turnState(), gates: new Map() };

const kit = installAgentTurnHarness(S, {
    stubs: {
        '../../stores/agentStore': {
            getConversationById: agentConversations.getConversationById,
            getOrCreateConversation: agentConversations.getOrCreateConversation,
            createNewConversation: agentConversations.createNewConversation,
            updateConversation: agentConversations.updateConversation,
            saveConversationTurn,
            updateConversationMeta: async () => {},
        },
        '../memory/memoryPolicy': { resolveMemoryPolicy: async () => ({ read: false, write: false, reason: 'test' }) },
    },
});

test.before(async () => {
    await initDB();
    await convMessages.initDB();
    await pg.query("INSERT INTO agents (id, name, owner_id) VALUES ('agent-1', 'Agent', $1)", [USER]);
});
test.after(async () => { kit.restore(); await close(); });

/**
 * The provider: answers "answer to <question>". A question with a gate waits
 * for its release first, so another turn can finish in the meantime.
 */
function drive(/** @type {(type: string, data: unknown) => void} */ cb, /** @type {unknown} */ _options, /** @type {number} */ _round, /** @type {{ role: string, content: unknown }[]} */ messages) {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const question = typeof last?.content === 'string' ? last.content : '';
    const gate = S.gates.get(question);
    const answer = () => { cb('text', { text: `answer to ${question}` }); cb('done', {}); };
    if (!gate) return answer();
    gate.reached();
    return gate.release.then(answer);
}

/** A conversation with one stored exchange, read from conversation_messages. */
async function conversationWithHistory() {
    const conv = await agentConversations.createConversation('agent-1', USER, 'Chat');
    await agentConversations.updateConversation(conv.id, [
        { id: `${conv.id}:h1`, role: 'user', content: 'first question' },
        { id: `${conv.id}:h2`, role: 'assistant', content: 'first answer' },
    ], null, USER);
    await pg.query('UPDATE agent_conversations SET messages_migrated = TRUE WHERE id = $1', [conv.id]);
    return conv.id;
}

/**
 * @param {string} conversationId
 * @param {string} question
 * @param {unknown[] | null} [historyOverride]
 */
function ask(conversationId, question, historyOverride = null) {
    return kit.chatWithAgentStream(
        'agent-1', USER, question,
        { userId: USER, encryptionKey: null, session: {} },
        () => {}, historyOverride,
        { conversationId, ephemeral: false },
    );
}

/** Hold `question` at the provider until the returned release is called. */
function holdAtProvider(/** @type {string} */ question) {
    /** @type {() => void} */
    let release = () => {};
    /** @type {() => void} */
    let reached = () => {};
    const atProvider = new Promise((resolve) => { reached = () => resolve(undefined); });
    S.gates.set(question, { reached, release: new Promise((resolve) => { release = () => resolve(undefined); }) });
    return { atProvider, release: () => release() };
}

/** @param {string} id */
async function stored(id) {
    const conv = await agentConversations.getConversationById(id, null, { restore: false });
    return (conv?.messages || []).map((/** @type {{ content: unknown }} */ m) => m.content);
}

test.beforeEach(() => {
    resetTurnState(S, { drive });
    S.gates.clear();
});

test('two overlapping turns, B finishing first: both survive, in the order they were asked', async () => {
    const id = await conversationWithHistory();
    const a = holdAtProvider('question A');
    const turnA = ask(id, 'question A');
    await a.atProvider;              // A read the history and is waiting for the model
    await ask(id, 'question B');     // B reads the same history and finishes first
    a.release();
    await turnA;
    assert.deepStrictEqual(await stored(id), [
        'first question', 'first answer',
        'question A', 'answer to question A',
        'question B', 'answer to question B',
    ]);
});

test('a retry after a dropped stream: the answer the server was still writing is not lost', async () => {
    const id = await conversationWithHistory();
    // The client lost the stream of the first try; the server is still on it.
    const first = holdAtProvider('same question');
    const firstTry = ask(id, 'same question');
    await first.atProvider;
    S.gates.clear();                 // the retry is answered at once
    await ask(id, 'same question');
    first.release();
    await firstTry;
    assert.deepStrictEqual(await stored(id), [
        'first question', 'first answer',
        'same question', 'answer to same question',
        'same question', 'answer to same question',
    ]);
});

test('an edit/retry with its own history still rewrites the conversation on purpose', async () => {
    const id = await conversationWithHistory();
    await ask(id, 'question B');
    await ask(id, 'edited question', [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' }]);
    assert.deepStrictEqual(await stored(id), [
        'first question', 'first answer',
        'edited question', 'answer to edited question',
    ]);
});
