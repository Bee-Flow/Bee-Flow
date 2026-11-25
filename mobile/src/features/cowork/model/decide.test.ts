/**
 * "Decide and look along": a review a run waits on, work shared with the
 * caller, and a run's receipt. The readers are total (the server's answer is
 * untrusted), and each sentence has its words.
 */

import type { TranslateFn } from '@/core/i18n';

import { receiptLabel } from './receipt';
import { actionLabel, canSubmit, waitingReview } from './review';
import { sharedFooter, sharedLine, sharedRoute } from './shared';
import { readReceipt, readRuns, readShared, readSharedView } from '../api/readers';

const t: TranslateFn = (_key, fallback, params) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? ''));

describe('a review a run waits on', () => {
    const asked = { reason: 'Needs a discount', question: 'May I offer 10%?', summary: null, resolution: null };

    it('reads the review of a run row, and nothing for a run that asked none', () => {
        const runs = readRuns({ runs: [{ id: 'r1', status: 'needs_review', review: asked }, { id: 'r0', status: 'completed', review: null }] });
        expect(runs[0]?.review?.question).toBe('May I offer 10%?');
        expect(runs[1]?.review).toBeNull();
    });

    it('waits on the newest unresolved one only', () => {
        expect(waitingReview([{ id: 'r2', status: 'completed' }, { id: 'r1', status: 'needs_review', review: asked }])?.runId).toBe('r1');
        expect(waitingReview([{ id: 'r1', status: 'needs_review', review: { ...asked, resolution: 'answered' } }])).toBeNull();
        expect(waitingReview([{ id: 'r1', status: 'completed', review: asked }])).toBeNull();
        expect(waitingReview(undefined)).toBeNull();
    });

    it('an answer needs words, the other two actions do not', () => {
        expect(canSubmit('answer', '   ')).toBe(false);
        expect(canSubmit('answer', 'Yes')).toBe(true);
        expect(canSubmit('done_myself', '')).toBe(true);
        expect(actionLabel('not_needed', t)).toBe('Not needed');
    });
});

describe('work shared with the caller', () => {
    it('says whose it is and what the caller may do', () => {
        expect(sharedLine({ ownerName: 'Ann', role: 'approver' }, t)).toBe('Ann’s, you decide its questions');
        expect(sharedLine({ ownerName: 'Ann', role: 'viewer' }, t)).toBe('Ann’s, you can see it');
        expect(sharedLine({ ownerName: ' ', role: 'viewer' }, t)).toBe('A colleague’s, you can see it');
        expect(sharedRoute('a b')).toBe('/cowork/shared/a%20b');
    });

    it('reads the list, dropping rows without an item, and an unknown role as the weakest', () => {
        const items = readShared({ items: [{ id: 's1', ownerName: 'Ann', title: 'Digest', role: 'boss' }, { title: 'No id' }] });
        expect(items).toHaveLength(1);
        expect(items[0]?.role).toBe('viewer');
        expect(readShared(null)).toEqual([]);
    });

    it('reads a shared view, read only, with its runs', () => {
        const view = readSharedView({
            role: 'approver',
            item: { id: 's1', title: 'Digest', prompt: 'Summarise.', isActive: true },
            runs: [{ id: 'r1', status: 'completed', result: 'Done', durationMs: 5 }],
        });
        expect(view?.role).toBe('approver');
        expect(view?.item.triggerKind).toBe('schedule');
        expect(view?.runs[0]?.result).toBe('Done');
        expect(readSharedView('<html>')).toBeNull();
        expect(sharedFooter({ role: 'viewer' }, 'Ann', t)).toBe('You can look along here. Changing it is up to Ann.');
    });
});

describe('a run’s receipt', () => {
    it('names its number and whether it is signed', () => {
        expect(receiptLabel({ seq: 3, signed: true }, t)).toBe('Receipt #3 · signed');
        expect(receiptLabel({ seq: 4, signed: false }, t)).toBe('Receipt #4 · not signed');
    });

    it('is signed only when the server says so, and an answer that is no receipt reads as none', () => {
        expect(readReceipt({ seq: 2, runId: 'r1', at: null, signed: 'yes' })?.signed).toBe(false);
        expect(readReceipt({ seq: 2, runId: 'r1', signed: true })?.seq).toBe(2);
        expect(readReceipt(null)).toBeNull();
    });
});
