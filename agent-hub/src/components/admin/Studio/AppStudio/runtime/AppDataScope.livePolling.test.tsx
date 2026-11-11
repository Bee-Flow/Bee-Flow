import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import AppDataScope from './AppDataScope';

/**
 * A component's own `liveSeconds` really polls. 2, 5 and 10 are below the
 * read-budget floor (15 s) and used to be ignored by the data hook, so the
 * component never refreshed; they now poll at the floor. 30 keeps 30.
 */
let recordReads = 0;

beforeEach(() => {
    recordReads = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    setDemoTransport(async (url: string) => {
        if (String(url).includes('/data/tables/tbl_a/records')) recordReads += 1;
        return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
});

afterEach(() => {
    setDemoTransport(null);
    vi.useRealTimers();
});

function renderLive(liveSeconds: number) {
    const definition = {
        screens: [{
            id: 's1',
            sections: [{
                id: 'sec1',
                children: [{ id: 'p1', type: 'progress', props: { liveSeconds, source: { kind: 'records', tableId: 'tbl_a' } } }],
            }],
        }],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
        <QueryClientProvider client={client}>
            <AppDataScope appId="app-1" definition={definition as never} screenId="s1" sample={false}>
                {() => null}
            </AppDataScope>
        </QueryClientProvider>,
    );
}

async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('liveSeconds polling', () => {
    it('polls a value below the floor at the floor', async () => {
        renderLive(5);
        await advance(100);
        expect(recordReads).toBe(1);
        await advance(14_000);
        expect(recordReads).toBe(1);
        await advance(1_500);
        expect(recordReads).toBe(2);
    });

    it('keeps 30 seconds at 30 seconds', async () => {
        renderLive(30);
        await advance(100);
        expect(recordReads).toBe(1);
        await advance(16_000);
        expect(recordReads).toBe(1);
        await advance(15_000);
        expect(recordReads).toBe(2);
    });

    it('does not poll without liveSeconds, or with a negative one', async () => {
        for (const seconds of [0, -5]) {
            recordReads = 0;
            const view = renderLive(seconds);
            await advance(100);
            expect(recordReads).toBe(1);
            await advance(60_000);
            expect(recordReads).toBe(1);
            view.unmount();
        }
    });
});
