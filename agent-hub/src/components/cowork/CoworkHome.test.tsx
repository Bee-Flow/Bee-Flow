// Cowork's home: the day as one timeline that opens its items, and the AI cost of the month when there was any.
// The network is the seam (a recording fetch), no module is mocked.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkHome from './CoworkHome';
import type { CoworkHome as Home } from '@/api/coworkHome';

let calls: RecordedCall[];
const serve = (home: Home) => {
    calls = stubRecordingFetch(({ url }) => {
        if (url.includes('/api/cowork/home')) return jsonResponse(home);
        if (url.endsWith('/daily-mail')) return jsonResponse({ enabled: false, timeZone: 'UTC', available: false });
        return jsonResponse({ needs: [], count: 0 });
    });
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkHome', () => {
    it('shows the day, earliest first, and a moment opens its item; the month\'s cost is said', async () => {
        serve({
            how: {},
            today: [
                { kind: 'ran', itemId: 'w1', title: 'Supplier radar', at: '2026-11-23T07:30:00.000Z', status: 'success', runId: 'r1' },
                { kind: 'next', itemId: 'w2', title: 'Open quotes', at: '2026-11-23T16:00:00.000Z', status: null, runId: null },
            ],
            cost: { byCurrency: { EUR: 0.62 }, calls: 9 },
        });
        const onOpen = vi.fn();
        renderWithClient(<CoworkHome onOpen={onOpen} />);
        const entries = await screen.findAllByTestId('cowork-today-entry');
        expect(entries.map((e) => e.dataset.kind)).toEqual(['ran', 'next']);
        expect(screen.getByText('Still to come')).toBeInTheDocument();
        expect(screen.getByTestId('cowork-cost-month')).toHaveTextContent(/AI this month: €0\.62/);
        const home = calls.find((c) => c.url.includes('/api/cowork/home'));
        expect(home?.url).toMatch(/from=.*&to=/);
        await userEvent.setup().click(screen.getByRole('button', { name: /Open quotes/ }));
        expect(onOpen).toHaveBeenCalledWith('w2');
    });

    it('an empty day and a month without AI say nothing', async () => {
        serve({ how: {}, today: [], cost: { byCurrency: {}, calls: 0 } });
        renderWithClient(<CoworkHome onOpen={() => {}} />);
        await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/api/cowork/home'))).toBe(true));
        expect(screen.queryByTestId('cowork-today')).toBeNull();
        expect(screen.queryByTestId('cowork-cost-month')).toBeNull();
    });
});
