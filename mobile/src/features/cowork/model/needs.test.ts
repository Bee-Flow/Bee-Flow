import type { TranslateFn } from '@/core/i18n';

import { needRoute, needSentence } from './needs';
import { readNeeds } from '../api/readers';

const t: TranslateFn = (_key, fallback) => fallback;

describe('Waiting for you', () => {
    it('a decision opens the approvals inbox, everything else its own item', () => {
        expect(needRoute({ kind: 'decision', itemId: 'w1', title: 'A', plan: null })).toBe('/approvals');
        expect(needRoute({ kind: 'review', itemId: 'w 2', title: 'B', plan: null })).toBe('/cowork/w%202');
    });

    it('each state of a plan has its own sentence', () => {
        const lines = ['first', 'changed', 'blocked', 'gone'].map((plan) => needSentence({ kind: 'plan', itemId: 'w', title: '', plan }, t));
        expect(new Set(lines).size).toBe(4);
        expect(needSentence({ kind: 'sign_in', itemId: 'w', title: '', plan: null }, t)).toMatch(/sign in again/);
    });

    it('an entry without an item or a kind is dropped; a missing list reads as none', () => {
        expect(readNeeds({ needs: [{ kind: 'review', itemId: 'w1', title: 'T' }, { kind: 'review' }, { itemId: 'w3' }] })).toHaveLength(1);
        expect(readNeeds(null)).toEqual([]);
    });

    it('a run that did not do its work, or that its AI said failed, has its own sentence and opens its item', () => {
        expect(needSentence({ kind: 'incomplete', itemId: 'w', title: '', plan: null }, t)).toMatch(/did not do its work/i);
        expect(needSentence({ kind: 'ai_failed', itemId: 'w', title: '', plan: null }, t)).toMatch(/AI said/);
        expect(needRoute({ kind: 'incomplete', itemId: 'w4', title: 'D', plan: null })).toBe('/cowork/w4');
    });
});
