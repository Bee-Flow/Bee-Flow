// @typecheck
'use strict';
/**
 * Run: node --test automation/patterns/score.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { scoreCandidate, wilsonLower, REASON_CODES } = require('./score');

const NOW = Date.UTC(2026, 9, 3, 18);
const DAY = 86_400_000;

const weekly = {
    kind: 'mail_template', verbs: ['mail.received', 'gmail_get_attachment', 'sheets_append_rows'], apps: ['gmail', 'google-sheets'],
    structured: true, confidence: 'high', minutes: { range: [3, 7], basis: 'heuristic' },
    cadence: { kind: 'weekly', cv: 0, perMonth: 4.3, weeksPresent: 13, weeksWindow: 13, lastTs: NOW - 2 * DAY },
};

test('wilsonLower is a conservative share', () => {
    assert.strictEqual(wilsonLower(0, 0), 0);
    assert.ok(wilsonLower(13, 13) > 0.7 && wilsonLower(13, 13) < 1);
    assert.ok(wilsonLower(3, 3) < wilsonLower(13, 13));
    assert.ok(wilsonLower(3, 13) < wilsonLower(10, 13));
});

test('reason codes come from the fixed list', () => {
    const { score, reasons } = scoreCandidate(weekly, { now: NOW });
    assert.ok(score > 0);
    assert.deepStrictEqual(reasons, ['frequent', 'regular', 'multiStep', 'structuredInput', 'recent']);
    for (const r of reasons) assert.ok(REASON_CODES.includes(r));
});

test('more frequent and steadier ranks higher', () => {
    const base = scoreCandidate(weekly, { now: NOW }).score;
    const rarer = scoreCandidate({ ...weekly, cadence: { ...weekly.cadence, perMonth: 1, weeksPresent: 4 } }, { now: NOW }).score;
    const patchy = scoreCandidate({ ...weekly, cadence: { ...weekly.cadence, weeksPresent: 5 } }, { now: NOW }).score;
    assert.ok(base > rarer);
    assert.ok(base > patchy);
});

test('read-only, irregular work scores lower than structured writes', () => {
    const reads = { ...weekly, verbs: ['gmail_search', 'gmail_read_message'], structured: false, cadence: { ...weekly.cadence, kind: 'irregular' } };
    assert.ok(scoreCandidate(weekly, { now: NOW }).score > scoreCandidate(reads, { now: NOW }).score);
});

test('a weekday habit is regular despite its weekend gaps', () => {
    const triage = { ...weekly, kind: 'sequence', structured: false, cadence: { ...weekly.cadence, kind: 'weekdays', cv: 0.6 } };
    assert.ok(scoreCandidate(triage, { now: NOW }).reasons.includes('regular'));
    const scattered = { ...triage, cadence: { ...triage.cadence, kind: 'weekly' } };
    assert.ok(!scoreCandidate(scattered, { now: NOW }).reasons.includes('regular'));
});

test('monthly stability uses months, measured effort and early are reported', () => {
    const monthly = {
        kind: 'mail_template', verbs: ['mail.sent'], apps: ['gmail'], confidence: 'early', minutes: { range: [5, 8], basis: 'measured' },
        cadence: { kind: 'monthly', cv: 0.05, perMonth: 1, weeksPresent: 3, weeksWindow: 13, monthsPresent: 3, monthsWindow: 3, lastTs: NOW - 20 * DAY },
    };
    const { score, reasons } = scoreCandidate(monthly, { now: NOW });
    assert.ok(score > 0);
    assert.deepStrictEqual(reasons, ['regular', 'measuredEffort', 'early']);
});
