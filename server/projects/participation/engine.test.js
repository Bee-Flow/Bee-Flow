/**
 * projects/participation/engine.js with the REAL store over PGlite, the real
 * policy module (configStore injected), and an in-memory surface and gate.
 * The job (jobs/aiParticipation.js) drives it, two instances of it standing
 * in for two servers.
 *
 * Proven (ai-participation.md §7.13):
 *   - an AI message never creates a watch; nor does a message in another
 *     mode, from an opted-out author, or that the rules turn down;
 *   - debouncing moves due_at and the trigger; a turned-down message still
 *     postpones; an explicit request cancels the quiet watch;
 *   - a human reply cancels "unanswered"; "wait" schedules it and it fires as
 *     its own trigger;
 *   - two servers never process one watch twice, and the cooldown and caps
 *     one server recorded stop the other;
 *   - a gate failure, a shield block and a stale answer are silence: a
 *     decision row with a code, no answer, and the breaker opens after
 *     repeated gate failures;
 *   - no content in project_ai_decisions or in the log lines;
 *   - a re-claimed watch does not pay for the gate twice.
 *
 * Run: cd server && node --test projects/participation/engine.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeProjectAiParticipationStore, DDL } = require('../../stores/projectAiParticipationStore');
const { makeParticipationEngine, BREAKER_THRESHOLD } = require('./engine');
const { makePolicy, CONFIG_KEY_PREFIX, USER_KEY_PREFIX } = require('./policy');
const { makeParticipationJob } = require('../../jobs/aiParticipation');

const SECRET = 'Project Nightingale budget 0612345678';

const { pg, db } = pgliteDb();
let ids = 0;
const store = makeProjectAiParticipationStore(db, { newId: () => `row-${++ids}` });

let config;
let conversations;
let gateCalls;
let gateResult;
let answers;
let answerResult;
let limitError;
let clock;
/** How each loadContext was asked for: `light` on the post path. */
let contextReads;

const policy = () => makePolicy({ getConfig: async (key) => config[key] ?? null, setConfig: async () => true, now: () => clock, env: {} });

function surface() {
    return {
        lockType: 'project_chat',
        async loadContext(id, opts) {
            contextReads.push(opts ? { ...opts } : {});
            const c = conversations.get(id);
            return c ? { ...c, messages: c.messages.filter((m) => !m.deleted) } : null;
        },
        async answer(job) {
            answers.push({ containerId: job.watch.containerId, trigger: job.trigger.id, aiTrigger: job.aiTrigger, reasonCode: job.reasonCode, gateLastSeq: job.gateLastSeq });
            const out = typeof answerResult === 'function' ? answerResult(job) : answerResult;
            if (out.status === 'answered') say(job.watch.containerId, 'AI', 'Here is the answer.');
            return out;
        },
    };
}

const engine = () => makeTestEngine();

function makeTestEngine() {
    const e = makeParticipationEngine({
        store,
        policy: policy(),
        gate: async (args) => {
            gateCalls.push(args);
            return typeof gateResult === 'function' ? gateResult(args) : gateResult;
        },
        checkLimits: async () => limitError,
        isLockHeld: async () => false,
        now: () => clock,
    });
    e.registerSurface('chat', surface());
    return e;
}

let seq = 0;
function say(chatId, author, text, extra = {}) {
    const c = conversations.get(chatId);
    const m = {
        id: `m${++seq}`, seq, authorKind: author === 'AI' ? 'assistant' : 'user', authorUserId: author === 'AI' ? null : author,
        text, createdAt: new Date(clock).toISOString(), replyTo: null, mentionsAi: false, mentionsHuman: false, ...extra,
    };
    c.messages.push(m);
    return m;
}

function chat(id, over = {}) {
    conversations.set(id, { projectId: 'p1', orgId: 'org1', aiMode: 'auto', closed: false, autoPausedUntil: null, messages: [], memberCount: 4, ...over });
    return id;
}

