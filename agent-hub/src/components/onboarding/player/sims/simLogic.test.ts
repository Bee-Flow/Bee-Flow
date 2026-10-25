// @vitest-environment node
//
// Unit tests — pure sim grading (match / order / flow-build). SimStep.jsx is a
// thin shell over these functions, so pinning them here keeps the interactive
// widgets honest without a DOM.

import { describe, it, expect } from 'vitest';
import { matchPickCorrect, evaluateOrder, evaluateFlow, seededShuffle } from './simLogic';

const PAIRS = [
    { id: 'schedule', left: 'Every Monday 08:00', right: 'On a schedule' },
    { id: 'webhook', left: 'Another system calls in', right: 'On webhook call' },
];

describe('matchPickCorrect', () => {
    it('matches only tiles from the same pair', () => {
        expect(matchPickCorrect(PAIRS, 'schedule', 'schedule')).toBe(true);
        expect(matchPickCorrect(PAIRS, 'schedule', 'webhook')).toBe(false);
    });

    it('never matches unknown ids', () => {
        expect(matchPickCorrect(PAIRS, 'nope', 'nope')).toBe(false);
        expect(matchPickCorrect([], 'schedule', 'schedule')).toBe(false);
    });
});

describe('evaluateOrder', () => {
    const solution = ['context', 'task', 'format'];

    it('accepts the exact order', () => {
        expect(evaluateOrder(solution, ['context', 'task', 'format'])).toEqual({ correct: true, firstWrongIndex: -1 });
    });

    it('points at the first misplaced item', () => {
        expect(evaluateOrder(solution, ['task', 'context', 'format']).firstWrongIndex).toBe(0);
        expect(evaluateOrder(solution, ['context', 'format', 'task']).firstWrongIndex).toBe(1);
    });

    it('rejects wrong-length arrangements', () => {
        expect(evaluateOrder(solution, ['context']).correct).toBe(false);
    });
});

describe('evaluateFlow', () => {
    const scenario = {
        id: 'digest',
        trigger: {
            options: [
                { id: 'schedule', label: 'On a schedule' },
                { id: 'webhook', label: 'On webhook call' },
                { id: 'manual', label: 'Trigger manually' },
            ],
            correct: 'schedule',
            feedback: { webhook: 'Nothing external calls in here — the clock starts this one.' },
        },
        steps: {
            palette: [
                { id: 'fetch', label: 'Fetch this week’s deals' },
                { id: 'summarise', label: 'AI step: write the digest' },
                { id: 'send', label: 'Send it to the sales channel' },
                { id: 'wait', label: 'Wait' },
            ],
            solution: ['fetch', 'summarise', 'send'],
            feedback: { wait: 'Nobody asked to pause — Wait just delays the digest.' },
        },
    };

    it('passes the exact right build', () => {
        const r = evaluateFlow(scenario, { triggerId: 'schedule', stepIds: ['fetch', 'summarise', 'send'] });
        expect(r).toEqual({ correct: true, problems: [] });
    });

    it('gives the trigger-specific feedback for a known wrong trigger', () => {
        const r = evaluateFlow(scenario, { triggerId: 'webhook', stepIds: ['fetch', 'summarise', 'send'] });
        expect(r.correct).toBe(false);
        expect(r.problems[0]).toMatch(/clock starts this one/);
    });

    it('asks for a trigger when none is picked', () => {
        const r = evaluateFlow(scenario, { triggerId: null, stepIds: [] });
        expect(r.problems[0]).toMatch(/starts with a trigger/);
    });

    it('flags distractor steps with their specific feedback', () => {
        const r = evaluateFlow(scenario, { triggerId: 'schedule', stepIds: ['fetch', 'summarise', 'send', 'wait'] });
        expect(r.correct).toBe(false);
        expect(r.problems.join(' ')).toMatch(/Wait just delays/);
    });

    it('names missing steps', () => {
        const r = evaluateFlow(scenario, { triggerId: 'schedule', stepIds: ['fetch', 'send'] });
        expect(r.problems.join(' ')).toMatch(/AI step: write the digest/);
    });

    it('detects right parts in the wrong order', () => {
        const r = evaluateFlow(scenario, { triggerId: 'schedule', stepIds: ['summarise', 'fetch', 'send'] });
        expect(r.correct).toBe(false);
        expect(r.problems.join(' ')).toMatch(/wrong order/);
    });
});

describe('seededShuffle', () => {
    it('is deterministic per seed and preserves the item set', () => {
        const items = ['a', 'b', 'c', 'd', 'e'];
        const one = seededShuffle(items, 'step-1');
        const two = seededShuffle(items, 'step-1');
        expect(one).toEqual(two);
        expect([...one].sort()).toEqual([...items].sort());
    });
});
