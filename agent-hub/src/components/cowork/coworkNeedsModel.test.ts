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

    it('a repair that is ready names the step that failed, and opens the item', () => {
        const filled = (_k: string, en: string, vars: Record<string, unknown> = {}) => en.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));
        const repair = need({ kind: 'repair', repair: { proposalId: 'pr-1', reasonCode: 'step_failed_twice', stepTitle: 'Read the order table' } });
        expect(needWords(repair, filled)).toMatchObject({ line: "Failed twice at 'Read the order table'. A fix is ready.", action: 'open', button: 'See the fix', detail: null });
        expect(needWords(need({ kind: 'repair', repair: { proposalId: 'pr-2', reasonCode: 'goal_under_target', stepTitle: null } }), filled).line).toBe('Stayed under its goal three times in a row. A fix is ready.');
    });

    it('each state of a plan has its own sentence', () => {
        const lines = (['first', 'changed', 'blocked', 'gone'] as const).map((plan) => needWords(need({ kind: 'plan', plan }), t).line);
        expect(new Set(lines).size).toBe(4);
    });
});