const post = (e, chatId, author, text, extra = {}) => {
    const m = say(chatId, author, text, extra);
    return e.onHumanMessage({ surface: 'chat', containerId: chatId, messageId: m.id, authorUserId: author, orgId: 'org1', limitOrgId: 'org1', projectId: 'p1', explicit: !!extra.explicit });
};
const makeDue = () => pg.query(`UPDATE project_ai_watch SET due_at = NOW() - INTERVAL '1 second' WHERE state = 'pending'`);
const pending = async (chatId) => (await pg.query(`SELECT * FROM project_ai_watch WHERE container_id = $1 AND state = 'pending' ORDER BY kind`, [chatId])).rows;
const decisions = async (chatId) => (await pg.query(`SELECT * FROM project_ai_decisions WHERE container_id = $1 ORDER BY created_at, id`, [chatId])).rows;

const REPLY = {
    available: true, model: 'fast-1', outcome: 'reply',
    verdict: { shouldReply: true, confidence: 0.9, addressedTo: 'group', isOpenQuestion: true, waitForHumans: false, reasonCode: 'open_question_answerable' },
};

before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL)');
    await pg.exec(DDL);
    await pg.query(`INSERT INTO projects (id, name, owner_id) VALUES ('p1', 'p1', 'olga')`);
});
after(async () => { await pg.close(); });
beforeEach(async () => {
    await pg.exec('DELETE FROM project_ai_watch; DELETE FROM project_ai_decisions; DELETE FROM project_ai_feedback;');
    config = {};
    conversations = new Map();
    gateCalls = [];
    gateResult = REPLY;
    answers = [];
    answerResult = { status: 'answered', messageId: 'answer-1' };
    limitError = null;
    clock = Date.now();
    contextReads = [];
});

test('only a human message in auto mode that passes the rules starts a watch', async () => {
    const e = engine();
    chat('c1');
    const ai = say('c1', 'AI', 'Hello, I can help with the launch.');
    assert.strictEqual((await e.onHumanMessage({ surface: 'chat', containerId: 'c1', messageId: ai.id, authorUserId: 'ann' })).watched, false,
        'an AI message never creates a watch');
    assert.deepStrictEqual(await post(e, 'c1', 'ann', 'thanks!'), { watched: false, reason: 'acknowledgement' });
    assert.deepStrictEqual(await pending('c1'), []);

    chat('c-mention', { aiMode: 'mention' });
    assert.strictEqual((await post(e, 'c-mention', 'ann', 'What is the refund policy?')).reason, 'mode_not_auto');

    config[`${USER_KEY_PREFIX}bob`] = { autoJoinOnMyMessages: false };
    assert.deepStrictEqual(await post(e, 'c1', 'bob', 'What is the refund policy for annual plans?'), { watched: false, reason: 'author_opted_out' },
        'an opted-out author never triggers');
    config[`${CONFIG_KEY_PREFIX}org1`] = { autoAllowed: false };
    assert.strictEqual((await post(makeTestEngine(), 'c1', 'ann', 'What is the refund policy for annual plans?')).reason, 'org_disabled');
    assert.deepStrictEqual(await pending('c1'), []);
    assert.strictEqual((await e.onHumanMessage({ surface: 'comment', containerId: 'x', messageId: 'y', authorUserId: 'ann' })).reason, 'surface_unavailable');
});

