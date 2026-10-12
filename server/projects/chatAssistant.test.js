/**
 * projects/chatAssistant.js — the AI member of a team chat, with every
 * collaborator injected (store, sealing, lock, shield, model, persona,
 * knowledge, feed, usage). No module mocking, no database.
 *
 * Proven:
 *   - the trigger rule: off / mention / always, @ai, @assistant, askAi,
 *     @<agent name>, and look-alikes that must not trigger;
 *   - no answer is queued when the subscription limit says no, when no model
 *     is configured, or when another answer holds the chat's turn (busy);
 *   - a queued answer reads the transcript under display names (never an
 *     e-mail address), the project instructions, the persona and the
 *     knowledge passages; stores the answer sealed with the project key as a
 *     reply to the question; logs usage; announces started → created →
 *     finished; releases the turn;
 *   - Privacy Shield tokens go out tokenised and come back restored;
 *   - a failing model, a timeout and a Privacy Shield block all release the
 *     turn and finish with a bare status: no error text and no content in
 *     any event;
 *   - an explicit answer is logged for the automatic cooldown;
 *   - an automatic answer (auto_quiet / auto_unanswered): the short prompt
 *     with its reason and [[SKIP]], a smaller token budget, `ai_trigger` and
 *     the reason code on the stored answer, the stale-answer check handed to
 *     the store, knowledge from the bases every member may read, usage as
 *     project_chat_auto, and silence: no chat.ai.* events, not even on
 *     failure; a [[SKIP]] or stale answer stores nothing.
 *
 * Run: cd server && node --test projects/chatAssistant.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
    makeChatAssistant, decideAiTrigger, mentionsAssistant, displayNameOf, buildTranscript, searchProjectKnowledge, listProjectAudience, listChatAgents,
} = require('./chatAssistant');
const { makeChatCrypto } = require('./chatCrypto');
const { realClaudeAdapter, realGeminiAdapter, assertClaudeEntry, assertGeminiEntry } = require('../core/providers/usageHarness');

/** The usage an adapter really hands back (non-streaming), for the cache tests. */
const claudeUsage = async () => (await realClaudeAdapter().chat('k', null, 'claude-sonnet-4-6', [{ role: 'user', content: 'x' }])).usage;
const geminiUsage = async () => (await realGeminiAdapter().chat('k', null, 'gemini-3-flash-preview', [{ role: 'user', content: 'x' }])).usage;
const { PrivacyBlocked } = require('./chatShield');

const PROJECT = {
    id: 'p1', name: 'Launch', organizationId: 'org1',
    customInstructions: 'Always answer in British English.', knowledgeBaseIds: ['kb1'],
};
const USERS = {
    ann: { id: 'ann', displayName: 'Ann', username: 'ann', email: 'ann@example.test' },
    bob: { id: 'bob', displayName: '', username: 'bob@example.test', email: 'bob@example.test' },
};

// ── The trigger rule ─────────────────────────────────────────────────────

test('decideAiTrigger: off never, always always, mention only when asked', () => {
    assert.deepStrictEqual(decideAiTrigger({ aiMode: 'off', content: '@ai help', askAi: true }), { trigger: false, reason: 'ai_off' });
    assert.deepStrictEqual(decideAiTrigger({ aiMode: 'always', content: 'anything' }), { trigger: true, kind: 'always' });
    assert.deepStrictEqual(decideAiTrigger({ aiMode: 'mention', content: 'hello' }), { trigger: false, reason: 'not_mentioned' });
    assert.deepStrictEqual(decideAiTrigger({ aiMode: 'mention', content: 'hello', askAi: true }), { trigger: true, kind: 'ask' });
    assert.deepStrictEqual(decideAiTrigger({ aiMode: 'mention', content: '@ai hello' }), { trigger: true, kind: 'mention' });
    // auto: an explicit request is answered now, anything else goes to the engine.
    assert.deepStrictEqual(decideAiTrigger({ aiMode: 'auto', content: 'hello', askAi: true }), { trigger: true, kind: 'ask' });
    assert.deepStrictEqual(decideAiTrigger({ aiMode: 'auto', content: '@assistant hello' }), { trigger: true, kind: 'mention' });
    assert.deepStrictEqual(decideAiTrigger({ aiMode: 'auto', content: 'what is the plan?' }), { trigger: false, reason: 'auto_pending' });
    for (const yes of ['@ai help', 'what now, @AI?', '@assistant: summarise', '(@ai) check', 'hey @Assistant!']) {
        assert.strictEqual(mentionsAssistant(yes), true, yes);
    }
    for (const no of ['mail me@ai.example', '@aim high', '@ai-team standup', 'email@assistant.io', 'ai please', '@@ai']) {
        assert.strictEqual(mentionsAssistant(no), false, no);
    }
    assert.strictEqual(mentionsAssistant('@Sales Coach what now?', 'Sales Coach'), true);
    assert.strictEqual(mentionsAssistant('@sales coach what now?', 'Sales Coach'), true);
    assert.strictEqual(mentionsAssistant('@Sales Coaching', 'Sales Coach'), false);
    assert.strictEqual(mentionsAssistant('@C++ (bot) help', 'C++ (bot)'), true, 'names are matched literally');
    assert.deepStrictEqual(decideAiTrigger({ aiMode: 'mention', content: '@Sales Coach?', agentName: 'Sales Coach' }), { trigger: true, kind: 'mention' });
});

test('display names never fall back to an e-mail address', () => {
    assert.strictEqual(displayNameOf(USERS.ann), 'Ann');
    assert.strictEqual(displayNameOf(USERS.bob), 'A project member');
    assert.strictEqual(displayNameOf({ username: 'bobby' }), 'bobby');
    assert.strictEqual(displayNameOf(null), 'A project member');
});

test('the transcript keeps the newest messages when it must cut', () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ author: 'Ann', text: `${i}:${'x'.repeat(3000)}` }));
    const t = buildTranscript(lines, { askerName: 'Ann', persona: null });
    assert.ok(t.includes('39:'), 'the newest message is kept');
    assert.ok(!t.includes('[Ann]: 0:'), 'the oldest are dropped first');
    assert.ok(t.length < 60000);
    assert.match(t, /latest message from Ann/);
});

// ── The assistant ────────────────────────────────────────────────────────

