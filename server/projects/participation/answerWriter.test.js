/**
 * projects/participation/answerWriter.js — the automatic answer for a surface
 * that only stores answers (comment threads). Everything injected.
 *
 * Proven:
 *   - the answer goes out through the shield with the passage and the thread,
 *     under the surface's lock, with the reason in a short prompt, knowledge
 *     narrowed to what every member may read, usage as project_comment_auto,
 *     and is stored with postAnswer as a reply to the trigger;
 *   - [[SKIP]], a human reply meanwhile (stale), a busy turn, no model, a
 *     shield block and a failing model store nothing; the lock and the DLP
 *     scope are released on every path.
 *
 * Run: cd server && node --test projects/participation/answerWriter.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeAnswerWriter } = require('./answerWriter');
const { PrivacyBlocked } = require('../chatShield');
const { realClaudeAdapter, realGeminiAdapter, assertClaudeEntry, assertGeminiEntry } = require('../../core/providers/usageHarness');

/** The usage an adapter really hands back (non-streaming), for the cache tests. */
const claudeUsage = async () => (await realClaudeAdapter().chat('k', null, 'claude-sonnet-4-6', [{ role: 'user', content: 'x' }])).usage;
const geminiUsage = async () => (await realGeminiAdapter().chat('k', null, 'gemini-3-flash-preview', [{ role: 'user', content: 'x' }])).usage;

const MESSAGES = [
    { id: 'c1', seq: 1, authorKind: 'user', authorUserId: 'ann', text: 'Is this number still right for Q3?', createdAt: '2026-09-29T10:00:00Z' },
];

function world(over = {}) {
    const log = { locks: [], released: [], protect: [], llm: [], posted: [], usage: [], knowledge: [], releasedScopes: [] };
    let ctx = { projectId: 'p1', orgId: 'org1', aiMode: 'auto', closed: false, messages: [...MESSAGES], extraContext: 'Revenue Q3: 1.2M' };
    const adapter = {
        lockType: 'project_comment',
        async loadContext() { return over.later ? { ...ctx, messages: [...ctx.messages, over.later] } : ctx; },
        async postAnswer(p) { log.posted.push(p); return { messageId: 'answer-1' }; },
    };
    const writer = makeAnswerWriter({
        getProject: async () => ({ id: 'p1', name: 'Finance', customInstructions: 'Be precise.', knowledgeBaseIds: ['kb1'] }),
        getUser: async (id) => ({ id, displayName: id === 'ann' ? 'Ann' : id }),
        locks: {
            acquireTurn: async (args) => { log.locks.push(args); return { acquired: !over.busy }; },
            releaseTurn: async (args) => { log.released.push(args); return true; },
        },
        resolveModel: over.resolveModel || (async () => ({ modelId: 'fast-1', options: { maxTokens: 4096 }, providerConfig: {} })),
        searchKnowledge: async (args) => { log.knowledge.push(args); return 'Q3 revenue was restated to 1.3M.'; },
        listAudience: async () => ['ann', 'bob'],
        shieldFor: (surface) => ({
            resolve: async () => ({ enabled: true, surface }),
            protect: async (args) => { log.protect.push(args); if (over.block) throw new PrivacyBlocked('pii_block'); return { text: args.text, tokenMap: null }; },
            tokenAddendum: () => '',
            restore: (t) => t,
            release: (id) => { log.releasedScopes.push(id); },
        }),
        llmChat: over.llmChat || (async (modelId, messages, options) => { log.llm.push({ modelId, messages, options }); return { content: over.answer ?? 'The restated figure is 1.3M.', usage: over.usage ?? { total_tokens: 90 } }; }),
        logUsage: async (e) => { log.usage.push(e); },
        timeoutMs: 1000,
    });
    const job = {
        adapter,
        ctx,
        watch: { surface: 'comment', containerId: 'thread-1', authorUserId: 'ann', orgId: 'org1' },
        trigger: MESSAGES[0],
        aiTrigger: 'auto_unanswered',
        reasonCode: 'unanswered_question',
        gateLastSeq: 1,
        runId: 'run-1',
    };
    return { writer, job, log, setCtx: (c) => { ctx = c; } };
}

test('writes a short answer through the shield and stores it as a reply', async () => {
    const w = world();
    assert.deepStrictEqual(await w.writer.write(w.job), { status: 'answered', messageId: 'answer-1' });
    assert.deepStrictEqual(w.log.locks[0], {
        conversationId: 'thread-1', conversationType: 'project_comment', projectId: 'p1', userId: 'ann', runId: 'run-1', ttlMs: 31000,
    });
    const out = w.log.protect[0];
    assert.match(out.text, /<passage>\nRevenue Q3: 1.2M\n<\/passage>/);
    assert.match(out.text, /\[Ann\]: Is this number still right for Q3\?/);
    assert.strictEqual(out.conversationId, 'project-comment-auto-thread-1-run-1');
    const [{ messages, options }] = w.log.llm;
    assert.match(messages[0].content, /comment thread on a document or notebook/);
    assert.match(messages[0].content, /because a question has gone unanswered for a while/);
    assert.match(messages[0].content, /Never claim to have changed the document/);
    assert.match(messages[0].content, /Q3 revenue was restated/);
    assert.ok(options.maxTokens <= 700);
    assert.deepStrictEqual(w.log.knowledge[0].audienceIds, ['ann', 'bob']);
    assert.strictEqual(w.log.usage[0].source, 'project_comment_auto');
    assert.deepStrictEqual(w.log.posted, [{
        containerId: 'thread-1', text: 'The restated figure is 1.3M.', replyTo: 'c1', trigger: 'auto_unanswered', agentId: null,
        reasonCode: 'unanswered_question', afterSeq: 1,
    }]);
    assert.deepStrictEqual(w.log.released, [{ conversationId: 'thread-1', runId: 'run-1' }]);
    assert.deepStrictEqual(w.log.releasedScopes, ['project-comment-auto-thread-1-run-1']);
});

test('nothing is stored for [[SKIP]], a stale thread, a busy turn, no model, a block or a failure', async () => {
    const cases = [
        [{ answer: '[[SKIP]]' }, { status: 'skipped', reason: 'skip_sentinel' }],
        [{ later: { id: 'c2', seq: 2, authorKind: 'user', authorUserId: 'bob', text: 'Yes, 1.3M.' } }, { status: 'stale' }],
        [{ busy: true }, { status: 'busy' }],
        [{ resolveModel: async () => null }, { status: 'no_model' }],
        [{ block: true }, { status: 'blocked' }],
        [{ llmChat: async () => { throw new Error('upstream 500'); } }, { status: 'failed' }],
    ];
    for (const [over, expected] of cases) {
        const w = world(over);
        assert.deepStrictEqual(await w.writer.write(w.job), expected, JSON.stringify(expected));
        assert.deepStrictEqual(w.log.posted, [], 'nothing stored');
        if (!over.busy && !over.resolveModel) assert.strictEqual(w.log.released.length, 1, 'the turn is released');
    }
});

test('the usage row carries the cache read/write of a Claude or Gemini call, not zeros', async () => {
    for (const [usage, assertEntry] of [[await claudeUsage(), assertClaudeEntry], [await geminiUsage(), assertGeminiEntry]]) {
        const w = world({ usage });
        await w.writer.write(w.job);
        assert.strictEqual(w.log.usage.length, 1);
        assertEntry(w.log.usage[0]);
    }
});