test('debounce: the next message moves due_at and the trigger; a turned-down one still postpones', async () => {
    const e = engine();
    chat('c1');
    assert.deepStrictEqual(await post(e, 'c1', 'ann', 'What is the refund policy for annual plans?'), { watched: true });
    const [first] = await pending('c1');
    clock += 5_000;
    await pg.query(`UPDATE project_ai_watch SET due_at = NOW() + INTERVAL '5 seconds' WHERE id = $1`, [first.id]);
    await post(e, 'c1', 'ann', 'And for monthly plans, is it different?');
    const [second] = await pending('c1');
    assert.strictEqual(second.id, first.id);
    assert.notStrictEqual(second.message_id, first.message_id, 'the newest question is the trigger');
    assert.ok(new Date(second.due_at) > new Date(Date.now() + 30_000), 'pushed back by the quiet period');

    await pg.query(`UPDATE project_ai_watch SET due_at = NOW() + INTERVAL '5 seconds' WHERE id = $1`, [first.id]);
    await post(e, 'c1', 'bob', 'ok');
    const [third] = await pending('c1');
    assert.strictEqual(third.message_id, second.message_id, 'an acknowledgement does not become the trigger');
    assert.ok(new Date(third.due_at) > new Date(Date.now() + 30_000), 'but people are talking, so it waits');

    await post(e, 'c1', 'bob', '@ai just answer it', { explicit: true, mentionsAi: true });
    assert.deepStrictEqual(await pending('c1'), [], 'an explicit request cancels the quiet watch');
});

test('the post path reads the conversation light: only the job, which may answer, asks for the extra context', async () => {
    const e = engine();
    const job = makeParticipationJob({ store, engine: e, recordJobRun: () => {}, newId: () => `claim-${++ids}` });
    chat('c-light');
    assert.deepStrictEqual(await post(e, 'c-light', 'ann', 'What is the refund policy for annual plans?'), { watched: true });
    await post(e, 'c-light', 'bob', '@ai tell us', { explicit: true, mentionsAi: true });
    assert.deepStrictEqual(contextReads, [{ light: true }, { light: true }], 'no whole-item read on a person\'s post');

    chat('c-job');
    assert.deepStrictEqual(await post(e, 'c-job', 'ann', 'Does anyone know who owns the SLA report?'), { watched: true });
    contextReads = [];
    await makeDue();
    await job.tick();
    await job.drain();
    assert.deepStrictEqual(contextReads[0], {}, 'the job reads it whole: an answer may need the passage');
});

test('the gate says wait: an unanswered watch; a human reply cancels it, otherwise it fires', async () => {
    const e = engine();
    const job = makeParticipationJob({ store, engine: e, recordJobRun: () => {}, newId: () => `claim-${++ids}` });
    chat('c1');
    await post(e, 'c1', 'ann', 'Does anyone know who owns the SLA report?');
    const question = conversations.get('c1').messages.at(-1);
    await makeDue();
    gateResult = { ...REPLY, outcome: 'wait', verdict: { ...REPLY.verdict, waitForHumans: true } };
    await job.tick();
    await job.drain();
    let rows = await pending('c1');
    assert.deepStrictEqual(rows.map((r) => r.kind), ['unanswered']);
    assert.strictEqual((await decisions('c1'))[0].decision, 'deferred');
    assert.strictEqual(answers.length, 0);

    // Somebody answers: the unanswered watch goes.
    assert.deepStrictEqual(await post(e, 'c1', 'bob', 'Carla does, I think', { replyTo: question.id }), { watched: false, reason: 'reply_to_person' });
    rows = await pending('c1');
    assert.ok(!rows.some((r) => r.kind === 'unanswered'), 'a human reply cancels "unanswered"');

    // Again, and this time nobody answers.
    chat('c2');
    await post(e, 'c2', 'ann', 'Does anyone know who owns the SLA report?');
    await makeDue();
    await job.tick(); await job.drain();
    await makeDue();
    gateResult = (args) => (args.triggerKind === 'unanswered' ? { ...REPLY, verdict: { ...REPLY.verdict, reasonCode: 'unanswered_question' } } : REPLY);
    await job.tick(); await job.drain();
    assert.deepStrictEqual(answers.map((a) => [a.containerId, a.aiTrigger, a.reasonCode]), [['c2', 'auto_unanswered', 'unanswered_question']]);
    assert.deepStrictEqual((await decisions('c2')).map((d) => [d.trigger_kind, d.decision]), [['quiet', 'deferred'], ['unanswered', 'replied']]);
});