function world(overrides = {}) {
    const key = crypto.randomBytes(32);
    const chatCrypto = makeChatCrypto({ getProjectKey: async () => key });
    const log = { transient: [], durable: [], usage: [], llm: [], released: [], acquired: [], appended: [], knowledge: [], persona: [], protect: [], cleared: [], replies: [], audience: [], listed: [] };
    const messages = [];
    const chat = { id: 'c1', projectId: 'p1', agentId: overrides.agentId ?? null, aiMode: 'mention' };

    async function seed(box, list) {
        let seq = 0;
        for (const [author, text, kind = 'user'] of list) {
            const id = `m${++seq}`;
            messages.push({
                id, chatId: 'c1', seq, authorKind: kind, authorUserId: kind === 'user' ? author : null,
                content: box.sealContent('c1', id, text), deletedAt: null,
            });
        }
    }

    const store = {
        async listMessages(chatId, { limit, threadId }) {
            assert.strictEqual(chatId, 'c1');
            log.listed.push({ limit, threadId });
            const scoped = typeof threadId === 'string' ? messages.filter((m) => m.id === threadId || m.threadId === threadId) : messages;
            return { messages: scoped.slice(-limit), hasMore: false };
        },
        async appendMessage(m) {
            log.appended.push(m);
            if (overrides.chatGone) return null;
            if (Number.isFinite(m.unlessHumanAfterSeq)
                && messages.some((x) => x.authorKind === 'user' && x.seq > m.unlessHumanAfterSeq)) return { stale: true };
            const stored = { ...m, seq: messages.length + 1, deletedAt: null };
            messages.push(stored);
            return { message: stored, created: true };
        },
    };

    let lockHeld = overrides.lockHeld || false;
    const locks = {
        async acquireTurn(args) {
            log.acquired.push(args);
            if (lockHeld) return { acquired: false, holder: { holderUserId: 'someone' } };
            lockHeld = true;
            return { acquired: true, runId: args.runId };
        },
        async releaseTurn(args) { log.released.push(args); lockHeld = false; return true; },
    };

    const shield = {
        async resolve({ orgId, userId }) { log.shieldFor = { orgId, userId }; return { enabled: true, marker: 'shield' }; },
        async protect(args) {
            log.protect.push(args);
            if (overrides.privacyBlock) throw new PrivacyBlocked('pii_block');
            if (overrides.tokenise) {
                return { text: args.text.replace(/0612345678/g, '[phone_1]'), tokenMap: { '[phone_1]': '0612345678' } };
            }
            return { text: args.text, tokenMap: null };
        },
        tokenAddendum: (map) => (map ? '\n\n[TOKENS]' : ''),
        restore: (text, map) => (map ? text.split('[phone_1]').join(map['[phone_1]']) : text),
        release: (id) => { log.cleared.push(id); },
        toolGate: (args) => {
            log.gates = (log.gates || []).concat([args]);
            return {
                refuse: async (name, a) => (overrides.refuseTool && overrides.refuseTool(name, a) ? { modelError: 'blocked by shield' } : null),
                forModel: async (content) => content,
            };
        },
        searchGuard: () => async (query) => { (log.searchChecks = log.searchChecks || []).push(query); return overrides.blockSearch ? { modelError: 'guard says no' } : null; },
        restoreArgs: (args, map) => (map ? JSON.parse(JSON.stringify(args).split('[phone_1]').join(map['[phone_1]'])) : args),
    };

    const assistant = makeChatAssistant({
        store,
        chatCrypto,
        locks,
        shield,
        llmChat: overrides.llmChat || (async (modelId, msgs, options) => {
            log.llm.push({ modelId, msgs, options });
            return { content: overrides.answer ?? 'Here is my take.', usage: overrides.usage ?? { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } };
        }),
        projectTools: overrides.projectTools || { offered: async () => [], forAnswer: () => ({ execute: async () => '{}', created: [] }) },
        runToolLoop: overrides.runToolLoop,
        resolveModel: overrides.resolveModel || (async () => ({ modelId: 'model-fast', options: { maxTokens: 1000 }, providerConfig: { providerType: 'anthropic' } })),
        resolvePersona: async (args) => { log.persona.push(args); return overrides.persona ?? null; },
        searchKnowledge: async (args) => { log.knowledge.push(args); return overrides.knowledge ?? ''; },
        listAudience: async (project) => { log.audience.push(project.id); return overrides.audience ?? ['ann', 'bob', 'cy']; },
        recordReply: async (d) => { log.replies.push(d); },
        getUser: async (id) => USERS[id] || null,
        checkLimits: overrides.checkLimits || (async () => null),
        emit: async (projectId, ev) => { log.durable.push({ projectId, ...ev }); },
        publishTransient: async (projectId, ev) => { log.transient.push({ projectId, ...ev }); },
        logUsage: async (entry) => { log.usage.push(entry); },
        timeoutMs: overrides.timeoutMs ?? 5000,
        lockPollMs: 5,
        ...(overrides.lockWaitMs ? { lockWaitMs: overrides.lockWaitMs } : {}),
        newId: (() => { let i = 0; return () => `id-${++i}`; })(),
    });
    return { assistant, chatCrypto, log, messages, chat, seed, releaseLock: () => { lockHeld = false; } };
}

async function ask(w, triggerText = '@ai what is the plan?', extra = {}) {
    const box = await w.chatCrypto.forProject(PROJECT);
    await w.seed(box, [['bob', 'We ship on Monday.'], ['ann', 'Call me on 0612345678 if it slips.'], ['ann', triggerText]]);
    const trigger = w.messages.at(-1);
    return w.assistant.requestReply({
        project: PROJECT, chat: w.chat, trigger, triggerText, userId: 'ann', orgId: 'org1', limitOrgId: 'org1', session: { id: 's' }, ...extra,
    });
}

test('a subscription limit or a missing model means no answer, and no turn is claimed', async () => {
    const limited = world({ checkLimits: async () => 'Monthly message limit reached' });
    assert.deepStrictEqual(await ask(limited), { status: 'skipped', reason: 'limit' });
    assert.strictEqual(limited.log.acquired.length, 0);

    const noModel = world({ resolveModel: async () => null });
    assert.deepStrictEqual(await ask(noModel), { status: 'skipped', reason: 'no_model' });
    assert.strictEqual(noModel.log.acquired.length, 0);
    assert.deepStrictEqual(noModel.log.transient, []);
});

test('an automatic answer that finds the turn held yields: busy, nothing called, no lock of ours released', async () => {
    const w = world({ lockHeld: true });
    assert.deepStrictEqual(await askAuto(w), { status: 'busy' });
    assert.strictEqual(w.log.llm.length, 0);
    assert.deepStrictEqual(w.log.transient, []);
    assert.strictEqual(w.log.released.length, 0, 'a lock we did not take is not ours to release');
});

