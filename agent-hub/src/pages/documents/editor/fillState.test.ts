import { describe, expect, it } from 'vitest';

import { adoptFillState } from './fillState';

describe('adoptFillState', () => {
    const mine = { contract: { parameters: [] }, design: { font: 'serif' }, sampleValues: { client: 'Old BV' }, fillReview: { at: 'then', findings: [] } };

    it('takes the form\'s keys from the document as it is now, and leaves what the panel itself changes alone', () => {
        const next = adoptFillState(mine, {
            contract: { parameters: [{ key: 'other' }] }, design: { font: 'sans' },
            sampleValues: { client: 'New BV' }, filledBy: { client: { userId: 'bob', at: 'now' } },
        });
        expect(next).toEqual({
            contract: { parameters: [] }, design: { font: 'serif' },
            sampleValues: { client: 'New BV' }, filledBy: { client: { userId: 'bob', at: 'now' } },
        });
        expect('fillReview' in next).toBe(false);
    });

    it('hands back the same object when the form changed nothing, so nothing is redrawn or marked unsaved', () => {
        expect(adoptFillState(mine, { sampleValues: { client: 'Old BV' }, fillReview: { at: 'then', findings: [] }, design: { font: 'other' } })).toBe(mine);
        expect(adoptFillState({ design: {} }, null)).toEqual({ design: {} });
    });

    it('keeps the order of the keys the same on two copies that started the same, so they still compare equal as text', () => {
        const fresh = { sampleValues: { a: 1 }, valueRequests: [{ id: 'r' }], fieldNotes: [] };
        const one = adoptFillState({ ...mine }, fresh);
        const two = adoptFillState(JSON.parse(JSON.stringify(mine)) as typeof mine, fresh);
        expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    });
});