test('two servers: each watch is processed once, and one server\'s answer is the other\'s cooldown', async () => {
    const serverA = engine();
    const serverB = engine();
    const jobA = makeParticipationJob({ store, engine: serverA, recordJobRun: () => {}, newId: () => `A-${++ids}` });
    const jobB = makeParticipationJob({ store, engine: serverB, recordJobRun: () => {}, newId: () => `B-${++ids}` });
    for (const id of ['c1', 'c2', 'c3']) {
        chat(id);
        await post(serverA, id, 'ann', 'What is the refund policy for annual plans?');
    }
    await makeDue();
    await Promise.all([jobA.tick(), jobB.tick()]);
    await Promise.all([jobA.drain(), jobB.drain()]);
    assert.strictEqual(gateCalls.length, 3, 'one gate per watch, not per server');
    assert.deepStrictEqual(answers.map((a) => a.containerId).sort(), ['c1', 'c2', 'c3']);

    // A new question a minute later, now on server B: the cooldown server A
    // recorded holds, before any model call.
    clock += 60_000;
    for (const id of ['c1', 'c2', 'c3']) await post(serverB, id, 'bob', 'And what about monthly plans then?');
    assert.deepStrictEqual(await pending('c1'), [], 'the cooldown is checked on the post already');

    // The project cap, over chats: at most maxAutoPerProjectDay answers.
    config[`${CONFIG_KEY_PREFIX}org1`] = { maxAutoPerProjectDay: 3 };
    const capped = engine();
    chat('c4');
    assert.strictEqual((await post(capped, 'c4', 'ann', 'What is the refund policy for annual plans?')).reason, 'project_day_cap');
    assert.strictEqual(gateCalls.length, 3);
});

test('a gate failure is silence, and repeated failures open the breaker', async () => {
    const e = engine();
    const job = makeParticipationJob({ store, engine: e, recordJobRun: () => {}, newId: () => `claim-${++ids}` });
    gateResult = { available: false, skipReason: 'timeout', model: 'fast-1' };
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
        chat(`f${i}`);
        await post(e, `f${i}`, 'ann', 'What is the refund policy for annual plans?');
    }
    await makeDue();
    await job.tick(); await job.drain();
    assert.strictEqual(answers.length, 0);
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
        assert.deepStrictEqual((await decisions(`f${i}`)).map((d) => [d.decision, d.skip_reason, !!d.gate_called]), [['skipped', 'timeout', true]]);
    }
    assert.strictEqual(e.breakerOpen(), true);
    chat('f-next');
    await post(e, 'f-next', 'ann', 'What is the refund policy for annual plans?');
    await makeDue();
    const paused = await job.tick();
    assert.deepStrictEqual(paused.paused, true, 'nothing is claimed while the breaker is open');
    assert.strictEqual((await pending('f-next')).length, 1, 'the watch waits');
    clock += 31_000;
    gateResult = REPLY;
    await job.tick(); await job.drain();
    assert.deepStrictEqual(answers.map((a) => a.containerId), ['f-next']);
    assert.strictEqual(e.breakerOpen(), false);
});

test('a shield block, a stale answer, [[SKIP]] and a limit are silence with a code', async () => {
    const e = engine();
    const job = makeParticipationJob({ store, engine: e, recordJobRun: () => {}, newId: () => `claim-${++ids}` });
    const cases = [
        ['s-block', () => { gateResult = { available: false, skipReason: 'blocked', model: 'fast-1' }; }, 'blocked'],
        ['s-answer-block', () => { gateResult = REPLY; answerResult = { status: 'blocked' }; }, 'blocked'],
        ['s-stale', () => { gateResult = REPLY; answerResult = { status: 'stale' }; }, 'stale'],
        ['s-skip', () => { gateResult = REPLY; answerResult = { status: 'skipped', reason: 'skip_sentinel' }; }, 'skip_sentinel'],
        ['s-limit', () => { limitError = 'Monthly limit reached'; }, 'limit'],
    ];
    for (const [id, arrange, reason] of cases) {
        chat(id);
        await post(e, id, 'ann', 'What is the refund policy for annual plans?');
        await makeDue();
        arrange();
        await job.tick(); await job.drain();
        limitError = null;
        const rows = await decisions(id);
        assert.deepStrictEqual(rows.map((d) => [d.decision, d.skip_reason]), [['skipped', reason]], id);
    }
    assert.strictEqual(gateCalls.length, 4, 'the limit is checked before the gate');
    assert.ok(conversations.get('s-stale').messages.every((m) => m.authorKind === 'user'), 'no answer was stored');
});