test('an explicit ask that finds the turn held waits for it and is then answered, not lost', async () => {
    const w = world({ lockHeld: true });
    const reply = await ask(w);
    assert.strictEqual(reply.status, 'queued');
    assert.deepStrictEqual(w.log.transient, [], 'nothing is running yet');
    assert.strictEqual(w.log.llm.length, 0);
    setTimeout(() => w.releaseLock(), 30);
    assert.deepStrictEqual(await reply.done, { status: 'answered', messageId: 'id-2' });
    assert.ok(w.log.acquired.length > 1, 'it polled for the turn');
    assert.deepStrictEqual(w.log.transient.map((e) => e.status), ['running', 'answered']);
    assert.strictEqual(w.log.released.length, 1);
});

test('an explicit ask gives up with busy when the turn never frees within the wait bound', async () => {
    const w = world({ lockHeld: true, lockWaitMs: 40 });
    const reply = await ask(w);
    assert.strictEqual(reply.status, 'queued');
    assert.deepStrictEqual(await reply.done, { status: 'busy' });
    assert.strictEqual(w.log.llm.length, 0);
    assert.strictEqual(w.log.released.length, 0, 'a lock we never took is not released');
    assert.deepStrictEqual(w.log.transient, []);
});

test('the lock of an explicit answer outlasts the tool loop, an automatic one only the model call', async () => {
    const explicit = world({});
    await (await ask(explicit)).done;
    assert.strictEqual(explicit.log.acquired[0].ttlMs, 5000 * 3 + 30000);
    const auto = world({});
    await (await askAuto(auto, { gateLastSeq: 99 })).done;
    assert.strictEqual(auto.log.acquired[0].ttlMs, 5000 + 30000);
});

test('a queued answer: context, persona, knowledge, sealed answer, usage, events, lock released', async () => {
    const w = world({
        agentId: 'agent-1',
        persona: { agentId: 'agent-1', name: 'Planner', systemPrompt: 'You plan launches.' },
        knowledge: '### Source 1: launch.md\nLaunch is on Monday.',
    });
    const reply = await ask(w);
    assert.strictEqual(reply.status, 'queued');
    assert.deepStrictEqual(await reply.done, { status: 'answered', messageId: 'id-2' });

    assert.deepStrictEqual(w.log.acquired[0], {
        conversationId: 'c1', conversationType: 'project_chat', projectId: 'p1', userId: 'ann', runId: 'pc::id-1', ttlMs: 45000,
    });
    assert.deepStrictEqual(w.log.persona, [{ agentId: 'agent-1', userId: 'ann' }]);
    assert.deepStrictEqual(w.log.knowledge.map((k) => [k.project.id, k.userId, k.query, k.shield.marker, k.audienceIds]),
        [['p1', 'ann', '@ai what is the plan?', 'shield', ['ann', 'bob', 'cy']]],
        'an asked-for answer is read by the whole chat: knowledge is cut to what every member may read');
    assert.deepStrictEqual(w.log.shieldFor, { orgId: 'org1', userId: 'ann' });

    const [{ modelId, msgs, options }] = w.log.llm;
    assert.strictEqual(modelId, 'model-fast');
    assert.deepStrictEqual(options, { maxTokens: 1000, timeoutMs: 5000 });
    const [system, user] = msgs;
    assert.strictEqual(system.role, 'system');
    assert.match(system.content, /"Planner"/);
    assert.match(system.content, /You plan launches\./);
    assert.match(system.content, /project "Launch"/);
    assert.match(system.content, /Always answer in British English\./);
    assert.match(system.content, /Launch is on Monday\./);
    assert.strictEqual(user.role, 'user');
    assert.match(user.content, /\[A project member\]: We ship on Monday\./, 'no e-mail address as a name');
    assert.match(user.content, /\[Ann\]: @ai what is the plan\?/);
    assert.match(user.content, /latest message from Ann/);
    assert.ok(!user.content.includes('bob@example.test') && !system.content.includes('ann@example.test'));
    assert.strictEqual(w.log.protect[0].text, user.content, 'what went out is what the shield saw');

    const saved = w.log.appended[0];
    assert.strictEqual(saved.authorKind, 'assistant');
    assert.strictEqual(saved.agentId, 'agent-1');
    assert.strictEqual(saved.replyTo, 'm3');
    assert.ok(!saved.content.includes('Here is my take'), 'the answer is stored sealed');
    const box = await w.chatCrypto.forProject(PROJECT);
    assert.strictEqual(box.openContent('c1', saved.id, saved.content), 'Here is my take.');

    assert.strictEqual(w.log.usage[0].source, 'project_chat');
    assert.strictEqual(w.log.usage[0].model, 'model-fast');
    assert.strictEqual(w.log.usage[0].total_tokens, 150);
    assert.strictEqual(w.log.usage[0].conversation_id, 'c1');

    assert.deepStrictEqual(w.log.transient.map((e) => [e.kind, e.chatId, e.status]), [
        ['chat.ai.started', 'c1', 'running'],
        ['chat.ai.finished', 'c1', 'answered'],
    ]);
    assert.deepStrictEqual(w.log.durable, [{
        projectId: 'p1', kind: 'chat.message.created', actorId: 'ann', targetType: 'project_chat', targetId: 'c1',
        payload: { chatId: 'c1', messageId: saved.id, seq: 4, authorKind: 'assistant' },
    }]);
    assert.ok(!JSON.stringify([w.log.transient, w.log.durable]).includes('Here is my take'));
    assert.deepStrictEqual(w.log.released, [{ conversationId: 'c1', runId: 'pc::id-1' }]);
    assert.deepStrictEqual(w.log.cleared, ['project-chat-c1-pc::id-1']);
    assert.strictEqual(saved.aiTrigger, 'ask', 'why the AI spoke is stored');
    assert.strictEqual(saved.aiReason, null);
    assert.strictEqual(saved.unlessHumanAfterSeq, null, 'an asked-for answer is never stale');
    assert.deepStrictEqual(w.log.replies, [{
        projectId: 'p1', orgId: 'org1', surface: 'chat', containerId: 'c1', triggerMessageId: 'm3',
        triggerKind: 'explicit', decision: 'replied', replyMessageId: saved.id,
    }], 'an explicit answer restarts the automatic cooldown');
    assert.deepStrictEqual(w.log.audience, ['p1'], 'an asked-for answer lists the audience too: everyone reads it');
});

test('without a persona the prompt is the plain assistant', async () => {
    const w = world();
    const reply = await ask(w, 'thoughts?');
    await reply.done;
    const system = w.log.llm[0].msgs[0].content;
    assert.match(system, /You are the AI assistant taking part in a team chat\./);
    assert.doesNotMatch(system, /AGENT ROLE/);
    assert.doesNotMatch(system, /PROJECT KNOWLEDGE BASE/);
    assert.strictEqual(w.log.persona.length, 0, 'no agent on the chat, no persona lookup');
});

