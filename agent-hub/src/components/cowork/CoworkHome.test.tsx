// The Cowork home (./CoworkHome.tsx): the composer first, the notices only when they hold, Needs you at most three
// with the rest behind "Show N more", Your tasks with their status and next run, and Shared with you and Teamwork only
// when they have something. The network is the seam (a recording fetch); no module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import CoworkHome from './CoworkHome';
import type { CoworkItem } from '@/api/cowork.types';
import type { CoworkNeed } from '@/api/coworkNeedsYou';

const soon = new Date(Date.now() + 3 * 3_600_000).toISOString();
const ITEMS: CoworkItem[] = [
    { id: 'w1', title: 'Team meeting overview', prompt: 'Summarise', isActive: true, repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00', nextRunAt: soon, lastStatus: 'success', lastRunAt: '2026-11-23T08:00:00.000Z', runCount: 3 },
    { id: 'w2', title: 'Order radar', prompt: 'Watch orders', isActive: true, repeatInterval: 'daily', nextRunAt: soon, lastStatus: 'error', lastRunAt: '2026-11-24T07:00:00.000Z', runCount: 9 },
    { id: 'w3', title: 'Paused digest', prompt: 'Digest', isActive: false, repeatInterval: 'daily', lastStatus: 'success', lastRunAt: '2026-11-20T07:00:00.000Z', runCount: 2 },
];
const need = (kind: CoworkNeed['kind'], itemId: string, over: Partial<CoworkNeed> = {}): CoworkNeed => ({ kind, itemId, title: itemId, runId: `r-${kind}-${itemId}`, since: null, reason: null, plan: null, ...over });

interface Serve { needs?: CoworkNeed[]; budget?: number | null; readOnly?: boolean; shared?: unknown[]; desks?: unknown[]; outcomes?: Record<string, string> }
function serve({ needs = [], budget = null, readOnly = false, shared = [], desks = [], outcomes = {} }: Serve = {}) {
    return stubRecordingFetch(({ url }) => {
        const path = new URL(url, 'http://x').pathname;
        if (path === '/api/cowork') return jsonResponse({ schedules: ITEMS, maxSchedules: 10 });
        if (path === '/api/cowork/home') return jsonResponse({ how: { w1: { kind: 'plan', fixed: 3, ai: 1, ask: 0, deliver: 1, level: null, goal: { sentence: 'Every meeting in it', targetPercent: 100, met: null, total: null, period: null, measuredAt: null } } }, today: [], cost: { byCurrency: { EUR: 2 }, calls: 4 }, budget: budget === null ? null : { percent: budget }, outcomes });
        if (path === '/api/cowork/needs-you') return jsonResponse({ needs });
        if (path === '/api/cowork/policy/mine') return jsonResponse({ ceiling: 'on_its_own', readOnly, unattendedApps: null });
        if (path === '/api/cowork/shared') return jsonResponse({ items: shared });
        if (path === '/api/cowork/desks') return jsonResponse({ desks });
        if (path.startsWith('/api/cowork/desks/')) return jsonResponse({ desk: { id: 'd1', name: 'Supplier desk', isOwner: true, ownerName: 'Ann' }, members: [], roles: [], colleagues: [] });
        return jsonResponse({});
    });
}
afterEach(() => { vi.unstubAllGlobals(); });

const home = (onOpenTask = vi.fn(), onOpenPanel = vi.fn()) => {
    renderWithClient(<CoworkHome onOpenTask={onOpenTask} onOpenPanel={onOpenPanel} />);
    return { onOpenTask, onOpenPanel };
};

describe('CoworkHome', () => {
    it('your tasks: title, status and the next run; a row opens the task', async () => {
        serve({ outcomes: { w1: 'nothing_to_do' } });
        const { onOpenTask } = home();
        const rows = await screen.findAllByTestId('cowork-task-row');
        expect(rows.map((r) => within(r).getByTestId('cowork-status').dataset.status)).toEqual(['nothing', 'failed', 'paused']);
        expect(rows[0]).toHaveTextContent('Goal: Every meeting in it');
        expect(rows[0]).toHaveTextContent(/Next: (Today|Tomorrow), /);
        expect(rows[1]).toHaveTextContent('On hold');
        await userEvent.setup().click(rows[1]);
        expect(onOpenTask).toHaveBeenCalledWith('w2');
    });

    it('shows none of what the redesign took away: no hero, no Today, no cost line, no habits switch, no running tally, no Builder note', async () => {
        serve();
        home();
        await screen.findAllByTestId('cowork-task-row');
        for (const id of ['cowork-today', 'cowork-cost-month', 'cowork-habits', 'cowork-running-count', 'cowork-explainer', 'cowork-desks-setup']) expect(screen.queryByTestId(id)).toBeNull();
        expect(screen.queryByText(/AI this month/)).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Shared with you' })).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Teamwork' })).toBeNull();
    });

    it('needs you: at most three, the rest behind "Show N more"; their task is Failed or Needs you', async () => {
        serve({ needs: [need('review', 'w1'), need('sign_in', 'w2'), need('review', 'w3'), need('ai_failed', 'w1'), need('review', 'w2', { runId: 'x' })] });
        home();
        expect(await screen.findByRole('heading', { name: 'Needs you · 5' })).toBeInTheDocument();
        expect(screen.getAllByTestId('cowork-need-card')).toHaveLength(3);
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Show 2 more' }));
        expect(screen.getAllByTestId('cowork-need-card')).toHaveLength(5);
        await user.click(screen.getByRole('button', { name: 'Show fewer' }));
        expect(screen.getAllByTestId('cowork-need-card')).toHaveLength(3);
        const rows = screen.getAllByTestId('cowork-task-row');
        expect(within(rows[0]).getByTestId('cowork-status').dataset.status).toBe('failed');
    });

    it('the budget notice from 80% only, red once it is used up; and the read-only notice', async () => {
        const first = serve({ budget: 79 });
        home();
        await waitFor(() => expect(first.some((c) => c.url.includes('/api/cowork/home'))).toBe(true));
        await screen.findAllByTestId('cowork-task-row');
        expect(screen.queryByTestId('cowork-budget-notice')).toBeNull();
        vi.unstubAllGlobals();
        serve({ budget: 86, readOnly: true });
        home();
        expect(await screen.findByTestId('cowork-budget-notice')).toHaveTextContent('Your organisation has used 86% of this month’s AI budget.');
        expect(await screen.findByTestId('cowork-read-only-notice')).toHaveTextContent('Read-only mode is on for your organisation.');
    });

    it('shared with you and teamwork, once there is something in them; each opens its panel', async () => {
        serve({
            shared: [{ id: 's1', ownerId: 'u2', ownerName: 'Sam Peters', title: 'Invoice reminders', role: 'viewer', lastStatus: 'success', lastRunAt: '2026-11-24T08:00:00.000Z', isActive: true }],
            desks: [{ id: 'd1', name: 'Supplier desk', isOwner: true }],
        });
        const { onOpenPanel } = home();
        const shared = await screen.findByTestId('cowork-shared');
        expect(shared).toHaveTextContent('From Sam Peters · you can see it');
        const user = userEvent.setup();
        await user.click(within(shared).getByRole('button'));
        expect(onOpenPanel).toHaveBeenCalledWith({ kind: 'shared', id: 's1' });
        await user.click(within(await screen.findByTestId('cowork-teamwork')).getByRole('button', { name: /Supplier desk/ }));
        expect(onOpenPanel).toHaveBeenCalledWith({ kind: 'teamwork' });
    });
});
