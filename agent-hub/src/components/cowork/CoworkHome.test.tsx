// The Cowork home (./CoworkHome.tsx): the composer first, the notices only when they hold, Needs you at most three
// with the rest behind "Show N more", Your tasks with their status and next run, Shared with you only when it has
// something, and Teamwork always, as one quiet row. The network is the seam (a recording fetch); no module is mocked.
import { act, screen, waitFor, within } from '@testing-library/react';
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
    it('does not navigate away from an unfinished sentence when the task finishes setup', async () => {
        const open = vi.fn();
        const ask = vi.fn();
        const trial = new TransformStream();
        const writer = trial.writable.getWriter();
        stubRecordingFetch(({url, method}) => {
            const path = new URL(url, 'http://x').pathname;
            if (path === '/api/cowork' && method === 'GET') return jsonResponse({schedules: [], maxSchedules: 10});
            if (path === '/api/cowork/compose') return jsonResponse({title: 'Inbox', repeatInterval: 'daily', timeOfDay: '09:00'});
            if (path === '/api/cowork' && method === 'POST') return jsonResponse({id: 'new', title: 'Inbox', setup: {steps: 'wanted'}});
            if (path === '/api/cowork/new/plan/make') return new Response(trial.readable, {headers: {'content-type': 'text/event-stream'}});
            return jsonResponse({});
        });
        renderWithClient(<CoworkHome guided onOpenTask={open} onOpenPanel={() => {}} onAskTask={ask} />);
        const user = userEvent.setup();
        const composer = screen.getByRole('textbox', {name: 'Ask Bee…'});
        await user.type(composer, 'Every day at 9, summarise my mail{Enter}');
        await user.click(await screen.findByRole('button', {name: 'Start'}));
        await screen.findByTestId('cowork-setup');
        await user.type(composer, 'How many messages');
        await act(async () => {
            await writer.write(new TextEncoder().encode('event: done\ndata: {"summary":"ok","state":{"automationId":"auto-1"}}\n\n'));
            await writer.close();
        });
        await screen.findByText('Your next message will go to “Inbox”.');
        expect(composer).toHaveValue('How many messages');
        expect(open).not.toHaveBeenCalled();
        await user.type(composer, ' did you read?{Enter}');
        expect(ask).toHaveBeenCalledWith('new', 'How many messages did you read?', undefined);
    });

    it('your tasks: title, status and the next run; a row opens the task', async () => {
        serve({ outcomes: { w1: 'nothing_to_do' } });
        const { onOpenTask } = home();
        const rows = await screen.findAllByTestId('cowork-task-row');
        expect(rows.map((r) => within(r).getByTestId('cowork-status').dataset.status)).toEqual(['nothing', 'failed', 'paused']);
        expect(rows[0]).toHaveTextContent('Target: Every meeting in it');
        expect(rows[0]).toHaveTextContent(/Next: (Today|Tomorrow), /);
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
    });

    it('teamwork is always there: for someone on no desk it says what it is for, and it opens the Teamwork page', async () => {
        serve();
        const { onOpenPanel } = home();
        expect(screen.getByRole('heading', { name: 'Teamwork' })).toBeInTheDocument();
        const entry = screen.getByTestId('cowork-teamwork');
        expect(entry).toHaveTextContent('Let your tasks work together with colleagues’ tasks');
        expect(entry).toHaveTextContent('Nothing is set up yet. Everyone keeps their own task and their own apps.');
        await userEvent.setup().click(entry);
        expect(onOpenPanel).toHaveBeenCalledWith({ kind: 'teamwork' });
    });

    it('the rows arrive one after another, six at most; the status is a flat label', async () => {
        serve();
        home();
        const rows = await screen.findAllByTestId('cowork-task-row');
        expect(rows.map((r) => r.parentElement?.className.match(/cowork-(enter|stagger-\d)/g)?.join(' '))).toEqual(['cowork-enter', 'cowork-enter cowork-stagger-1', 'cowork-enter cowork-stagger-2']);
        const status = within(rows[0]).getByTestId('cowork-status');
        expect(status).toHaveClass('cowork-swap');
        expect(status.className).not.toMatch(/transparent\)|shadow|animate-pulse/);
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

    it('shared with you once there is something in it, and teamwork names the desks; each opens its page', async () => {
        serve({
            shared: [{ id: 's1', ownerId: 'u2', ownerName: 'Sam Peters', title: 'Invoice reminders', role: 'viewer', lastStatus: 'success', lastRunAt: '2026-11-24T08:00:00.000Z', isActive: true }],
            desks: [{ id: 'd1', name: 'Supplier desk', isOwner: true }, { id: 'd2', name: 'Finance desk', isOwner: false }],
        });
        const { onOpenPanel } = home();
        const shared = await screen.findByTestId('cowork-shared');
        expect(shared).toHaveTextContent('From Sam Peters · you can see it');
        const user = userEvent.setup();
        await user.click(within(shared).getByRole('button'));
        expect(onOpenPanel).toHaveBeenCalledWith({ kind: 'shared', id: 's1' });
        const teamwork = await screen.findByRole('button', { name: /You work together in Supplier desk and Finance desk/ });
        expect(teamwork).toHaveTextContent('See who does what, or set up another.');
        await user.click(teamwork);
        expect(onOpenPanel).toHaveBeenCalledWith({ kind: 'teamwork' });
    });
});
