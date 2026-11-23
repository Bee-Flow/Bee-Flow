import { describe, expect, it } from 'vitest';
import { needWords } from './coworkNeedsModel';
import type { CoworkNeed } from '../../api/coworkNeedsYou';

const t = (_k: string, en: string) => en;
const need = (over: Partial<CoworkNeed>): CoworkNeed => ({ kind: 'review', itemId: 'w1', title: 'Offers', runId: null, since: null, reason: null, plan: null, ...over });

describe('needWords', () => {
    it('a decision goes to Approvals, everything else opens the item', () => {
        expect(needWords(need({ kind: 'decision', runId: 'r1' }), t)).toMatchObject({ action: 'approvals', button: 'Decide in Approvals' });
        for (const kind of ['review', 'sign_in', 'plan'] as const) expect(needWords(need({ kind, plan: kind === 'plan' ? 'first' : null }), t).action).toBe('open');
    });

    it('a review and a plan carry their reason; a decision and a sign-in none', () => {
        expect(needWords(need({ kind: 'review', reason: 'Which discount?' }), t).detail).toBe('Which discount?');
        expect(needWords(need({ kind: 'plan', plan: 'blocked', reason: 'A step reads outside text.' }), t)).toMatchObject({ line: 'The plan cannot run as it is.', detail: 'A step reads outside text.' });
        expect(needWords(need({ kind: 'sign_in', reason: 'ignored' }), t).detail).toBeNull();
    });

    it('each state of a plan has its own sentence', () => {
        const lines = (['first', 'changed', 'blocked', 'gone'] as const).map((plan) => needWords(need({ kind: 'plan', plan }), t).line);
        expect(new Set(lines).size).toBe(4);
    });
});
