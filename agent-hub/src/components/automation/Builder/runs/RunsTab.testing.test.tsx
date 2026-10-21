import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withQueryClient } from '../../../../test/queryWrapper';
import { authFetch } from '../../../../utils/helpers';
import RunsTab from './RunsTab';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../admin/Studio/Executions/useRunStream', () => ({ default: () => 'live' }));
vi.mock('../../../admin/Studio/Executions/ExecutionView', () => ({ default: () => <div /> }));
vi.mock('../OutputView', () => ({ default: () => <div /> }));

const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response);

const RUNS = [
    { id: 'run-new', status: 'success', startedAt: '2026-10-03T10:00:00Z', version: 4 },
    { id: 'run-old', status: 'success', startedAt: '2026-10-02T10:00:00Z', version: 3 },
];
const GOLDEN = {
    goldenId: 'g1', runId: 'run-old', label: 'A normal week', ignorePaths: ['createdAt'], createdAt: '2026-10-02T10:00:00Z', createdBy: 'u1',
    run: { status: 'success', startedAt: '2026-10-02T10:00:00Z', version: 3 },
    lastReplay: { status: 'changed', at: '2026-10-03T10:00:00Z', replayRunId: 'run-replay', summary: { changed: 1 }, errorCode: null },
};
const COMPARE = {
    a: { runId: 'run-old', status: 'success', mode: 'live', version: 3 }, b: { runId: 'run-replay', status: 'success', mode: 'dry_run', version: 4 },
    verdict: 'changed', summary: { same: 0, changed: 1, soft: 0, onlyA: 0, onlyB: 0, notComparable: 0 },
    steps: [{ key: 's#', stepId: 's', verdict: 'changed', changes: [{ path: 'total', change: 'changed', before: '1', after: '2' }] }],
    truncated: false,
};

let urls: string[] = [];

beforeEach(() => {
    urls = [];
    vi.mocked(authFetch).mockImplementation(((url: string) => {
        urls.push(url);
        if (/\/a1\/runs\?/.test(url)) return reply(200, { runs: RUNS, facets: {} });
        if (url.endsWith('/a1/goldens')) return reply(200, { goldens: [GOLDEN], limits: { max: 50 } });
        if (url.endsWith('/a1/form-scenarios')) return reply(200, { scenarios: [], limits: { max: 50 } });
        if (url.includes('/compare/')) return reply(200, COMPARE);
        if (url.endsWith('/steps')) return reply(200, { steps: [], definition: null });
        return reply(200, { run: RUNS[0] });
    }) as typeof authFetch);
});
afterEach(() => cleanup());

describe('Runs tab: Testing', () => {
    it('reads the scenarios only once the Testing section is opened', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<RunsTab automationId="a1" />));
        await screen.findAllByText(/Finished/);
        expect(urls.some(u => u.endsWith('/form-scenarios'))).toBe(false);
        await user.click(screen.getByRole('tab', { name: 'Testing' }));
        await waitFor(() => expect(urls.some(u => u.endsWith('/a1/form-scenarios'))).toBe(true));
    });

    it('opens a golden against its replay in the run pane, and back', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<RunsTab automationId="a1" />));
        await user.click(await screen.findByRole('tab', { name: 'Testing' }));
        expect(await screen.findByRole('region', { name: 'Golden runs' })).toBeTruthy();
        expect(screen.getByRole('region', { name: 'Form scenarios' })).toBeTruthy();
        await user.click(await screen.findByRole('button', { name: 'See differences' }));

        expect(await screen.findByText('Compare runs')).toBeTruthy();
        expect(urls).toContain('/api/automation/runs/run-old/compare/run-replay');
        expect(screen.getByText(/The replay verdict leaves out: createdAt/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Back to the run' }));
        await waitFor(() => expect(screen.queryByText('Compare runs')).toBeNull());
    });

    it('opens the compare from a run with "Compare with…"', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<RunsTab automationId="a1" />));
        await user.click(await screen.findByRole('button', { name: 'Compare with…' }));
        const pane = screen.getByRole('group', { name: 'Compare with…' });
        await waitFor(() => expect((within(pane).getByRole('combobox') as HTMLSelectElement).value).toBe('run-old'));
        await user.click(within(pane).getByRole('button', { name: 'Compare' }));
        expect(await screen.findByText('Compare runs')).toBeTruthy();
        expect(urls).toContain('/api/automation/runs/run-new/compare/run-old');
    });
});
