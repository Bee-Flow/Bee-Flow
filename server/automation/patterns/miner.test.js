// @typecheck
'use strict';
/**
 * Miner tests, including the golden gate over __fixtures__/streams.js:
 * precision@3 >= 0.8 on the positive streams, every labelled pattern in its
 * stream's top 3, and not one candidate from a negative stream.
 *
 * Run: node --test automation/patterns/miner.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { minePatterns, gateFailure, looksAutoSynced } = require('./miner');
const { estimateMinutes } = require('./effort');
const { scoreCandidate } = require('./score');
const { fixtures } = require('./__fixtures__/streams');
const B = require('./__fixtures__/builders');

/** The pure chain the pipeline runs: mine → effort → score → rank. */
function rank(f) {
    const res = minePatterns(f.events, { now: f.now });
    const ranked = res.candidates
        .map((c) => {
            const minutes = estimateMinutes(c);
            return { ...c, minutes, ...scoreCandidate({ ...c, minutes }, { now: f.now }) };
        })
        .sort((a, b) => b.score - a.score);
    return { ...res, ranked };
}

const matches = (c, e) => (!e.kind || c.kind === e.kind) && (e.verbs || []).every((v) => c.verbs.includes(v));

test('there are about thirty labelled streams of both kinds', () => {
    assert.ok(fixtures.length >= 28, `${fixtures.length} fixtures`);
    assert.ok(fixtures.filter((f) => f.label === 'positive').length >= 15);
    assert.ok(fixtures.filter((f) => f.label === 'negative').length >= 10);
    assert.strictEqual(new Set(fixtures.map((f) => f.name)).size, fixtures.length);
});

test('golden: precision@3 >= 0.8 and every labelled pattern in the top 3', () => {
    let surfaced = 0;
    let correct = 0;
    const misses = [];
    for (const f of fixtures.filter((x) => x.label === 'positive')) {
        const top = rank(f).ranked.slice(0, 3);
        surfaced += top.length;
        correct += top.filter((c) => f.expect.some((e) => matches(c, e))).length;
        for (const e of f.expect) if (!top.some((c) => matches(c, e))) misses.push(`${f.name}: ${JSON.stringify(e)}`);
    }
    const precision = surfaced ? correct / surfaced : 0;
    assert.ok(precision >= 0.8, `precision@3 = ${precision.toFixed(2)}`);
    assert.deepStrictEqual(misses, []);
});

test('golden: no negative stream surfaces anything', () => {
    for (const f of fixtures.filter((x) => x.label === 'negative')) {
        const { ranked } = rank(f);
        assert.deepStrictEqual(ranked.map((c) => `${c.kind}:${c.verbs.join('>')}`), [], f.name);
    }
});

test('golden: cold-start streams are early, the rest are not', () => {
    for (const f of fixtures.filter((x) => x.label === 'positive')) {
        const { ranked, coldStart } = rank(f);
        assert.strictEqual(coldStart, !!f.coldStart, f.name);
        for (const c of ranked) assert.strictEqual(c.confidence === 'early', !!f.coldStart, `${f.name} ${c.kind}`);
    }
});

test('rejections are named: bulk mail, bare meetings, auto-sync, unknown sources', () => {
    const byName = (n) => fixtures.find((f) => f.name === n);
    assert.ok(minePatterns(byName('newsletter_weekly_bulk').events, { now: B.NOW }).rejected.bulk_no_action >= 1);
    assert.ok(minePatterns(byName('bare_daily_standup').events, { now: B.NOW }).rejected.bare_meeting >= 1);
    assert.ok(minePatterns(byName('standup_with_everyday_tool_use').events, { now: B.NOW }).rejected.bare_meeting >= 1);
    assert.ok(minePatterns(byName('auto_synced_camera_folder').events, { now: B.NOW }).rejected.autosync >= 1);
    const unknown = minePatterns(byName('unknown_source_lookalike').events, { now: B.NOW });
    assert.ok(unknown.rejected.unknown_source > 0);
    assert.strictEqual(unknown.candidates.length, 0);
});

test('a bulk mail the user DOES act on every time can still be a pattern', () => {
    const events = B.daysOn([2]).flatMap((d) => [
        B.mailIn(B.at(d, 7), 'gmail', `Order export ${d}`, { bulk: true }),
        ...B.session(B.at(d, 8), `bx-${d}`, [['gmail_get_attachment', 'gmail'], ['sheets_append_rows', 'google-sheets']]),
    ]);
    const { candidates } = minePatterns(events, { now: B.NOW });
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].kind, 'mail_template');
});

test('reasons: empty input and a quiet history', () => {
    assert.strictEqual(minePatterns([], { now: B.NOW }).reason, 'not_enough_history');
    assert.strictEqual(minePatterns(fixtures.find((f) => f.name === 'short_history_noise').events, { now: B.NOW }).reason, 'not_enough_history');
    assert.strictEqual(minePatterns(fixtures.find((f) => f.name === 'random_one_offs').events, { now: B.NOW }).reason, 'no_patterns');
    assert.strictEqual(minePatterns(fixtures[0].events, { now: B.NOW }).reason, null);
});

