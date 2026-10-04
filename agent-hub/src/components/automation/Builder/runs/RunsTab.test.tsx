import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withQueryClient } from '../../../../test/queryWrapper';
import { authFetch } from '../../../../utils/helpers';
import RunsTab from './RunsTab';
import { runListQuery, facetCounts, retriedRunId } from '../../../../api/queries/automation/runs';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The live stream and the canvas view are other components' business.
vi.mock('../../../admin/Studio/Executions/useRunStream', () => ({ default: () => 'live' }));
vi.mock('../../../admin/Studio/Executions/ExecutionView', () => ({ default: () => <div data-testid="canvas-view" /> }));
vi.mock('../OutputView', () => ({ default: ({ value }: { value: unknown }) => <pre data-testid="output">{JSON.stringify(value)}</pre> }));

const today = new Date();
const at = (h: number, m: number, dayOffset = 0) => {
    const d = new Date(today);
    d.setDate(d.getDate() - dayOffset);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
};

const RUNS = [
    {
        id: 'run-ok', status: 'success', startedAt: at(10, 55), durationMs: 8900, version: 5, isTest: true,
        howStarted: 'manual', startedBy: { id: 'u1', name: 'admin' }, stepsTotal: 2, stepsDone: 2,
        outcome: { code: 'success', params: { step: 'List files', stepId: 'step-1', kind: 'list', count: 23, noun: 'files', where: '/' } },
    },
    {
        id: 'run-wait', status: 'awaiting_approval', startedAt: at(9, 12), version: 4, stepsTotal: 4, stepsDone: 2, approvalId: 'ap-1',
        outcome: { code: 'waiting_approval', params: { who: 'S. de Boer' } },
    },
    {
        id: 'run-fail', status: 'error', startedAt: at(8, 54, 2), version: 3, stepsTotal: 4, stepsDone: 1,
        triggerPayload: { fileName: 'Invoice-2026-001.pdf' },
        outcome: { code: 'stopped_at', params: { step: 'Read invoice', stepId: 'step-2', reasonCode: 'no_access', reason: 'no access to /Invoices', where: '/Invoices' } },
    },
];

type Call = { url: string; method: string; body?: string };
let calls: Call[] = [];

function respond(body: unknown, ok = true) {
    return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body });
}

beforeEach(() => {
    calls = [];
    vi.mocked(authFetch).mockImplementation(((url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method || 'GET', body: init?.body as string | undefined });
        if (/\/a1\/runs\?/.test(url)) {
            const params = new URL(`http://x${url}`).searchParams;
            const status = params.get('status');
            let runs = status === 'error' ? RUNS.filter(r => r.status === 'error') : RUNS;
            if (params.get('tests') === 'exclude') runs = runs.filter(r => !r.isTest);
            const facets = params.get('cursor') ? undefined : { all: 4, failed: 1, waiting: 1, running: 0, byStatus: { success: 2, error: 1, awaiting_approval: 1 } };
            return respond({ runs, nextCursor: null, myRole: 'owner', onlyMine: false, ...(facets ? { facets } : {}) });
        }
        if (url.endsWith('/steps')) {
            return respond({
                steps: [{ stepId: 'step-1', status: 'success', durationMs: 8700, input: { folder: '/' }, output: { count: 23, files: [{ name: 'Documents' }] } }],
                definition: { steps: [{ id: 'step-1', label: 'List files in a folder' }] },
            });
        }
        if (/\/runs\/[^/]+$/.test(url)) {
            const id = url.split('/').pop();
            return respond({ run: RUNS.find(r => r.id === id) || { id, status: 'success' } });
        }
        if (url.includes('/retry')) return respond({ accepted: true, runId: 'run-new', run: { id: 'run-new' } });
        if (url.includes('/remind')) return respond({ reminded: true, recipients: 1 });
        return respond({});
    }) as typeof authFetch);
});
afterEach(cleanup);

function renderTab(props: Partial<React.ComponentProps<typeof RunsTab>> = {}) {
    const onRunStateChange = vi.fn();
    const onOpenEditor = vi.fn();
    render(withQueryClient(
        <RunsTab automationId="a1" active onRunStateChange={onRunStateChange} onOpenEditor={onOpenEditor} {...props} />,
    ));
    return { onRunStateChange, onOpenEditor };
}

