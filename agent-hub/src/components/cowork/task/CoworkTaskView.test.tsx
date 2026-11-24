// The opened task (./CoworkTaskView.tsx) against a recording fetch, no module mocked: its steps in run order with the
// helper steps folded, Run now held back while something waits for the owner, Undo of a fix Cowork made by itself,
// Delete after an in-page confirm, and someone else's task read only.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkTaskView from './CoworkTaskView';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';

const ITEM = {
    id: 'w1', title: 'Weekly digest', prompt: 'Sum up the week.', isActive: true, repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00',
    nextRunAt: '2099-11-30T08:00:00.000Z', lastRunAt: '2026-11-23T08:00:00.000Z', lastStatus: 'success', runCount: 3, agentId: null,
};
const step = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, type: 'integration_action', kind: 'fixed', title, effect: 'reads', app: 'outlook', tool: 'x', readsOutsideText: false, depth: 0, ...over });
const PLAN = {
    automationId: 'a1',
    draft: {
        view: {
            trigger: 'schedule', makeUp: { fixed: 2, ai: 1, ask: 0, deliver: 1 },
            steps: [step('sum', 'Write the digest', { kind: 'ai', app: null }), step('read', 'Read the mail'), step('trim', 'Keep this week', { type: 'filter', helper: true, app: null }), step('tell', 'Tell me', { kind: 'deliver', effect: 'sends', app: null })],
            runOrder: ['read', 'trim', 'sum', 'tell'],
        },
        permissions: { v: 1, grants: [{ app: 'outlook', effect: 'reads', tools: ['x'] }], sends: 'owner', ai: true, outsideText: false }, findings: [], fingerprint: 'f'.repeat(64),
    },
    approved: { version: 2, fingerprint: 'f'.repeat(64), approvedAt: null, permissions: { v: 1, grants: [], sends: 'owner', ai: true, outsideText: false } },
    widens: [], upToDate: true,
};
const RUN = { id: 'r1', status: 'success', startedAt: '2026-11-23T08:00:00.000Z', result: '3 invoices are overdue.', producedOutput: true };
const AUTO_FIX = {
    id: 'pr-auto', kind: 'repair', reasonCode: 'reference_fixed', stepId: 'read', stepTitle: 'Read the mail', status: 'approved', fingerprint: 'f'.repeat(64),
    createdAt: null, decidedAt: '2026-11-24T08:00:00.000Z', changes: [], widens: [], replay: null, undoVersion: 1,
};

interface World { item?: unknown; needs?: unknown[]; proposals?: unknown[]; shared?: unknown }
let calls: RecordedCall[];

function serve(world: World = {}) {
    calls = stubRecordingFetch(({ url, method }) => {
        const path = new URL(url, 'http://x').pathname;
        if (method === 'DELETE' && path === '/api/cowork/w1') return jsonResponse({ success: true });
        if (method === 'POST') return jsonResponse({});
        if (path === '/api/cowork/w1') return world.item === null ? jsonResponse({ error: 'Forbidden' }, 403) : jsonResponse(world.item ?? ITEM);
        if (path === '/api/cowork/w1/plan') return jsonResponse(PLAN);
        if (path === '/api/cowork/w1/runs') return jsonResponse({ runs: [RUN], total: 1 });
        if (path === '/api/cowork/needs-you') return jsonResponse({ needs: world.needs ?? [] });
        if (path === '/api/cowork/w1/proposals') return jsonResponse({ proposals: world.proposals ?? [] });
        if (path === '/api/cowork/desks') return jsonResponse({ desks: [] });
        if (path === '/api/cowork/w1/start') return jsonResponse({ kind: 'schedule', after: null, datatableId: null, inFolder: null, hasAddress: false });
        if (path === '/api/cowork/w1/goal') return jsonResponse({ goal: null });
        if (path === '/api/cowork/shared/w1') return jsonResponse(world.shared ?? {});
        if (path === '/api/cowork/shared') return jsonResponse({ items: [{ id: 'w1', ownerName: 'Sam Peters', title: 'Stock check', role: 'viewer' }] });
        return jsonResponse({});
    });
}
afterEach(() => { vi.unstubAllGlobals(); });

