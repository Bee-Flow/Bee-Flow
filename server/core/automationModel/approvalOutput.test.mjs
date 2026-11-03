/**
 * The one approval output: exactly { approved, by, reason, decidedAt, answers,
 * votes }, with {} and [] for the empties and nothing else.
 *
 * Run: cd server && node --test core/automationModel/approvalOutput.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalOutput } from './approvalOutput.mts';

const NOW = () => new Date('2026-11-03T10:00:00.000Z');
const KEYS = ['answers', 'approved', 'by', 'decidedAt', 'reason', 'votes'];

test('a full decision keeps every field and nothing else', () => {
    const out = approvalOutput({
        approved: false, by: 'u1', reason: 'Too expensive', decidedAt: '2026-11-02T09:30:00Z',
        answers: { budget: 1200 }, votes: [{ userId: 'u1', approved: false }],
        // Not part of the contract: dropped.
        prompt: 'OK?', branch: 'rejected', simulated: true,
    });
    assert.deepEqual(out, {
        approved: false, by: 'u1', reason: 'Too expensive', decidedAt: '2026-11-02T09:30:00.000Z',
        answers: { budget: 1200 }, votes: [{ userId: 'u1', approved: false }],
    });
});

test('the empties: answers {}, votes [], by / reason null, decidedAt now', () => {
    const out = approvalOutput({ approved: true }, NOW);
    assert.deepEqual(out, { approved: true, by: null, reason: null, decidedAt: '2026-11-03T10:00:00.000Z', answers: {}, votes: [] });
    assert.deepEqual(Object.keys(approvalOutput(undefined, NOW)).sort(), KEYS);
    assert.deepEqual(Object.keys(approvalOutput({}, NOW)).sort(), KEYS);
});

test('approved is true only for literal true', () => {
    assert.equal(approvalOutput({ approved: 'yes' }).approved, false);
    assert.equal(approvalOutput({ approved: 1 }).approved, false);
    assert.equal(approvalOutput({ approved: true }).approved, true);
});

test('malformed fields fall back to their empty value', () => {
    const out = approvalOutput({ approved: true, by: 42, reason: '', decidedAt: 'not a date', answers: ['a'], votes: 'x' }, NOW);
    assert.deepEqual(out, { approved: true, by: null, reason: null, decidedAt: '2026-11-03T10:00:00.000Z', answers: {}, votes: [] });
    assert.deepEqual(approvalOutput({ votes: [null, 'x', { a: 1 }] }, NOW).votes, [{ a: 1 }]);
    assert.equal(approvalOutput({ decidedAt: new Date('2026-01-01T00:00:00Z') }).decidedAt, '2026-01-01T00:00:00.000Z');
});

test('the result is a copy: mutating it never edits the input', () => {
    const answers = { a: 1 };
    const votes = [{ v: 1 }];
    const out = approvalOutput({ approved: true, answers, votes });
    out.answers.a = 2;
    out.votes[0].v = 2;
    assert.equal(answers.a, 1);
    assert.equal(votes[0].v, 1);
});