describe('RunsTab: the list', () => {
    it('renders nothing and fetches nothing until first shown', () => {
        renderTab({ active: false });
        expect(calls).toHaveLength(0);
    });

    it('groups runs per day with a sentence, steps, how and version', async () => {
        renderTab();
        const list = await screen.findByRole('list', { name: 'Runs' });
        expect(within(list).getByText('Today')).toBeTruthy();
        const ok = list.querySelector('[data-run-id="run-ok"]') as HTMLElement;
        expect(within(ok).getByText('23 files found in the main folder')).toBeTruthy();
        expect(ok.textContent).toContain('2 of 2 steps · 8.9 s · manually by admin');
        expect(within(ok).getByText('test')).toBeTruthy();
        expect(within(ok).getByText('v5')).toBeTruthy();
        const fail = list.querySelector('[data-run-id="run-fail"]') as HTMLElement;
        expect(within(fail).getByText('Stopped at "Read invoice": no access to /Invoices')).toBeTruthy();
        expect(fail.textContent).toContain('Invoice-2026-001.pdf');
    });

    it('shows facet counts and filters by status', async () => {
        const user = userEvent.setup();
        renderTab();
        const failed = await screen.findByRole('tab', { name: /Failed\s*1/ });
        expect(screen.getByRole('tab', { name: /All\s*4/ })).toBeTruthy();
        await user.click(failed);
        await waitFor(() => expect(calls.some(c => c.url.includes('status=error'))).toBe(true));
        await waitFor(() => expect(document.querySelector('[data-run-id="run-ok"]')).toBeNull());
    });

    it('hides test runs when the switch is off', async () => {
        const user = userEvent.setup();
        renderTab();
        await waitFor(() => expect(document.querySelector('[data-run-id="run-ok"]')).not.toBeNull());
        await user.click(screen.getByRole('switch', { name: 'Show test runs' }));
        await waitFor(() => expect(calls.some(c => c.url.includes('/a1/runs?') && c.url.includes('tests=exclude'))).toBe(true));
        await waitFor(() => expect(document.querySelector('[data-run-id="run-ok"]')).toBeNull());
    });

    it('Fix opens the editor on the step that stopped the run', async () => {
        const user = userEvent.setup();
        const { onOpenEditor } = renderTab();
        await user.click(await screen.findByRole('button', { name: 'Fix' }));
        await waitFor(() => expect(onOpenEditor).toHaveBeenCalledWith('step-2'));
    });

    it('try again starts the run again and opens the new run', async () => {
        const user = userEvent.setup();
        const { onRunStateChange } = renderTab();
        await user.click(await screen.findByRole('button', { name: 'try again' }));
        await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/a1/runs/run-fail/retry'))).toBe(true));
        await waitFor(() => expect(onRunStateChange).toHaveBeenCalledWith({ runId: 'run-new', stepId: null }, { replace: false }));
    });

    it('send reminder nudges the pending approval the row names', async () => {
        const user = userEvent.setup();
        renderTab();
        await user.click(await screen.findByRole('button', { name: 'send reminder' }));
        await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/approvals/ap-1/remind'))).toBe(true));
        expect(calls.some(c => c.url.includes('/approvals?'))).toBe(false);
    });

    it('facet counts come from the automation list, not the user-wide facets route', async () => {
        renderTab({});
        await screen.findByRole('tab', { name: /Failed\s*1/ });
        expect(calls.some(c => c.url.includes('/_runs/facets'))).toBe(false);
        expect(calls.some(c => c.url.includes('/a1/runs?limit=1'))).toBe(true);
    });

});

describe('RunsTab: search and the open run', () => {
    it('a pasted run link opens that run instead of searching', async () => {
        const user = userEvent.setup();
        const { onRunStateChange } = renderTab();
        const box = await screen.findByRole('searchbox', { name: 'Search runs' });
        await user.click(box);
        await user.paste('https://x.test/app/studio?view=runs&run=run-abc123');
        expect(onRunStateChange).toHaveBeenCalledWith({ runId: 'run-abc123', stepId: null }, { replace: false });
        expect(calls.some(c => c.url.includes('q='))).toBe(false);
    });

    it('opens the newest run on the right with its timeline and output', async () => {
        renderTab();
        const detail = await screen.findByRole('region', { name: 'Run' });
        expect(await within(detail).findByText('List files in a folder')).toBeTruthy();
        expect(within(detail).getByText('What happened')).toBeTruthy();
        expect(within(detail).getByText('Got in')).toBeTruthy();
        expect(within(detail).getByText('Passed on')).toBeTruthy();
        expect(within(detail).getByTestId('output').textContent).toContain('Documents');
    });

    it('Open in editor and View on the canvas', async () => {
        const user = userEvent.setup();
        const { onOpenEditor } = renderTab();
        const detail = await screen.findByRole('region', { name: 'Run' });
        await user.click(await within(detail).findByRole('button', { name: /Open in editor/ }));
        expect(onOpenEditor).toHaveBeenCalledWith(null);
        await user.click(await within(detail).findByRole('button', { name: /View on the canvas/ }));
        expect(await screen.findByTestId('canvas-view')).toBeTruthy();
    });
});

describe('runs query helpers', () => {
    it('builds the list query from the filters', () => {
        const q = runListQuery({ status: 'waiting', period: 24, q: ' invoice ', showTests: false }, Date.parse('2026-09-28T12:00:00Z'));
        const p = new URLSearchParams(q.slice(1));
        expect(p.get('status')).toBe('awaiting_approval,awaiting_confirm,awaiting_form');
        expect(p.get('since')).toBe('2026-09-27T12:00:00.000Z');
        expect(p.get('tests')).toBe('exclude');
        expect(p.get('mode')).toBeNull();
        expect(p.get('q')).toBe('invoice');
        expect(runListQuery({ status: 'all', period: 0, q: '', showTests: true })).toBe('?limit=100');
    });
    it('folds status facets into the four segments', () => {
        expect(facetCounts({ success: 3, error: 1, awaiting_form: 2, queued: 1 })).toEqual({ all: 7, failed: 1, waiting: 2, running: 1 });
    });
    it('reads the retry answer', () => {
        expect(retriedRunId({ run: { id: 'x' } })).toBe('x');
        expect(retriedRunId({ pending: true })).toBeNull();
    });
});