test('one habit, one card: the follow-up sequence folds into the mail pattern', () => {
    const { candidates } = minePatterns(fixtures.find((f) => f.name === 'invoice_gmail_to_sheet_monday').events, { now: B.NOW });
    assert.strictEqual(candidates.length, 1);
    assert.deepStrictEqual(candidates[0].verbs, ['mail.received', 'gmail_search', 'gmail_get_attachment', 'sheets_append_rows']);
    assert.deepStrictEqual(candidates[0].templateIds.length, 1);
    assert.strictEqual(candidates[0].template, 'Factuur <id> van leverancier');
    assert.strictEqual(candidates[0].cadence.kind, 'weekly');
    assert.strictEqual(candidates[0].cadence.weekday, 1);
});

test('candidates never carry raw text: templates are masked, domains pseudonymous', () => {
    for (const f of fixtures) {
        for (const c of minePatterns(f.events, { now: f.now }).candidates) {
            const json = JSON.stringify(c);
            assert.ok(!/@|https?:\/\//.test(json), f.name);
            assert.ok(!/\d{4,}/.test(c.template || ''), `${f.name}: ${c.template}`);
        }
    }
});

test('gateFailure: weekly needs 3 of the last 6 weeks, monthly needs 3 months', () => {
    const now = B.NOW;
    const cad = (o) => ({ kind: 'weekly', distinctDays: 5, recentWeeks: 3, weeksPresent: 5, weeksWindow: 13, monthsPresent: 2, lastTs: now, ...o });
    assert.strictEqual(gateFailure(cad({}), 5, false, now), null);
    assert.strictEqual(gateFailure(cad({ recentWeeks: 2 }), 5, false, now), 'recent');
    assert.strictEqual(gateFailure(cad({}), 3, false, now), 'support');
    assert.strictEqual(gateFailure(cad({ distinctDays: 2 }), 5, false, now), 'days');
    assert.strictEqual(gateFailure(cad({ kind: 'monthly', monthsPresent: 3 }), 3, false, now), null);
    assert.strictEqual(gateFailure(cad({ kind: 'monthly', monthsPresent: 3, lastTs: now - 50 * B.DAY }), 3, false, now), 'stale');
    assert.strictEqual(gateFailure(cad({ kind: 'irregular' }), 5, false, now), 'irregular');
    // Cold start relaxes everything but the bare minimum.
    assert.strictEqual(gateFailure(cad({ recentWeeks: 0, distinctDays: 2 }), 3, true, now), null);
    // A daily habit must still be going.
    assert.strictEqual(gateFailure(cad({ kind: 'daily', recentWeeks: 0, lastTs: now - 3 * B.DAY }), 20, false, now), null);
    assert.strictEqual(gateFailure(cad({ kind: 'weekdays', lastTs: now - 40 * B.DAY }), 20, false, now), 'stale');
});

test('a daily habit that stopped weeks ago is not repeating work any more', () => {
    // The same two-step chat session every day for a month, ending 50 days ago.
    const days = [...Array(30).keys()].map((i) => 50 + i);
    const events = days.flatMap((d) => B.session(B.at(d, 9), `c-${d}`, [['gmail_read_attachment', 'gmail'], ['sheets_append_rows', 'google_sheets']]));
    const stopped = minePatterns(events, { now: B.NOW });
    assert.deepStrictEqual(stopped.candidates, []);
    assert.ok(stopped.rejected.gate_stale >= 1, JSON.stringify(stopped.rejected));
    // The same habit, still going, is found.
    const going = minePatterns(days.map((d) => d - 49).flatMap((d) => B.session(B.at(d, 9), `c-${d}`, [['gmail_read_attachment', 'gmail'], ['sheets_append_rows', 'google_sheets']])), { now: B.NOW });
    assert.ok(going.candidates.some((c) => c.kind === 'sequence'));
});

test('meetings without a series key never form a series', () => {
    const events = B.daysOn([2]).flatMap((d) => [
        B.meeting(B.at(d, 10), 'teams', null),
        ...B.session(B.at(d, 11), `ms-${d}`, [['planner_create_task', 'planner']]),
    ]);
    const res = minePatterns(events, { now: B.NOW });
    assert.ok(!res.candidates.some((c) => c.kind === 'meeting_followup'));
});

test('looksAutoSynced: bursts and round-the-clock drops', () => {
    const burst = Array.from({ length: 10 }, (_, i) => ({ ts: B.at(1, 2) + i * 1000 }));
    assert.strictEqual(looksAutoSynced(burst), true);
    const human = Array.from({ length: 10 }, (_, i) => ({ ts: B.at(i * 7, 9) }));
    assert.strictEqual(looksAutoSynced(human), false);
    // Four neighbours inside two minutes make a burst; three do not.
    const four = Array.from({ length: 4 }, (_, i) => ({ ts: B.at(1, 9) + i * 30_000 }));
    assert.strictEqual(looksAutoSynced(four), false);
    assert.strictEqual(looksAutoSynced([...four, { ts: B.at(1, 9) + 4 * 30_000 }]), true);
});
