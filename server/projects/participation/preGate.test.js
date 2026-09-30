/**
 * projects/participation/preGate.js — the cheap rules in front of the gate.
 * Pure: every input is a value, so every rule is proven on its own.
 *
 * Run: cd server && node --test projects/participation/preGate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { preGate, isAcknowledgement, humansAlternating, repliesToPerson, capReached, SKIP } = require('./preGate');
const { normalizeOrgPolicy } = require('./policy');

const T0 = Date.parse('2026-09-29T10:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const POLICY = normalizeOrgPolicy(null, { env: {} });

let seq = 0;
const msg = (author, text, minute, extra = {}) => ({
    id: `m${++seq}`, seq, authorKind: author === 'AI' ? 'assistant' : 'user', authorUserId: author === 'AI' ? null : author,
    text, createdAt: at(minute), replyTo: null, mentionsAi: false, mentionsHuman: false, ...extra,
});

function run(message, recent, over = {}) {
    return preGate({
        stage: 'post', triggerKind: 'quiet', now: Date.parse(message?.createdAt || at(0)) + 1000, surface: 'chat',
        mode: 'auto', closed: false, pausedUntil: null, policy: POLICY, authorOptedOut: false,
        message, recent, caps: null, ...over,
    });
}

test('a real question in an auto chat passes', () => {
    const q = msg('ann', 'What is our refund policy for annual plans?', 0);
    assert.deepStrictEqual(run(q, [q]), { ok: true });
});

test('the switches come first: not human, mode, org, opt-out, closed, paused', () => {
    const q = msg('ann', 'What is our refund policy for annual plans?', 0);
    const ai = msg('AI', 'Here is a summary of the plan.', 0);
    assert.deepStrictEqual(run(ai, [ai]), { ok: false, reason: SKIP.NOT_HUMAN }, 'an AI message never starts a watch');
    assert.deepStrictEqual(run({ ...q, authorKind: 'system' }, [q]), { ok: false, reason: SKIP.NOT_HUMAN });
    for (const mode of ['off', 'mention', 'always']) assert.strictEqual(run(q, [q], { mode }).reason, SKIP.MODE);
    assert.strictEqual(run(q, [q], { policy: { ...POLICY, autoAllowed: false } }).reason, SKIP.ORG_DISABLED);
    assert.strictEqual(run(q, [q], { surface: 'comment', policy: { ...POLICY, commentsAutoAllowed: false } }).reason, SKIP.ORG_DISABLED);
    assert.deepStrictEqual(run(q, [q], { surface: 'comment' }), { ok: true });
    assert.strictEqual(run(q, [q], { authorOptedOut: true }).reason, SKIP.OPTED_OUT, 'an opted-out author never triggers');
    assert.strictEqual(run(q, [q], { closed: true }).reason, SKIP.CLOSED);
    assert.strictEqual(run(q, [q], { pausedUntil: at(60) }).reason, SKIP.PAUSED);
    assert.deepStrictEqual(run(q, [q], { pausedUntil: at(-60) }), { ok: true }, 'a pause that ended is no pause');
    assert.strictEqual(run(null, []).reason, SKIP.TRIGGER_GONE);
});

test('aimed at a person, or asking the AI outright, is not for the gate', () => {
    const q = msg('ann', 'Could you check the numbers?', 0, { mentionsHuman: true });
    assert.strictEqual(run(q, [q]).reason, SKIP.ADDRESSED_TO_PERSON);
    const both = msg('ann', '@ai and @bob, thoughts?', 0, { mentionsHuman: true, mentionsAi: true });
    assert.strictEqual(run(both, [both]).reason, SKIP.EXPLICIT);

    const bobs = msg('bob', 'I pushed the new pricing sheet', 0);
    const reply = msg('ann', 'Did you include the discount tiers?', 3, { replyTo: bobs.id });
    assert.strictEqual(run(reply, [bobs, reply]).reason, SKIP.REPLY_TO_PERSON);
    const lateReply = msg('ann', 'Did you include the discount tiers?', 9, { replyTo: bobs.id });
    assert.deepStrictEqual(run(lateReply, [bobs, lateReply]), { ok: true }, 'after five minutes it is a question again');
    assert.strictEqual(repliesToPerson([bobs], { replyTo: bobs.id, authorUserId: 'bob', createdAt: at(1) }), false, 'replying to oneself');
});

test('people taking turns are talking to each other', () => {
    const a1 = msg('ann', 'Shall we move the launch to Tuesday?', 0);
    const b1 = msg('bob', 'Tuesday works for marketing', 1);
    const a2 = msg('ann', 'What about the press release timing then?', 2);
    assert.strictEqual(run(a2, [a1, b1, a2]).reason, SKIP.HUMANS_CONVERSING);
    assert.strictEqual(humansAlternating([a1, b1], b1), false, 'one exchange is not yet a conversation');
    const later = msg('ann', 'What about the press release timing then?', 10);
    assert.deepStrictEqual(run(later, [a1, b1, later]), { ok: true }, 'outside three minutes the turns do not count');
    const ai = msg('AI', 'Tuesday is free in the calendar.', 1.5);
    assert.strictEqual(humansAlternating([a1, b1, ai, a2], a2), false, 'the AI speaking resets the turns');
});

test('acknowledgements and emoji ask for nothing', () => {
    for (const text of ['ok', 'thanks!', 'sounds good 👍', '👍', '🎉🎉', '...', 'Deal.', '   ']) {
        assert.strictEqual(isAcknowledgement(text), true, text);
    }
    for (const text of ['why?', 'Can anyone summarise this thread for me', 'kan iemand dit samenvatten?', '¿Qué?']) {
        assert.strictEqual(isAcknowledgement(text), false, text);
    }
    const ack = msg('ann', 'thanks a lot', 0);
    assert.strictEqual(run(ack, [ack]).reason, SKIP.ACKNOWLEDGEMENT);
});

test('at the job: the AI spoke last, or the conversation moved on between people', () => {
    const q = msg('ann', 'What is our refund policy for annual plans?', 0);
    const ai = msg('AI', 'Annual plans are refundable within 30 days.', 1);
    assert.strictEqual(run(q, [q, ai], { stage: 'job' }).reason, SKIP.AI_SPOKE_LAST);
    const b = msg('bob', 'ok', 1);
    assert.strictEqual(run(q, [q, b], { stage: 'job' }).reason, SKIP.MOVED_ON);
    assert.deepStrictEqual(run(q, [q], { stage: 'job' }), { ok: true });
    assert.strictEqual(run(q, [q], { stage: 'job', lockHeld: true }).reason, SKIP.BUSY);
    assert.deepStrictEqual(run(q, [q], { lockHeld: true }), { ok: true }, 'the lock is only looked at when the watch comes due');
});

test('an unanswered question: still there, nobody answered, the AI did not speak', () => {
    const q = msg('ann', 'Who owns the SLA report?', 0);
    const opts = { stage: 'job', triggerKind: 'unanswered' };
    assert.deepStrictEqual(run(q, [q], opts), { ok: true });
    assert.deepStrictEqual(run(q, [q, msg('ann', 'anyone?', 5)], opts), { ok: true }, 'the asker nudging is not an answer');
    assert.strictEqual(run(q, [q, msg('bob', 'I think Carla does', 4)], opts).reason, SKIP.ANSWERED, 'a human reply answers it');
    assert.strictEqual(run(q, [q, msg('ann', 'never mind', 4, { replyTo: q.id })], opts).reason, SKIP.ANSWERED);
    assert.strictEqual(run(q, [q, msg('AI', 'Carla owns it.', 4)], opts).reason, SKIP.AI_SPOKE_LAST);
    assert.strictEqual(run(q, [], opts).reason, SKIP.TRIGGER_GONE, 'a deleted question is gone');
});

test('cooldown and caps, first reached wins', () => {
    const now = T0;
    assert.strictEqual(capReached(null, POLICY, now), null);
    assert.strictEqual(capReached({ lastReplyAt: at(-1) }, POLICY, now), SKIP.COOLDOWN);
    assert.strictEqual(capReached({ lastReplyAt: at(-4) }, POLICY, now), null, 'three minutes by default');
    assert.strictEqual(capReached({ autoInChatHour: 4 }, POLICY, now), SKIP.CHAT_HOUR_CAP);
    assert.strictEqual(capReached({ autoInProjectDay: 30 }, POLICY, now), SKIP.PROJECT_DAY_CAP);
    assert.strictEqual(capReached({ gatesInChatHour: 12 }, POLICY, now), SKIP.GATE_CHAT_CAP);
    assert.strictEqual(capReached({ gatesInOrgDay: 500 }, POLICY, now), SKIP.GATE_ORG_CAP);
    const q = msg('ann', 'What is our refund policy for annual plans?', 0);
    assert.strictEqual(run(q, [q], { caps: { autoInChatHour: 99 } }).reason, SKIP.CHAT_HOUR_CAP);
});
