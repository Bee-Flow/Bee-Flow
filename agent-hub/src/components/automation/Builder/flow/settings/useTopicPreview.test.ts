import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useTopicPreview from './useTopicPreview';

const ROWS = [{ body: 'Broken parcel!' }];
const rulesAbout = (topic: string) => [{ name: 'hit', expr: `isAbout(item.body, "${topic}")` }];
const answerFor = (topic: string, score: number) => new Response(JSON.stringify({
    texts: ['Broken parcel!'], scores: [{ [topic]: score }], defaultThreshold: 0.5,
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('useTopicPreview — two checks, answered out of order', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('keeps the answer to the check made last', async () => {
        const pending: Array<(r: Response) => void> = [];
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { pending.push(resolve); })));
        const { result, rerender } = renderHook(
            ({ topic }: { topic: string }) => useTopicPreview({ rules: rulesAbout(topic), rows: ROWS }),
            { initialProps: { topic: 'a complaint' } },
        );

        // Asked for one topic…
        act(() => { void result.current.topic.check(); });
        await waitFor(() => expect(pending).toHaveLength(1));
        // …then the rule is changed and checked again, before the first answer.
        rerender({ topic: 'an invoice' });
        act(() => { void result.current.topic.check(); });
        await waitFor(() => expect(pending).toHaveLength(2));

        // The second answer arrives first, the first one late.
        await act(async () => { pending[1](answerFor('an invoice', 0.9)); });
        await waitFor(() => expect(result.current.topic.checkedRows).toBe(1));
        await act(async () => { pending[0](answerFor('a complaint', 0.9)); });

        // The late answer belongs to a question nobody is asking any more.
        expect(result.current.topic.checkedRows).toBe(1);
        expect(result.current.topic.loading).toBe(false);
        expect(result.current.counts?.perRule.map((r: { matched: number }) => r.matched)).toEqual([1]);
    });
});