test('Privacy Shield tokens go out tokenised and are restored in the stored answer', async () => {
    const w = world({ tokenise: true, answer: 'I will call [phone_1] on Monday.' });
    const reply = await ask(w);
    await reply.done;
    const [system, user] = w.log.llm[0].msgs;
    assert.ok(!user.content.includes('0612345678'), 'the number did not leave');
    assert.match(user.content, /\[phone_1\]/);
    assert.match(system.content, /\[TOKENS\]/);
    const saved = w.log.appended[0];
    const box = await w.chatCrypto.forProject(PROJECT);
    assert.strictEqual(box.openContent('c1', saved.id, saved.content), 'I will call 0612345678 on Monday.');
});

test('a Privacy Shield block: no model call, status blocked, lock released', async () => {
    const w = world({ privacyBlock: true });
    const reply = await ask(w);
    assert.deepStrictEqual(await reply.done, { status: 'blocked' });
    assert.strictEqual(w.log.llm.length, 0);
    assert.strictEqual(w.log.appended.length, 0);
    assert.deepStrictEqual(w.log.transient.at(-1), { projectId: 'p1', kind: 'chat.ai.finished', actorId: 'ann', chatId: 'c1', status: 'blocked', payload: { chatId: 'c1', status: 'blocked' } });
    assert.strictEqual(w.log.released.length, 1);
});

test('a failing model: status failed, no raw error text anywhere in the feed, lock released', async () => {
    const secret = 'upstream 500: prompt contained "Call me on 0612345678"';
    const w = world({ llmChat: async () => { throw new Error(secret); } });
    const reply = await ask(w);
    assert.deepStrictEqual(await reply.done, { status: 'failed' });
    assert.strictEqual(w.log.appended.length, 0);
    const feed = JSON.stringify([w.log.transient, w.log.durable]);
    assert.ok(!feed.includes('upstream') && !feed.includes('0612345678'));
    assert.deepStrictEqual(w.log.transient.map((e) => e.status), ['running', 'failed']);
    assert.deepStrictEqual(w.log.released, [{ conversationId: 'c1', runId: 'pc::id-1' }]);

    // The turn is free again: the next question is not busy.
    const again = await w.assistant.requestReply({ project: PROJECT, chat: w.chat, trigger: w.messages.at(-1), triggerText: 'retry', userId: 'ann', orgId: 'org1' });
    assert.strictEqual(again.status, 'queued');
    await again.done;
});

test('a model that never answers times out, fails and frees the turn', async () => {
    const w = world({ timeoutMs: 50, llmChat: () => new Promise(() => {}) });
    const reply = await ask(w);
    assert.deepStrictEqual(await reply.done, { status: 'failed' });
    assert.strictEqual(w.log.released.length, 1);
});

test('an empty answer or a chat deleted meanwhile is a failure, not an empty message', async () => {
    const empty = world({ answer: '   ' });
    assert.deepStrictEqual(await (await ask(empty)).done, { status: 'failed' });
    assert.strictEqual(empty.log.appended.length, 0);
    assert.deepStrictEqual(empty.log.durable, []);

    const gone = world({ chatGone: true });
    assert.deepStrictEqual(await (await ask(gone)).done, { status: 'failed' });
    assert.deepStrictEqual(gone.log.durable, []);
    assert.strictEqual(gone.log.released.length, 1);
});

// ── Automatic answers ────────────────────────────────────────────────────

async function askAuto(w, extra = {}) {
    const box = await w.chatCrypto.forProject(PROJECT);
    await w.seed(box, [['bob', 'We ship on Monday.'], ['ann', 'Does anyone know the refund policy for annual plans?']]);
    const trigger = w.messages.at(-1);
    return w.assistant.requestReply({
        project: PROJECT, chat: w.chat, trigger, triggerText: 'Does anyone know the refund policy for annual plans?',
        userId: 'ann', orgId: 'org1', limitOrgId: 'org1', session: null,
        aiTrigger: 'auto_quiet', reasonCode: 'open_question_answerable', gateLastSeq: trigger.seq, ...extra,
    });
}

test('an automatic answer: short prompt with the reason, stored with its trigger, silent on the feed', async () => {
    const w = world({ answer: 'Annual plans are refundable within 30 days.', audience: ['ann', 'bob'] });
    const reply = await askAuto(w);
    assert.strictEqual(reply.status, 'queued');
    assert.deepStrictEqual(await reply.done, { status: 'answered', messageId: 'id-2' });

    const [{ msgs, options }] = w.log.llm;
    assert.match(msgs[0].content, /Nobody asked you: you joined on your own because someone asked the group a question you can likely answer\./);
    assert.match(msgs[0].content, /at most about 120 words/);
    assert.match(msgs[0].content, /output exactly \[\[SKIP\]\]/);
    assert.match(msgs[1].content, /Nobody asked you directly/);
    assert.ok(options.maxTokens <= 700, 'a short answer has a small budget');

    const saved = w.log.appended[0];
    assert.strictEqual(saved.aiTrigger, 'auto_quiet');
    assert.strictEqual(saved.aiReason, 'open_question_answerable');
    assert.strictEqual(saved.unlessHumanAfterSeq, 2, 'the stale check goes to the store, under the chat lock');
    assert.strictEqual(w.log.usage[0].source, 'project_chat_auto');
    assert.deepStrictEqual(w.log.transient, [], 'no chat.ai.* events for an answer nobody asked for');
    assert.deepStrictEqual(w.log.durable.map((e) => e.kind), ['chat.message.created'], 'the answer itself appears');
    assert.deepStrictEqual(w.log.replies, [], 'the engine logs its own decision');
    assert.deepStrictEqual(w.log.audience, ['p1']);
    assert.deepStrictEqual(w.log.knowledge[0].audienceIds, ['ann', 'bob'], 'knowledge from what every member may read');
    assert.deepStrictEqual(w.log.released, [{ conversationId: 'c1', runId: 'pc::id-1' }]);
});

test('an automatic [[SKIP]] stores nothing and says nothing', async () => {
    for (const answer of ['[[SKIP]]', '  [[SKIP]]\n', '`[[SKIP]]`', '[[SKIP]] nothing to add']) {
        const w = world({ answer });
        const reply = await askAuto(w);
        assert.deepStrictEqual(await reply.done, { status: 'skipped', reason: 'skip_sentinel' }, answer);
        assert.strictEqual(w.log.appended.length, 0);
        assert.deepStrictEqual(w.log.durable, []);
        assert.deepStrictEqual(w.log.transient, []);
        assert.strictEqual(w.log.released.length, 1);
    }
    // An asked-for answer is never dropped for the sentinel: it is not in that prompt.
    const asked = world({ answer: '[[SKIP]]' });
    assert.deepStrictEqual(await (await ask(asked)).done, { status: 'answered', messageId: 'id-2' });
});