function open(close = vi.fn()) {
    const props: CoworkSheetPanelProps = { panel: { kind: 'task', id: 'w1' }, user: null, close, open: vi.fn(), fillComposer: vi.fn() };
    renderWithClient(<CoworkTaskView {...props} />);
    return { close };
}

const sent = (method: string, path: string) => calls.find((c) => c.method === method && new URL(c.url, 'http://x').pathname === path);

describe('CoworkTaskView', () => {
    it('lists the steps in run order, with the helper step folded until asked for', async () => {
        serve();
        open();
        const steps = await screen.findByTestId('cowork-task-steps');
        await waitFor(() => expect(within(steps).getAllByTestId('cowork-task-step')).toHaveLength(3));
        expect(within(steps).getAllByTestId('cowork-task-step').map((li) => li.textContent)).toEqual([
            expect.stringContaining('Read the mail'), expect.stringContaining('Write the digest'), expect.stringContaining('Tell me'),
        ]);
        await userEvent.setup().click(within(steps).getByRole('button', { name: 'Show 1 helper step' }));
        expect(within(steps).getAllByTestId('cowork-task-step').map((li) => li.textContent?.split('Reads')[0])).toEqual([
            expect.stringContaining('Read the mail'), expect.stringContaining('Keep this week'), expect.stringContaining('Write the digest'), expect.stringContaining('Tell me'),
        ]);
    });

    it('keeps Run now off while something waits for the owner, and on otherwise', async () => {
        serve({ needs: [{ kind: 'sign_in', itemId: 'w1', title: 'Weekly digest', runId: null, since: null, reason: null, plan: null }] });
        open();
        await screen.findByTestId('cowork-need-card');
        expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
        vi.unstubAllGlobals();
    });

    it('runs now when nothing waits', async () => {
        serve();
        open();
        const run = await screen.findByRole('button', { name: 'Run now' });
        await waitFor(() => expect(run).toBeEnabled());
        await userEvent.setup().click(run);
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/run-now')).toBeTruthy());
    });

    it('Undo of a fix Cowork made by itself approves the version before it again', async () => {
        serve({ proposals: [AUTO_FIX] });
        open();
        const note = await screen.findByTestId('cowork-task-autofix');
        expect(note).toHaveTextContent("Fixed by itself on");
        expect(note).toHaveTextContent("'Read the mail' was reading the wrong field");
        await userEvent.setup().click(within(note).getByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/plan/restore')?.body).toEqual({ version: 1 }));
    });

    it('deletes only after the in-page confirm, then closes the sheet', async () => {
        serve();
        const { close } = open();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'More' }));
        await user.click(screen.getByRole('button', { name: 'Delete this task' }));
        expect(screen.getByTestId('cowork-task-delete-confirm')).toHaveTextContent("Delete 'Weekly digest'?");
        expect(sent('DELETE', '/api/cowork/w1')).toBeUndefined();
        await user.click(screen.getByRole('button', { name: 'Keep it' }));
        expect(screen.queryByTestId('cowork-task-delete-confirm')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Delete this task' }));
        await user.click(screen.getByRole('button', { name: 'Delete task' }));
        await waitFor(() => expect(close).toHaveBeenCalled());
        expect(sent('DELETE', '/api/cowork/w1')).toBeTruthy();
    });

    it('shows someone else\'s task read only: who shared it, its result, its runs, and no actions', async () => {
        serve({
            item: null,
            shared: { role: 'viewer', item: { id: 'w1', title: 'Stock check', prompt: 'Check the stock.', repeatInterval: 'daily', nextRunAt: null, lastStatus: 'success', isActive: true, triggerKind: 'schedule' }, runs: [{ id: 'r9', status: 'success', startedAt: '2026-11-23T08:00:00.000Z', result: 'All in stock.', durationMs: 900 }] },
        });
        open();
        const shared = await screen.findByTestId('cowork-task-shared');
        expect(await within(shared).findByTestId('cowork-task-shared-by')).toHaveTextContent('Shared by Sam Peters');
        expect(within(shared).getByTestId('cowork-task-result-text')).toHaveTextContent('All in stock.');
        for (const name of ['Run now', 'Pause', 'Edit', 'More']) expect(within(shared).queryByRole('button', { name })).toBeNull();
        expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    });
});
