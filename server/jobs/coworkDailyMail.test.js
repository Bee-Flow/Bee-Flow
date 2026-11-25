// @typecheck
/**
 * The daily Cowork e-mail (./coworkDailyMail.mts): in the owner's morning, once a day, only when something waits, to
 * the owner's own address, with titles and what each waits for and nothing a run read. Every part is handed in.
 *
 * Run: cd server && node --test jobs/coworkDailyMail.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { sendDue, dueDay, localClock, listOf, LIST_CAP } = require('./coworkDailyMail.mts');

/** 07:30 UTC on 23 November 2026 is 08:30 in Amsterdam (winter time). */
const MORNING = new Date('2026-11-23T07:30:00Z');

/** @param {{ needs?: any[], owners?: any[], configured?: boolean, sendFails?: boolean }} [o] */
function world({ needs = [{ kind: 'review', title: 'Offers', plan: null, reason: 'The secret text a run read' }], owners = [{ userId: 'u1', timeZone: 'Europe/Amsterdam', lastSentOn: null }], configured = true, sendFails = false } = {}) {
    /** @type {any[]} */
    const sent = [];
    /** @type {Set<string>} */
    const claimed = new Set();
    /** @type {any[]} */
    const rendered = [];
    const deps = {
        store: {
            listEnabled: async () => owners,
            claimDay: async (/** @type {string} */ userId, /** @type {string} */ day) => {
                if (claimed.has(`${userId}|${day}`)) return false;
                claimed.add(`${userId}|${day}`);
                return true;
            },
        },
        needsYou: async () => needs,
        getUser: async (/** @type {string} */ id) => ({ email: `${id}@example.test`, preferredLocale: 'en' }),
        translate: async (/** @type {string} */ _l, /** @type {string} */ _k, /** @type {any} */ vars = {}) => (vars.count ? `…and ${vars.count} more.` : ''),
        renderTemplate: async (/** @type {string} */ id, /** @type {string} */ locale, /** @type {any} */ vars) => { rendered.push({ id, locale, vars }); return { subject: `S ${vars.count}`, html: 'h', text: vars.list }; },
        sendServiceEmail: async (/** @type {any} */ mail) => { sent.push(mail); return sendFails ? { success: false, error: 'refused' } : { success: true }; },
        serviceMailConfigured: async () => configured,
        clientHost: () => 'https://app.example.test',
    };
    return { deps, sent, claimed, rendered };
}

test('the owner\'s local clock decides: from eight in the morning until eight in the evening, once a day', () => {
    assert.deepStrictEqual(localClock(MORNING, 'Europe/Amsterdam'), { day: '2026-11-23', hour: 8 });
    assert.strictEqual(localClock(MORNING, 'Not/AZone'), null);
    const owner = { userId: 'u1', timeZone: 'Europe/Amsterdam', lastSentOn: null };
    assert.strictEqual(dueDay(owner, MORNING), '2026-11-23');
    assert.strictEqual(dueDay(owner, new Date('2026-11-23T06:30:00Z')), null, '07:30 local is too early');
    assert.strictEqual(dueDay(owner, new Date('2026-11-23T19:30:00Z')), null, '20:30 local is too late');
    assert.strictEqual(dueDay({ ...owner, lastSentOn: '2026-11-23' }, MORNING), null);
    // Another zone has its own morning: 07:30 UTC is still the night in New York.
    assert.strictEqual(dueDay({ ...owner, timeZone: 'America/New_York' }, MORNING), null);
});

test('one mail to the owner\'s own address, with the titles and the sentences, never what a run read', async () => {
    const w = world();
    assert.strictEqual(await sendDue(MORNING, w.deps), 1);
    assert.deepStrictEqual(w.sent.map((m) => m.to), ['u1@example.test']);
    assert.strictEqual(w.rendered[0].id, 'cowork_daily');
    assert.deepStrictEqual(Object.keys(w.rendered[0].vars).sort(), ['count', 'cta', 'list']);
    assert.strictEqual(w.rendered[0].vars.cta, 'https://app.example.test/app/cowork');
    assert.match(w.rendered[0].vars.list, /^• Offers: The agent asks you to look at something\.$/);
    assert.doesNotMatch(JSON.stringify(w.sent), /secret text/);
    // The same pass again, or a second server: the day is taken.
    assert.strictEqual(await sendDue(MORNING, w.deps), 0);
    assert.strictEqual(w.sent.length, 1);
});

test('nothing waits, the service mailbox is not set up, or the mail is refused: no mail, and nothing thrown', async () => {
    const empty = world({ needs: [] });
    assert.strictEqual(await sendDue(MORNING, empty.deps), 0);
    assert.strictEqual(empty.sent.length, 0);
    const unset = world({ configured: false });
    assert.strictEqual(await sendDue(MORNING, unset.deps), 0);
    assert.strictEqual(unset.claimed.size, 0, 'nothing is claimed while no mail can go out');
    const refused = world({ sendFails: true });
    assert.strictEqual(await sendDue(MORNING, refused.deps), 0);
    assert.strictEqual(refused.claimed.size, 1, 'a refused mail is not tried again that day');
});

test('a long list is cut, with how many more there are', async () => {
    const needs = Array.from({ length: LIST_CAP + 3 }, (_, i) => ({ kind: 'plan', title: `Work ${i}`, plan: 'first' }));
    const text = await listOf(needs, 'en', async (_l, _k, vars = {}) => (vars.count ? `…and ${vars.count} more.` : ''));
    const lines = text.split('\n');
    assert.strictEqual(lines.length, LIST_CAP + 1);
    assert.strictEqual(lines.at(-1), '…and 3 more.');
    assert.strictEqual(lines[0], '• Work 0: Its plan waits for your approval.');
});

test('under the list, one line per item with a goal: its latest count and its sentence; goals alone send no mail', async () => {
    const goals = [
        { title: 'Supplier radar', sentence: 'Every supplier mail gets an answer within two working days', met: 46, total: 49, period: 'this week' },
        { title: 'Open quotes', sentence: 'Every quote is followed up', met: null, total: null, period: null },
    ];
    const w = world();
    assert.strictEqual(await sendDue(MORNING, { ...w.deps, goalsOf: async () => goals }), 1);
    assert.strictEqual(w.rendered[0].vars.list, [
        '• Offers: The agent asks you to look at something.',
        '',
        'Your goals:',
        '• Supplier radar: 46 of 49 this week (goal: Every supplier mail gets an answer within two working days)',
        '• Open quotes: not measured yet (goal: Every quote is followed up)',
    ].join('\n'));
    const nothingWaits = world({ needs: [] });
    assert.strictEqual(await sendDue(MORNING, { ...nothingWaits.deps, goalsOf: async () => goals }), 0);
    const unreadable = world();
    assert.strictEqual(await sendDue(MORNING, { ...unreadable.deps, goalsOf: async () => { throw new Error('down'); } }), 1, 'an unreadable goal list leaves the goals out, not the mail');
    assert.match(unreadable.rendered[0].vars.list, /^• Offers: [^\n]+$/);
});