test('a stale automatic answer is dropped: a member spoke after what the gate read', async () => {
    const w = world({ answer: 'Annual plans are refundable within 30 days.' });
    const reply = await askAuto(w, { gateLastSeq: 1 });
    // m2 (seq 2) is a human message after seq 1.
    assert.deepStrictEqual(await reply.done, { status: 'stale' });
    assert.strictEqual(w.log.appended.length, 1, 'the store was asked, and said stale');
    assert.deepStrictEqual(w.log.durable, []);
    assert.deepStrictEqual(w.log.transient, []);
});

test('an automatic answer that fails, or is blocked, is silent', async () => {
    const failing = world({ llmChat: async () => { throw new Error('upstream 500'); } });
    assert.deepStrictEqual(await (await askAuto(failing)).done, { status: 'failed' });
    const blocked = world({ privacyBlock: true });
    assert.deepStrictEqual(await (await askAuto(blocked)).done, { status: 'blocked' });
    for (const w of [failing, blocked]) {
        assert.deepStrictEqual(w.log.transient, [], 'no chat.ai.finished {failed|blocked} for an automatic answer');
        assert.deepStrictEqual(w.log.durable, []);
        assert.strictEqual(w.log.released.length, 1);
    }
    const unknownKind = world();
    const r = await unknownKind.assistant.requestReply({
        project: PROJECT, chat: unknownKind.chat, trigger: { id: 'x' }, triggerText: 'hi', userId: 'ann', aiTrigger: 'because',
    });
    await r.done;
    assert.strictEqual(unknownKind.log.appended[0].aiTrigger, 'ask', 'an unknown trigger is an ordinary ask');
});

test('knowledge for an automatic answer: only the bases every member may read', async () => {
    const seen = [];
    const deps = {
        visibleKbIdsFor: async (ids, { userId }) => {
            seen.push(userId);
            if (userId === 'bob') return ids.filter((id) => id !== 'kb-finance');
            if (userId === 'cy') return ids.filter((id) => id !== 'kb-hr');
            return ids;
        },
        quickKBSearch: async (userId, kbIds) => { seen.push(['search', kbIds]); return [{ content: 'x', title: 't' }]; },
        injectedPassagesPrompt: async () => 'passages',
    };
    const project = { id: 'p1', knowledgeBaseIds: ['kb-open', 'kb-finance', 'kb-hr'] };
    const text = await searchProjectKnowledge({ project, userId: 'ann', query: 'q', audienceIds: ['ann', 'bob', 'cy'] }, deps);
    assert.strictEqual(text, 'passages');
    assert.deepStrictEqual(seen.at(-1), ['search', ['kb-open']], 'the intersection over all members');
    seen.length = 0;
    assert.strictEqual(await searchProjectKnowledge({ project, userId: 'ann', query: 'q', audienceIds: null }, deps), '',
        'an unknown audience keeps no linked base');
    assert.ok(!seen.some((x) => Array.isArray(x)), 'nothing searched');
});

test('the audience: owner, members, and the members of shared groups, or unknown', async () => {
    const shares = [
        { sharedWithType: 'user', sharedWithId: 'bob' },
        { sharedWithType: 'group', sharedWithId: 'g-sales' },
    ];
    const audience = await listProjectAudience({ id: 'p1', ownerId: 'olga' }, {
        getProjectShares: async () => shares,
        groupMemberIds: async () => ({ ids: ['cy', 'bob'], total: 2 }),
    });
    assert.deepStrictEqual(audience.sort(), ['bob', 'cy', 'olga']);
    const huge = await listProjectAudience({ id: 'p1', ownerId: 'olga' }, {
        getProjectShares: async () => shares,
        groupMemberIds: async () => ({ ids: [], total: 5000 }),
    });
    assert.strictEqual(huge, null, 'too many people to check: unknown');
    const broken = await listProjectAudience({ id: 'p1', ownerId: 'olga' }, { getProjectShares: async () => { throw new Error('db'); } });
    assert.strictEqual(broken, null);
});

// ── The default collaborators, with their own seams ─────────────────────

const { resolveUsableAgent, resolveChatModel } = require('./chatAssistant');

test('the persona is only for a member who may use the agent', async () => {
    const AGENTS = {
        mine: { id: 'mine', name: 'Draft Bot', owner_id: 'ann', is_published: false, organization_id: 'org1', shared_groups: [], system_prompt: 'Draft things.', config: {} },
        shared: { id: 'shared', name: ' Sales Coach ', owner_id: 'olga', is_published: true, published_version: 3, organization_id: 'org1', shared_groups: [], system_prompt: 'Coach sales.', config: {} },
        grouped: { id: 'grouped', name: 'Finance', owner_id: 'olga', is_published: true, published_version: 1, organization_id: 'org1', shared_groups: ['g-fin'], system_prompt: 'x', config: {} },
        draft: { id: 'draft', name: 'Never published', owner_id: 'olga', is_published: true, published_version: 0, organization_id: 'org1', shared_groups: [], system_prompt: 'x', config: {} },
        foreign: { id: 'foreign', name: 'Other org', owner_id: 'zed', is_published: true, published_version: 1, organization_id: 'org2', shared_groups: [], system_prompt: 'x', config: {} },
    };
    const deps = (identity = {}) => ({
        agentStore: { getForRuntime: async (id) => (AGENTS[id] ? { ...AGENTS[id] } : null) },
        getUser: async (id) => {
            if (identity.fail) throw new Error('users table unreachable');
            return { id, organizationId: 'org1' };
        },
        resolveUserGroups: async () => identity.groups || [],
    });
    assert.deepStrictEqual(await resolveUsableAgent({ agentId: 'mine', userId: 'ann' }, deps()), { agentId: 'mine', name: 'Draft Bot', systemPrompt: 'Draft things.' });
    assert.strictEqual(await resolveUsableAgent({ agentId: 'mine', userId: 'bob' }, deps()), null, 'an unpublished agent is its owner\'s only');
    assert.deepStrictEqual(await resolveUsableAgent({ agentId: 'shared', userId: 'bob' }, deps()), { agentId: 'shared', name: 'Sales Coach', systemPrompt: 'Coach sales.' });
    assert.strictEqual(await resolveUsableAgent({ agentId: 'grouped', userId: 'bob' }, deps()), null, 'shared with a group bob is not in');
    assert.ok(await resolveUsableAgent({ agentId: 'grouped', userId: 'bob' }, deps({ groups: ['g-fin'] })));
    assert.strictEqual(await resolveUsableAgent({ agentId: 'draft', userId: 'bob' }, deps()), null, 'shared but never published');
    assert.strictEqual(await resolveUsableAgent({ agentId: 'foreign', userId: 'bob' }, deps()), null, 'another organisation');
    assert.strictEqual(await resolveUsableAgent({ agentId: 'shared', userId: 'bob' }, deps({ fail: true })), null, 'an unreadable identity is not a yes');
    assert.ok(await resolveUsableAgent({ agentId: 'mine', userId: 'ann' }, deps({ fail: true })), 'the owner needs no identity lookup');
    assert.strictEqual(await resolveUsableAgent({ agentId: 'gone', userId: 'ann' }, deps()), null);
    assert.strictEqual(await resolveUsableAgent({ agentId: '', userId: 'ann' }, deps()), null);
});

