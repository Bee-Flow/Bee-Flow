// AI Monitor. Pinned: the figures on screen belong to the range that is
// selected; a slow answer for the range that was left is dropped.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import MonitoringPanel from './index';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const summary = (calls: number) => ({ total_calls: calls, total_tokens: 0, total_estimated_cost: 0, total_billed_cost: 0, avg_duration_ms: 0 });

afterEach(() => { setDemoTransport(null); });

describe('MonitoringPanel range switch', () => {
    it('keeps the selected range when the answer for the previous one arrives late', async () => {
        const user = userEvent.setup();
        let releaseRanged: () => void = () => {};
        const rangedGate = new Promise<void>((resolve) => { releaseRanged = resolve; });
        const pending: Promise<unknown>[] = [];
        setDemoTransport(async (url: unknown) => {
            const address = String(url);
            // The default 7-day range filters by date; "All Time" sends no filter.
            const ranged = address.includes('startDate');
            if (ranged) { pending.push(rangedGate); await rangedGate; }
            if (address.includes('/api/usage/summary')) return json(summary(ranged ? 777 : 42));
            if (address.includes('/summary')) return json({ total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 });
            if (address.includes('/model-costs')) return json({});
            return json([]);
        });

        render(<MonitoringPanel activeSection="overview" />);
        await user.click(await screen.findByRole('button', { name: 'All Time' }));
        expect(await screen.findByText('42')).toBeTruthy();

        // The 7-day read that was still on its way answers now.
        releaseRanged();
        await Promise.all(pending);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await waitFor(() => expect(screen.getByText('42')).toBeTruthy());
        expect(screen.queryByText('777')).toBeNull();
    });
});
