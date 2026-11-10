// Settings → Usage → Quality → Feedback. Pinned: the pager follows the report
// when a shorter range leaves fewer pages than the one that was open.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';
import type { RangeParams } from '@/utils/usageHelpers';
import OrgFeedbackPanel from './OrgFeedbackPanel';

const ALL_TIME: RangeParams = { days: null, startDate: null, endDate: null, interval: 'day' };
const ONE_DAY: RangeParams = { days: 1, startDate: '2026-11-08T00:00:00.000Z', endDate: '2026-11-09T00:00:00.000Z', interval: 'hour' };

const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, rating: 'up', agent_id: 'a1', comment: `comment-${i}` }));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { setDemoTransport(null); });

describe('OrgFeedbackPanel pager', () => {
    it('falls back to the last page when a shorter range has fewer entries', async () => {
        const user = userEvent.setup();
        setDemoTransport(async (url: unknown) => {
            const address = String(url);
            if (address.includes('/summary')) return json({ total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 });
            return json(entries(address.includes('startDate') ? 12 : 25));
        });
        const { rerender } = renderWithClient(<OrgFeedbackPanel rangeParams={ALL_TIME} />);
        expect(await screen.findByText(/comment-0\b/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await user.click(screen.getByRole('button', { name: 'Next page' }));
        expect(screen.getByText('3 / 3')).toBeTruthy();

        rerender(<OrgFeedbackPanel rangeParams={ONE_DAY} />);
        expect(await screen.findByText('2 / 2')).toBeTruthy();
        expect(screen.queryByText('No feedback entries')).toBeNull();
        expect(screen.getByText(/comment-11\b/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Previous page' }));
        expect(screen.getByText('1 / 2')).toBeTruthy();
    });
});