test('the model is the asking member\'s fast tier, or nothing', async () => {
    const asked = [];
    const resolver = {
        resolveModelForTierName: async (tier, opts) => { asked.push([tier, opts]); return opts.userOrgId === 'org-none' ? null : 'model-fast'; },
        getTierConfig: async () => ({ maxTokens: 2048, temperature: 0.3 }),
    };
    const model = await resolveChatModel({ userId: 'ann', orgId: 'org1' }, {
        resolver, getProviderForModel: async () => ({ providerType: 'anthropic', url: 'https://api.example.test', providerName: 'Claude' }),
    });
    assert.deepStrictEqual(asked[0], ['fast', { userOrgId: 'org1', userId: 'ann' }]);
    assert.deepStrictEqual(model, {
        modelId: 'model-fast',
        options: { maxTokens: 2048, temperature: 0.3 },
        providerConfig: { providerType: 'anthropic', url: 'https://api.example.test', displayName: 'Claude' },
        tier: 'fast',
        requestedTier: 'fast',
    });
    assert.strictEqual(await resolveChatModel({ userId: 'ann', orgId: 'org-none' }, { resolver }), null);
    const unknownProvider = await resolveChatModel({ userId: 'ann', orgId: 'org1' }, { resolver, getProviderForModel: async () => { throw new Error('no provider'); } });
    assert.deepStrictEqual(unknownProvider.providerConfig, {});
});

test('knowledge: only the bases the asking member may read, stripped by their shield', async () => {
    const calls = {};
    const deps = {
        visibleKbIdsFor: async (ids, opts) => { calls.visible = [ids, opts]; return ids.filter((id) => id !== 'kb-secret'); },
        quickKBSearch: async (userId, kbIds, query, opts) => { calls.search = [userId, kbIds, query, opts]; return [{ content: 'Launch is Monday.', title: 'plan.md' }]; },
        injectedPassagesPrompt: async (chunks, opts) => { calls.strip = [chunks, opts]; return '### Source 1: plan.md\nLaunch is Monday.'; },
    };
    const project = { id: 'p1', knowledgeBaseIds: ['kb-open', 'kb-secret'] };
    const text = await searchProjectKnowledge({ project, userId: 'ann', query: 'when?', session: { id: 's' }, shield: { enabled: true } }, deps);
    assert.strictEqual(text, '### Source 1: plan.md\nLaunch is Monday.');
    assert.deepStrictEqual(calls.visible, [['kb-open', 'kb-secret'], { userId: 'ann', context: 'project_kb' }]);
    assert.deepStrictEqual(calls.search, ['ann', ['kb-open'], 'when?', { topK: 6, session: { id: 's' } }]);
    assert.deepStrictEqual(calls.strip[1], { shield: { enabled: true }, tag: 'ProjectChat' });

    const none = { visibleKbIdsFor: async () => [], quickKBSearch: async () => { throw new Error('must not search'); } };
    assert.strictEqual(await searchProjectKnowledge({ project, userId: 'bob', query: 'when?' }, none), '');
    assert.strictEqual(await searchProjectKnowledge({ project: { id: 'p1', knowledgeBaseIds: [] }, userId: 'ann', query: 'x' }, none), '');
});

test('knowledge: the project\'s own files base is searched for every member, even with no linked base', async () => {
    const calls = {};
    const filesKb = { id: 'kb-files', source_kind: 'project_files', organization_id: 'org1' };
    const deps = {
        // The ordinary filter would hide the unpublished files base from anyone
        // but its owner; it is never asked about it.
        visibleKbIdsFor: async (ids) => { calls.visible = ids; return []; },
        quickKBSearch: async (userId, kbIds) => { calls.search = kbIds; return [{ content: 'Budget is 10k.', title: 'budget.xlsx' }]; },
        injectedPassagesPrompt: async () => '### Source 1: budget.xlsx\nBudget is 10k.',
        kbStore: { getKB: async (id) => (id === 'kb-files' ? filesKb : null) },
    };
    const project = { id: 'p1', organizationId: 'org1', filesKbId: 'kb-files', knowledgeBaseIds: [] };
    const text = await searchProjectKnowledge({ project, userId: 'bob', query: 'budget?' }, deps);
    assert.strictEqual(text, '### Source 1: budget.xlsx\nBudget is 10k.');
    assert.deepStrictEqual(calls.search, ['kb-files']);
    assert.strictEqual(calls.visible, undefined, 'no linked base, nothing for the per-member filter');

    // A base the project merely NAMES as its files, but that is not a project
    // files base, is never searched on that say-so.
    calls.search = undefined;
    const forged = { ...deps, kbStore: { getKB: async () => ({ id: 'kb-files', source_kind: 'manual', organization_id: 'org1' }) } };
    assert.strictEqual(await searchProjectKnowledge({ project, userId: 'bob', query: 'budget?' }, forged), '');
    assert.strictEqual(calls.search, undefined);
});

test('listChatAgents: only agents every member may use, never a system agent', async () => {
    const users = { ann: { organizationId: 'o1' }, bob: { organizationId: 'o1' } };
    const groups = { ann: ['g1'], bob: [] };
    const pub = (id, extra = {}) => ({ id, name: id, owner_id: 'ann', is_published: true, published_version: 1, organization_id: 'o1', shared_groups: [], ...extra });
    const agentStore = {
        getAgents: async () => [pub('org-wide'), pub('draft', { is_published: false, published_version: 0 }),
            pub('for-g1', { shared_groups: ['g1'] }), pub('sys', { owner_id: 'system' })],
        getPublishedAgentsForUser: async () => [pub('org-wide'), pub('for-g1', { shared_groups: ['g1'] })],
    };
    const list = await listChatAgents({ id: 'p1', ownerId: 'ann' }, { userId: 'ann' }, {
        agentStore, getUser: async (id) => users[id], resolveUserGroups: async (id) => groups[id],
        listAudience: async () => ['ann', 'bob'],
    });
    assert.deepEqual(list.map((a) => a.id), ['org-wide']);
});

