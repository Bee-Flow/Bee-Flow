/**
 * projects/comments/commentAssistant.js — the AI answering in a comment
 * thread, with the real store over PGlite and the real sealing, and every
 * outside call (model, shield, knowledge, item text, lock, feed) a fake.
 *
 * Proven:
 *   - the rule: off never, resolved never, askAi and @ai/@assistant answer,
 *     a plain comment waits for the engine in auto and is ignored in mention;
 *   - what the model sees: the anchored passage and its section, the thread
 *     under display names, the project's knowledge — all of it through the
 *     Privacy Shield, and the prompt says it cannot edit or resolve;
 *   - the answer is sealed, replies to the question, carries its trigger, and
 *     is announced with ids only; usage is logged as project_comment, and the
 *     answer as a `replied` decision, so it starts the automatic cooldown;
 *   - refusals: limits, no model, a busy thread, a shield block, a model
 *     failure, a thread resolved meanwhile — each without a stored answer
 *     where there should be none, and always releasing the lock;
 *   - it never changes the thread's status and never touches the item.
 *
 * Run: cd server && node --test projects/comments/commentAssistant.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeProjectCommentStore, DDL } = require('../../stores/projectCommentStore');
const participationStoreModule = require('../../stores/projectAiParticipationStore');
const { makeCommentCrypto } = require('./commentCrypto');
const { makeCommentAssistant, decideCommentAi, describePassage } = require('./commentAssistant');

const { pg, db } = pgliteDb();
const store = makeProjectCommentStore(db);
const participationStore = participationStoreModule.makeProjectAiParticipationStore(db);
const KEY = crypto.randomBytes(32);
const commentCrypto = makeCommentCrypto({ getProjectKey: async () => KEY });
const PROJECT = { id: 'p1', name: 'Launch', organizationId: 'org1', customInstructions: 'Answer in plain words.' };
const NOTEBOOK_MD = '# Plan\n\n## Budget\nWe agreed **the budget** is 40k for Q3, says Anna.\n\n## Timeline\nJune.';

let log;
let lockHeld;
let modelAnswer;
let shieldMode;
let limitText;
let model;
let item;

const USERS = { ann: { displayName: 'Anna Berg', email: 'anna@example.test' }, bob: { username: 'bob@example.test' } };

function assistant(overrides = {}) {
    return makeCommentAssistant({
        store,
        commentCrypto,
        locks: {
            acquireTurn: async (args) => { log.push(['lock', args]); if (lockHeld) return { acquired: false }; lockHeld = true; return { acquired: true }; },
            releaseTurn: async (args) => { log.push(['release', args]); lockHeld = false; },
        },
        shield: {
            resolve: async (args) => { log.push(['shield.resolve', args]); return { enabled: true }; },
            protect: async (args) => {
                log.push(['shield.protect', args]);
                if (shieldMode === 'block') throw Object.assign(new Error('blocked'), { code: 'PRIVACY_BLOCKED' });
                return { text: args.text.replace(/Anna/g, '[PERSON_1]'), tokenMap: { '[PERSON_1]': 'Anna' } };
            },
            tokenAddendum: (map) => (map ? '\n[KEEP TOKENS]' : ''),
            restore: (text, map) => (map ? text.replace(/\[PERSON_1\]/g, map['[PERSON_1]']) : text),
            release: (id) => { log.push(['shield.release', id]); },
        },
        llmChat: async (modelId, messages, options) => {
            log.push(['llm', { modelId, messages, options }]);
            if (modelAnswer instanceof Error) throw modelAnswer;
            return { content: modelAnswer, usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } };
        },
        resolveModel: async (args) => { log.push(['model', args]); return model; },
        searchKnowledge: async (args) => { log.push(['kb', args]); return 'Budget policy: travel is separate.'; },
        itemReader: { read: async (args) => { log.push(['read', args]); return item; } },
        getUser: async (id) => USERS[id] || null,
        displayName: (u) => u?.displayName || (u?.username && !u.username.includes('@') ? u.username : 'A project member'),
        checkLimits: async () => limitText,
        emit: async (projectId, event) => { log.push(['emit', { projectId, ...event }]); },
        publishTransient: async (projectId, event) => { log.push(['transient', { projectId, ...event }]); },
        logUsage: async (entry) => { log.push(['usage', entry]); },
        recordReply: async (decision) => { log.push(['decision', decision]); },
        timeoutMs: 2000,
        ...overrides,
    });
}

const of = (kind) => log.filter(([k]) => k === kind).map(([, v]) => v);

before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, organization_id TEXT)');
    await pg.exec(DDL);
    await pg.exec(participationStoreModule.DDL);
    await pg.query(`INSERT INTO projects (id, name, owner_id) VALUES ('p1', 'p1', 'olga')`);
});
after(async () => { await pg.close(); });
beforeEach(() => {
    log = [];
    lockHeld = false;
    modelAnswer = 'Travel is booked separately, [PERSON_1] can confirm.';
    shieldMode = 'pass';
    limitText = null;
    model = { modelId: 'fast-model', options: { maxTokens: 800 }, providerConfig: { providerType: 'test' } };
    item = { name: 'Research', markdown: NOTEBOOK_MD, sectionMarkdown: '' };
});

let seq = 0;
async function thread({ anchor = { quote: 'the budget is 40k', prefix: 'We agreed ' }, texts = [['bob', 'Does 40k include travel? @ai']] } = {}) {
    const box = await commentCrypto.forProject(PROJECT);
    const threadId = `t-${++seq}`;
    const [firstAuthor, firstText] = texts[0];
    const firstId = `c-${seq}-0`;
    const created = await store.createThread({
        id: threadId, projectId: 'p1', targetType: 'notebook', targetId: 'nb1',
        anchor: box.sealAnchor(threadId, anchor), createdBy: firstAuthor,
        comment: { id: firstId, content: box.sealContent(threadId, firstId, firstText) },
    });
    let last = created.comment;
    let lastText = firstText;
    for (let i = 1; i < texts.length; i++) {
        const id = `c-${seq}-${i}`;
        last = (await store.appendComment('p1', threadId, { id, authorUserId: texts[i][0], content: box.sealContent(threadId, id, texts[i][1]) })).comment;
        lastText = texts[i][1];
    }
    return { box, thread: created.thread, trigger: last, triggerText: lastText };
}

async function ask(t, overrides = {}, askOverrides = {}) {
    const a = assistant(overrides);
    const out = await a.requestReply({
        project: PROJECT, thread: t.thread, trigger: t.trigger, triggerText: t.triggerText, userId: 'bob',
        aiTrigger: 'mention', orgId: 'org1', limitOrgId: 'org1', ...askOverrides,
    });
    const done = out.done ? await out.done : null;
    return { out, done };
}

test('the rule for a person\'s comment', () => {
    assert.deepStrictEqual(decideCommentAi({ aiMode: 'off', content: '@ai hi', askAi: true }), { trigger: false, reason: 'ai_off' });
    assert.deepStrictEqual(decideCommentAi({ aiMode: 'mention', status: 'resolved', content: '@ai hi' }), { trigger: false, reason: 'resolved' });
    assert.deepStrictEqual(decideCommentAi({ aiMode: 'mention', content: 'hi', askAi: true }), { trigger: true, aiTrigger: 'ask' });
    assert.deepStrictEqual(decideCommentAi({ aiMode: 'mention', content: 'hi @AI!' }), { trigger: true, aiTrigger: 'mention' });
    assert.deepStrictEqual(decideCommentAi({ aiMode: 'auto', content: '@assistant check' }), { trigger: true, aiTrigger: 'mention' });
    assert.deepStrictEqual(decideCommentAi({ aiMode: 'mention', content: 'mail me at x@ai.example' }), { trigger: false, reason: 'not_mentioned' });
    assert.deepStrictEqual(decideCommentAi({ aiMode: 'auto', content: 'anyone?' }), { trigger: false, reason: 'auto_pending' });
});

test('an answer: the passage, its section and the thread through the shield, sealed back as a reply', async () => {
    const t = await thread({ texts: [['ann', 'Is travel in the 40k?'], ['bob', 'Does 40k include travel? @ai']] });
    const { out, done } = await ask(t);
    assert.strictEqual(out.status, 'queued');
    assert.deepStrictEqual(done, { status: 'answered' });

    const [read] = of('read');
    assert.deepStrictEqual(read, { projectId: 'p1', targetType: 'notebook', targetId: 'nb1', userId: 'bob', sectionId: null });
    const [protect] = of('shield.protect');
    assert.match(protect.text, /anchored to this passage:\n<passage>\nthe budget is 40k\n<\/passage>/);
    assert.match(protect.text, /section "Budget"/);
    assert.ok(protect.text.includes('We agreed **the budget** is 40k'), 'the section as Markdown');
    assert.ok(!protect.text.includes('Timeline'), 'only the enclosing section');
    assert.match(protect.text, /\[Anna Berg\]: Is travel in the 40k\?/);
    assert.match(protect.text, /\[A project member\]: Does 40k include travel\?/, 'an e-mail-like username is never a name');
    assert.ok(!protect.text.includes('example.test'), 'no e-mail address');
    assert.ok(protect.text.includes('"Research"'), 'the item name travels in the shielded text');
    assert.strictEqual(protect.conversationId.startsWith(`project-comment-${t.thread.id}-`), true);

    const [llm] = of('llm');
    assert.strictEqual(llm.modelId, 'fast-model');
    assert.ok(!llm.messages[1].content.includes('Anna'), 'what leaves is the shielded text');
    const system = llm.messages[0].content;
    assert.match(system, /cannot change the document and you cannot resolve the thread/);
    assert.match(system, /Answer in plain words\./);
    assert.match(system, /travel is separate/);
    assert.match(system, /\[KEEP TOKENS\]/);
    assert.strictEqual(of('kb')[0].userId, 'bob', 'knowledge as the asking member may read it');

    const comments = await store.listComments(t.thread.id);
    const answer = comments.at(-1);
    assert.strictEqual(answer.authorKind, 'assistant');
    assert.strictEqual(answer.authorUserId, null);
    assert.strictEqual(answer.replyTo, t.trigger.id);
    assert.strictEqual(answer.aiTrigger, 'mention');
    assert.ok(!answer.content.includes('Travel'), 'stored sealed');
    assert.strictEqual(t.box.openContent(t.thread.id, answer.id, answer.content), 'Travel is booked separately, Anna can confirm.');

    const emitted = of('emit');
    assert.deepStrictEqual(emitted.map((e) => e.kind), ['comment.created']);
    assert.deepStrictEqual(emitted[0].payload, {
        threadId: t.thread.id, commentId: answer.id, seq: 3, authorKind: 'assistant', targetType: 'notebook', targetId: 'nb1',
    });
    assert.deepStrictEqual(of('transient').map((e) => [e.kind, e.payload.status]), [['comment.ai.started', 'running'], ['comment.ai.finished', 'answered']]);
    const feed = JSON.stringify([emitted, of('transient')]);
    assert.ok(!feed.includes('Travel') && !feed.includes('40k'), 'the feed carries no text');
    const [usage] = of('usage');
    assert.strictEqual(usage.source, 'project_comment');
    assert.strictEqual(usage.conversation_id, t.thread.id);
    assert.strictEqual(usage.total_tokens, 150);
    assert.strictEqual(of('lock')[0].conversationType, 'project_comment');
    assert.strictEqual(of('release').length, 1);
    assert.strictEqual(of('shield.release').length, 1);
    assert.strictEqual((await store.getThread('p1', t.thread.id)).status, 'open', 'the AI never resolves');
});

test('a passage that is gone, a whole-item comment and an unreadable item are all said plainly', async () => {
    const gone = await thread({ anchor: { quote: 'words that were deleted' } });
    await ask(gone);
    assert.match(of('shield.protect')[0].text, /no longer in the current text/);

    log = [];
    const whole = await thread({ anchor: null });
    await ask(whole);
    assert.match(of('shield.protect')[0].text, /about the notebook as a whole\. Its beginning:\n<item>\n# Plan/);

    log = [];
    item = null;
    const unreadable = await thread();
    const { done } = await ask(unreadable);
    assert.deepStrictEqual(done, { status: 'answered' });
    assert.match(of('shield.protect')[0].text, /could not be read, so only the thread is available/);
});

test('a designed document is read by the anchor\'s section', async () => {
    item = { name: 'Proposal', markdown: '# All\nEverything', sectionMarkdown: '## Pricing\nThe fee is 40k per year.' };
    const t = await thread({ anchor: { quote: 'fee is 40k', sectionId: 'pricing' } });
    await ask(t);
    assert.strictEqual(of('read')[0].sectionId, 'pricing');
    assert.match(of('shield.protect')[0].text, /section "Pricing"/);
});

test('refusals before anything is claimed: limits, no model, a busy thread', async () => {
    const t = await thread();
    limitText = 'Monthly budget reached';
    assert.deepStrictEqual((await ask(t)).out, { status: 'skipped', reason: 'limit' });
    limitText = null;
    model = null;
    assert.deepStrictEqual((await ask(t)).out, { status: 'skipped', reason: 'no_model' });
    model = { modelId: 'fast-model' };
    lockHeld = true;
    assert.deepStrictEqual((await ask(t)).out, { status: 'busy' });
    assert.strictEqual(of('llm').length, 0);
    assert.strictEqual(of('transient').length, 0, 'nothing announced for a refusal');
    const broken = await ask(t, { checkLimits: async () => { throw new Error('db down'); } });
    assert.deepStrictEqual(broken.out, { status: 'skipped', reason: 'unavailable' });
});

test('a shield block and a model failure store nothing, say only the status, and release the lock', async () => {
    const t = await thread();
    const before = (await store.listComments(t.thread.id)).length;
    shieldMode = 'block';
    assert.deepStrictEqual((await ask(t)).done, { status: 'blocked' });
    assert.strictEqual(of('llm').length, 0, 'no model call after a block');
    shieldMode = 'pass';
    modelAnswer = new Error('upstream 500 with secret details');
    assert.deepStrictEqual((await ask(t)).done, { status: 'failed' });
    modelAnswer = '   ';
    assert.deepStrictEqual((await ask(t)).done, { status: 'failed' });
    assert.strictEqual((await store.listComments(t.thread.id)).length, before);
    assert.strictEqual(of('release').length, 3);
    assert.deepStrictEqual(of('transient').filter((e) => e.kind === 'comment.ai.finished').map((e) => e.payload.status), ['blocked', 'failed', 'failed']);
    assert.ok(!JSON.stringify(of('transient')).includes('secret details'), 'no error text on the feed');
    assert.strictEqual(of('emit').length, 0);
});

test('a thread resolved while the answer was written gets no answer', async () => {
    const t = await thread();
    const slow = assistant({
        llmChat: async () => {
            await store.setStatus('p1', t.thread.id, 'resolved', 'ann');
            return { content: 'Late answer', usage: {} };
        },
    });
    const out = await slow.requestReply({ project: PROJECT, thread: t.thread, trigger: t.trigger, triggerText: t.triggerText, userId: 'bob' });
    assert.deepStrictEqual(await out.done, { status: 'skipped' });
    const comments = await store.listComments(t.thread.id);
    assert.ok(comments.every((c) => c.authorKind === 'user'), 'the answer was dropped');
    assert.strictEqual((await store.getThread('p1', t.thread.id)).status, 'resolved', 'and the thread stays resolved');
    assert.strictEqual(of('release').length, 1);
});

test('an answer somebody asked for starts the quiet time before the AI may join the thread by itself', async () => {
    const t = await thread();
    const caps = () => participationStore.capsFor({ surface: 'comment', containerId: t.thread.id, projectId: 'p1', orgId: 'org1' });
    assert.strictEqual((await caps()).lastReplyAt, null);
    const { done } = await ask(t, { recordReply: (d) => participationStore.recordDecision(d) });
    assert.deepStrictEqual(done, { status: 'answered' });

    const answer = (await store.listComments(t.thread.id)).at(-1);
    assert.ok((await caps()).lastReplyAt, 'the cooldown now counts from this answer');
    assert.strictEqual((await caps()).autoInChatHour, 0, 'an explicit answer is not an automatic one');
    const [decision] = await participationStore.listDecisions(t.thread.id);
    assert.deepStrictEqual(
        { surface: decision.surface, triggerKind: decision.triggerKind, decision: decision.decision, triggerMessageId: decision.triggerMessageId, replyMessageId: decision.replyMessageId, orgId: decision.orgId },
        { surface: 'comment', triggerKind: 'explicit', decision: 'replied', triggerMessageId: t.trigger.id, replyMessageId: answer.id, orgId: 'org1' },
    );

    // The log is a courtesy: a failure there does not undo the answer.
    const again = await thread();
    const out = await ask(again, { recordReply: async () => { throw new Error('decision log down'); } });
    assert.deepStrictEqual(out.done, { status: 'answered' });
    // A failed answer is no reply: nothing to count from.
    log = [];
    modelAnswer = new Error('upstream 500');
    await ask(await thread());
    assert.deepStrictEqual(of('decision'), []);
});

test('describePassage names the item kind', () => {
    assert.match(describePassage({ kind: 'document', name: '', passage: null }), /untitled document/);
    assert.match(describePassage({ kind: 'notebook', name: 'N', passage: { found: true, whole: false, quote: 'q', heading: '', section: 's' } }), /The text around it:/);
});