test('no content in the decision log or the log lines', async () => {
    const lines = [];
    const saved = {};
    for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
        saved[k] = console[k];
        console[k] = (...args) => { lines.push(args.map(String).join(' ')); };
    }
    try {
        const e = makeParticipationEngine({
            store,
            policy: policy(),
            gate: async () => { throw new Error(`provider echoed: ${SECRET}`); },
            checkLimits: async () => null,
            isLockHeld: async () => false,
            now: () => clock,
        });
        e.registerSurface('chat', surface());
        chat('c1');
        await post(e, 'c1', 'ann', `Who has the ${SECRET} numbers?`);
        await makeDue();
        const [w] = await store.claimDue(5, { claimId: 'x' });
        const out = await e.processWatch(w);
        assert.deepStrictEqual(out, { decision: 'skipped', skipReason: 'error' });
    } finally {
        Object.assign(console, saved);
    }
    const rows = await decisions('c1');
    assert.ok(rows.length > 0);
    assert.ok(!JSON.stringify(rows).includes('Nightingale'), 'no content in project_ai_decisions');
    assert.ok(lines.length > 0, 'the failure was logged');
    // The engine logs ids and codes, never the text of a message, nor an
    // error message that might quote it.
    assert.ok(!lines.some((l) => l.includes('Nightingale') || l.includes('0612345678')), lines.join('\n'));
});

test('a re-claimed watch does not pay for the gate twice', async () => {
    const e = engine();
    chat('c1');
    await post(e, 'c1', 'ann', 'What is the refund policy for annual plans?');
    await makeDue();
    const [w] = await store.claimDue(5, { claimId: 'first' });
    await e.processWatch(w);
    assert.strictEqual(gateCalls.length, 1);
    // The same conversation state again (a crash after the gate, say).
    const again = await e.processWatch({ ...w, id: 'replay' });
    assert.strictEqual(gateCalls.length, 1);
    assert.ok(['already_gated', 'ai_spoke_last', 'cooldown'].includes(again.skipReason), again.skipReason);
});

test('a watch whose conversation moved on between people, or was deleted, is dropped without a gate', async () => {
    const e = engine();
    chat('c1');
    await post(e, 'c1', 'ann', 'What is the refund policy for annual plans?');
    say('c1', 'bob', 'ok');
    await makeDue();
    let [w] = await store.claimDue(5, { claimId: 'a' });
    assert.strictEqual((await e.processWatch(w)).skipReason, 'conversation_moved_on');

    chat('c2');
    const r = await post(e, 'c2', 'ann', 'What is the refund policy for annual plans?');
    assert.ok(r.watched);
    conversations.get('c2').messages[0].deleted = true;
    await makeDue();
    [w] = await store.claimDue(5, { claimId: 'b' });
    assert.strictEqual((await e.processWatch(w)).skipReason, 'trigger_gone');

    chat('c3');
    await post(e, 'c3', 'ann', 'What is the refund policy for annual plans?');
    conversations.delete('c3');
    await makeDue();
    [w] = await store.claimDue(5, { claimId: 'c' });
    assert.strictEqual((await e.processWatch(w)).skipReason, 'container_gone');
    assert.strictEqual(gateCalls.length, 0);
});