test('a picked tier answers on that tier; a tier without a model, or one that is not a depth, falls back to fast', async () => {
    const asked = [];
    const resolver = {
        resolveModelForTierName: async (name) => { asked.push(name); return name === 'pro' || name === 'fast' ? `model-${name}` : null; },
        getTierConfig: async () => ({}),
    };
    const deps = { resolver, getProviderForModel: async () => ({}) };
    assert.equal((await resolveChatModel({ userId: 'ann', orgId: null, modelTier: 'pro' }, deps)).tier, 'pro');
    assert.equal((await resolveChatModel({ userId: 'ann', orgId: null, modelTier: 'thinking' }, deps)).tier, 'fast');
    // Flow, swarm and custom tiers are kinds of work, not depths of an answer.
    assert.equal((await resolveChatModel({ userId: 'ann', orgId: null, modelTier: 'swarm' }, deps)).tier, 'fast');
    assert.ok(!asked.includes('swarm'));
});

test('auto lets the classifier choose among the depth tiers only', async () => {
    const seen = [];
    const resolver = { resolveModelForTierName: async (n) => `model-${n}`, getTierConfig: async () => ({}), getUserTierMap: async () => ({ fast: {}, pro: {}, swarm: {}, 'custom:x': {} }) };
    const out = await resolveChatModel({ userId: 'ann', orgId: null, modelTier: 'auto', message: 'hard question' }, {
        resolver,
        getProviderForModel: async () => ({}),
        classifyWithLLM: async (message, tiers) => { seen.push(Object.keys(tiers)); return { tier: 'pro' }; },
    });
    assert.deepStrictEqual(seen[0], ['fast', 'pro']);
    assert.equal(out.tier, 'pro');
    assert.equal(out.requestedTier, 'auto');
});

// ── What the AI may do ───────────────────────────────────────────────────

function toolsWorld(extra = {}) {
    const calls = [];
    const made = [];
    const definitions = [{ type: 'function', function: { name: 'create_document' } }];
    const projectTools = {
        offered: async (args) => { calls.push(['offered', args.userId, args.project.id]); return extra.definitions ?? definitions; },
        forAnswer: () => ({
            created: made,
            execute: async (name, a) => {
                calls.push(['execute', name, a]);
                made.push({ kind: 'document', id: 'doc-1', name: a.name });
                return JSON.stringify({ ok: true, id: 'doc-1' });
            },
        }),
    };
    const loops = [];
    const runToolLoop = async (modelId, messages, tools, options, executeTool, maxRounds) => {
        loops.push({ modelId, messages, tools, options, maxRounds });
        if (extra.script) return extra.script(executeTool);
        await executeTool('create_document', { name: 'Plan', content: 'Call 0612345678' });
        return { content: extra.finalText ?? 'I made the document "Plan".', usage: { prompt_tokens: 300, completion_tokens: 80, total_tokens: 380 }, toolCallRounds: 1 };
    };
    return { calls, made, loops, w: world({ projectTools, runToolLoop, ...extra.world }) };
}

test('an explicit ask can make things: tools offered, prompt says so, the item is linked to the answer, usage is the whole loop', async () => {
    const { w, calls, loops } = toolsWorld();
    const reply = await ask(w, '@ai make a document with the plan');
    assert.deepStrictEqual(await reply.done, { status: 'answered', messageId: 'id-2' });
    assert.deepStrictEqual(calls[0], ['offered', 'ann', 'p1']);
    assert.strictEqual(loops.length, 1);
    assert.strictEqual(w.log.llm.length, 0, 'the plain call is not made as well');
    assert.deepStrictEqual(loops[0].tools.map((t) => t.function.name), ['create_document']);
    assert.match(loops[0].messages[0].content, /create documents and notebooks in this project/);
    assert.match(loops[0].messages[0].content, /nothing else outside this chat/);
    const stored = w.log.appended.find((m) => m.authorKind === 'assistant');
    assert.deepStrictEqual(stored.refs, [{ kind: 'document', id: 'doc-1' }]);
    assert.strictEqual(w.log.usage[0].total_tokens, 380);
    assert.ok(loops[0].options.maxTokens >= 12000, 'room for a whole styled document in one tool call');
});

test('what the model writes into a tool call has its placeholders put back, and the shield looks at it first', async () => {
    const { w, calls } = toolsWorld({ world: { tokenise: true } });
    const reply = await ask(w, '@ai make a document about 0612345678');
    await reply.done;
    const exec = calls.find((c) => c[0] === 'execute');
    assert.strictEqual(exec[2].content, 'Call 0612345678', 'the real value, not [phone_1]');
    assert.ok(w.log.gates.length === 1, 'the tool gate was built for this answer');
});

test('the shield can refuse a tool call: nothing is made, and the model hears why', async () => {
    let told = null;
    const { w, calls, made } = toolsWorld({
        world: { refuseTool: () => true },
        script: async (executeTool) => { told = await executeTool('create_document', { name: 'X', content: 'y' }); return { content: 'I could not.', usage: {} }; },
    });
    const reply = await ask(w);
    await reply.done;
    assert.match(told, /blocked by shield/);
    assert.ok(!calls.some((c) => c[0] === 'execute'));
    assert.deepStrictEqual(made, []);
    assert.deepStrictEqual(w.log.appended.find((m) => m.authorKind === 'assistant').refs, []);
});

const SEARCH_DEFINITIONS = [{ type: 'function', function: { name: 'agent_search' } }];

test('a search is offered with its own prompt lines, and its query keeps the placeholders', async () => {
    let told = null;
    const { w, calls, loops } = toolsWorld({
        definitions: SEARCH_DEFINITIONS,
        world: { tokenise: true },
        script: async (executeTool) => { told = await executeTool('agent_search', { query: 'who owns 0612345678 [phone_1]' }); return { content: 'Found it.', usage: {} }; },
    });
    const reply = await ask(w, '@ai look up 0612345678');
    await reply.done;
    assert.match(loops[0].messages[0].content, /search the web with agent_search/);
    assert.match(loops[0].messages[0].content, /never put names, e-mail addresses/);
    assert.doesNotMatch(loops[0].messages[0].content, /create documents and notebooks/, 'no document talk when none is offered');
    const exec = calls.find((c) => c[0] === 'execute');
    assert.strictEqual(exec[2].query, 'who owns 0612345678 [phone_1]', 'the query keeps its placeholders: no real value goes to a search provider');
    assert.deepStrictEqual(w.log.searchChecks, ['who owns 0612345678 [phone_1]']);
    assert.ok(told);
});

