// AI Monitor pages in the URL: admin/monitoring/<page>, bare admin/monitoring
// is Overview; the section list navigates, Refresh reloads Terminations too.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import MonitoringPanel from './index';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function stub(seen: string[] = []) {
    setDemoTransport(async (url: unknown) => {
        const address = String(url);
        seen.push(address);
        if (address.includes('/api/terminations')) return json({ total: 0, by_type: {}, rows: [] });
        if (address.includes('/api/usage/summary')) return json({ total_calls: 3, total_tokens: 0, total_estimated_cost: 0, total_billed_cost: 0, avg_duration_ms: 0 });
        if (address.includes('/summary')) return json({ total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 });
        if (address.includes('/model-costs')) return json({});
        return json([]);
    });
}

afterEach(() => { setDemoTransport(null); });

describe('MonitoringPanel pages', () => {
    it('opens on Overview for a bare admin/monitoring and marks it current', async () => {
        stub();
        render(<MonitoringPanel />);
        const nav = screen.getByRole('navigation', { name: 'AI Monitor' });
        expect(within(nav).getByRole('button', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
        expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toBeTruthy();
        expect(await screen.findByLabelText('Total Calls: 3')).toBeTruthy();
    });

    it('shows the page the URL names and navigates to another one by its URL', async () => {
        stub();
        const onNavigate = vi.fn();
        const user = userEvent.setup();
        render(<MonitoringPanel activeSection="activity" onNavigate={onNavigate} />);
        const nav = screen.getByRole('navigation', { name: 'AI Monitor' });
        expect(within(nav).getByRole('button', { name: 'Activity Log' }).getAttribute('aria-current')).toBe('page');
        expect(screen.getByRole('heading', { level: 2, name: 'Activity Log' })).toBeTruthy();
        await user.click(within(nav).getByRole('button', { name: 'Terminations' }));
        expect(onNavigate).toHaveBeenCalledWith('admin/monitoring/terminations');
    });

    it('falls back to Overview for an unknown page', () => {
        stub();
        render(<MonitoringPanel activeSection="nope" />);
        expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toBeTruthy();
    });

    it('reloads the terminations when Refresh is pressed', async () => {
        const seen: string[] = [];
        stub(seen);
        const user = userEvent.setup();
        render(<MonitoringPanel activeSection="terminations" />);
        const reads = () => seen.filter(u => u.includes('/api/terminations/summary')).length;
        await waitFor(() => expect(reads()).toBe(1));
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(reads()).toBe(2));
    });
});

describe('MonitoringPanel server-wide pages', () => {
    it('hides Feedback from an organisation admin, also by deep link', () => {
        stub();
        render(<MonitoringPanel activeSection="feedback" user={{ isAdmin: false, role: 'user' }} />);
        const nav = screen.getByRole('navigation', { name: 'AI Monitor' });
        expect(within(nav).queryByRole('button', { name: 'Feedback' })).toBeNull();
        expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toBeTruthy();
    });

    it('shows Feedback to a platform admin', () => {
        stub();
        render(<MonitoringPanel activeSection="feedback" user={{ isAdmin: true }} />);
        const nav = screen.getByRole('navigation', { name: 'AI Monitor' });
        expect(within(nav).getByRole('button', { name: 'Feedback' })).toBeTruthy();
    });
});