test('the Web Search Guard can stop a search: it never runs, and the model hears why', async () => {
    let told = null;
    const { w, calls } = toolsWorld({
        definitions: SEARCH_DEFINITIONS,
        world: { blockSearch: true },
        script: async (executeTool) => { told = await executeTool('agent_search', { query: 'jan de vries bsn' }); return { content: 'I could not search.', usage: {} }; },
    });
    const reply = await ask(w);
    await reply.done;
    assert.match(told, /guard says no/);
    assert.ok(!calls.some((c) => c[0] === 'execute'));
});

test('a member who cannot make things gets the plain call, with no tool talk in the prompt', async () => {
    const { w, loops } = toolsWorld({ definitions: [] });
    const reply = await ask(w);
    await reply.done;
    assert.strictEqual(loops.length, 0);
    assert.strictEqual(w.log.llm.length, 1);
    assert.doesNotMatch(w.log.llm[0].msgs[0].content, /create documents and notebooks/);
});

test('an automatic answer is offered no tools at all', async () => {
    const { w, calls, loops } = toolsWorld();
    const reply = await ask(w, 'where do we stand?', { aiTrigger: 'auto_quiet', reasonCode: 'question', gateLastSeq: 3 });
    await reply.done;
    assert.ok(!calls.some((c) => c[0] === 'offered'), 'not even asked');
    assert.strictEqual(loops.length, 0);
});

test('a model that made something and wrote nothing still leaves a line saying what', async () => {
    const { w } = toolsWorld({ finalText: '' });
    const reply = await ask(w);
    assert.deepStrictEqual((await reply.done).status, 'answered');
});

test('a template the AI made is not linked to the answer as a project document', async () => {
    const created = [{ kind: 'template', id: 't1', name: 'T' }, { kind: 'document', id: 'd1', name: 'D' }, { kind: 'notebook', id: 'n1', name: 'N' }];
    const projectTools = {
        offered: async () => [{ type: 'function', function: { name: 'create_document' } }],
        forAnswer: () => ({ created, execute: async () => '{}' }),
    };
    const w = world({ projectTools, runToolLoop: async () => ({ content: 'Made.', usage: {} }) });
    const reply = await ask(w, '@ai make things');
    await reply.done;
    const stored = w.log.appended.find((m) => m.authorKind === 'assistant');
    assert.deepStrictEqual(stored.refs, [{ kind: 'document', id: 'd1' }, { kind: 'notebook', id: 'n1' }], 'only what is in the project becomes a chip');
});

test('a tool call that comes after the answer was given up on makes nothing', async () => {
    let late = null;
    const { w, calls, made } = toolsWorld({
        world: { timeoutMs: 10 },
        script: async (executeTool) => {
            await new Promise((resolve) => setTimeout(resolve, 80));
            late = JSON.parse(await executeTool('create_document', { name: 'Too late', content: 'x' }));
            return { content: 'Done.', usage: {} };
        },
    });
    const reply = await ask(w, '@ai make a document');
    assert.deepStrictEqual(await reply.done, { status: 'failed' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.strictEqual(late.ok, false);
    assert.ok(!calls.some((c) => c[0] === 'execute'), 'the tool never ran');
    assert.deepStrictEqual(made, []);
});

// ── Threads ──────────────────────────────────────────────────────────────

test('a thread answer loads its own conversation by root, so an old thread keeps its root', async () => {
    const w = world({});
    const box = await w.chatCrypto.forProject(PROJECT);
    await w.seed(box, [['bob', 'Root of the old thread'], ['ann', 'A reply in the thread']]);
    w.messages[0].threadId = null;
    w.messages[1].threadId = 'm1';
    for (let i = 0; i < 40; i++) {
        const id = `n${i}`;
        w.messages.push({ id, chatId: 'c1', seq: 10 + i, authorKind: 'user', authorUserId: 'bob', threadId: null, content: box.sealContent('c1', id, `Newer main message ${i}`), deletedAt: null });
    }
    const trigger = { id: 'm2', threadId: 'm1' };
    const reply = await w.assistant.requestReply({
        project: PROJECT, chat: w.chat, trigger, triggerText: '@ai summarise this thread', userId: 'ann', orgId: 'org1',
    });
    await reply.done;
    assert.deepStrictEqual(w.log.listed.at(-1), { limit: 30, threadId: 'm1' });
    const sent = w.log.llm[0].msgs[1].content;
    assert.match(sent, /Root of the old thread/);
    assert.match(sent, /A reply in the thread/);
    assert.ok(!sent.includes('Newer main message'));
});

test('a main-conversation answer asks the store for the main conversation only', async () => {
    const w = world({});
    await (await ask(w)).done;
    assert.deepStrictEqual(w.log.listed.at(-1), { limit: 30, threadId: null });
});

test('current AI status comes from the shared turn lock and identifies the thread', async () => {
    let turn = { runId: 'pc:thread-1:run', acquiredAt: '2026-10-01T10:00:00Z' };
    const assistant = makeChatAssistant({ locks: { getTurn: async () => turn } });
    assert.deepStrictEqual(await assistant.getStatus('c'), { status: 'running', threadId: 'thread-1', startedAt: turn.acquiredAt });
    turn = null;
    assert.deepStrictEqual(await assistant.getStatus('c'), { status: 'idle', threadId: null });
});


test('Auto answers a direct natural-language address without waiting for participation or cooldown', () => {
    for (const content of ['hoi ai, wat is het weer vandaag', 'Ai kan jij antwoord geven ?', 'AI, can you help?', 'Wat kan je nog meer doen ai?']) {
        assert.deepEqual(decideAiTrigger({ aiMode: 'auto', content }), { trigger: true, kind: 'ask' });
        assert.equal(decideAiTrigger({ aiMode: 'mention', content }).trigger, false);
        assert.equal(decideAiTrigger({ aiMode: 'off', content }).trigger, false);
    }
    for (const content of ['We bespreken AI morgen', 'hoi allemaal', 'AI tooling vergelijken', 'AI kan helpen.', 'Wat weet Bob over AI?']) {
        assert.deepEqual(decideAiTrigger({ aiMode: 'auto', content }), { trigger: false, reason: 'auto_pending' });
    }
});

test('the usage row carries the cache read/write of a Claude or Gemini call, not zeros', async () => {
    for (const [usage, assertEntry] of [[await claudeUsage(), assertClaudeEntry], [await geminiUsage(), assertGeminiEntry]]) {
        const w = world({ usage });
        const reply = await ask(w);
        await reply.done;
        assert.strictEqual(w.log.usage.length, 1);
        assertEntry(w.log.usage[0]);
    }
});
