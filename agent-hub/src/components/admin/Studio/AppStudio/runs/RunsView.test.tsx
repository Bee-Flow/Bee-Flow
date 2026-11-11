import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RunsView from './RunsView';
import type { RunPage, RunSummary, RunStep, RunsApi } from './runsApi';
import { renderWithClient } from '@/test/render';

/**
 * The Runs overview: the filters become the list request, a failed run shows its reason, a row
 * opens its steps with durations and the AI tokens and cost, and older runs load on request.
 * The api is handed in.
 */

const RUN = (over: Partial<RunSummary> = {}): RunSummary => ({
    id: 'sar_1', actionId: 'act_save', origin: 'click', status: 'error', endedBy: 'client', draft: false, dryRun: false,
    definitionVersion: 3, startedAt: '2026-11-04T10:00:00.000Z', endedAt: '2026-11-04T10:00:01.000Z', durationMs: 1200,
    stepCount: 2, failedSteps: 1, handledErrors: 0, truncated: false, tracked: true,
    error: 'Record r1 was not found', errorCode: 'not_found', errorStep: { path: 'steps[2]' },
    ai: { calls: 1, promptTokens: 120, completionTokens: 30, costByCurrency: { USD: 0.0012 } },
    actor: { kind: 'user', isYou: false, userId: 'u2', name: 'Vera Viewer' }, ...over,
});
const STEPS: RunStep[] = [
    { seq: 1, path: 'steps[0]', kind: 'ai_generate', actionId: 'act_save', stepIndex: 0, iteration: null, status: 'ok', durationMs: 840, startedAt: null, error: null, errorCode: null, attempts: null, handled: false, mocked: false, ai: { calls: 1, promptTokens: 120, completionTokens: 30, model: 'claude-x', tier: 'smart', cost: 0.0012, currency: 'USD' } },
    { seq: 2, path: 'steps[2]', kind: 'update_record', actionId: 'act_save', stepIndex: 2, iteration: null, status: 'error', durationMs: 12, startedAt: null, error: 'Record r1 was not found', errorCode: 'not_found', attempts: 2, handled: false, mocked: false, ai: null },
];

let api: RunsApi & { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

beforeEach(() => {
    cleanup();
    api = {
        list: vi.fn(async (_app: string, _f: unknown, cursor: string | null): Promise<RunPage> => (cursor
            ? { runs: [RUN({ id: 'sar_2', status: 'success', error: null, actionId: 'act_old' })], nextCursor: null, retentionDays: 30 }
            : { runs: [RUN()], nextCursor: 'c1', retentionDays: 30, actors: { users: [{ userId: 'u2', name: 'Vera Viewer', runs: 1 }], visitors: true, system: false } })),
        get: vi.fn(async () => ({ run: RUN(), steps: STEPS })),
    };
});

describe('<RunsView>', () => {
    it('lists runs with who, status and the reason of a failure; people runs only by default', async () => {
        renderWithClient(<RunsView appId="app1" actionIds={['act_save', 'act_old']} api={api} />);
        const row = await screen.findByTestId('run-row');
        expect(within(row).getByText('act_save')).toBeTruthy();
        expect(row.textContent).toContain('Vera Viewer');
        expect(row.textContent).toContain('Failed');
        expect(row.textContent).toContain('Record r1 was not found');
        expect(row.textContent).toContain('1.2 s');
        expect(api.list).toHaveBeenCalledWith('app1', { origin: 'click,public,background,mailbox_hook,trigger' }, null);
        expect(screen.getByTestId('runs-retention').textContent).toContain('30 days');
    });

    it('the filters become the request', async () => {
        const user = userEvent.setup();
        renderWithClient(<RunsView appId="app1" actionIds={['act_save', 'act_old']} api={api} />);
        await screen.findByTestId('run-row');
        await user.selectOptions(screen.getByLabelText('Action'), 'act_save');
        await user.selectOptions(screen.getByLabelText('Status'), 'error');
        await user.selectOptions(screen.getByLabelText('Who'), 'u2');
        await user.click(screen.getByLabelText('Include tests and MCP runs'));
        await waitFor(() => expect(api.list).toHaveBeenLastCalledWith('app1', { actionId: 'act_save', status: 'error', user: 'u2' }, null));
    });

    it('"Only runs a trigger started" asks for the trigger origin alone', async () => {
        renderWithClient(<RunsView appId="app1" actionIds={['act_save']} api={api} />);
        await screen.findByTestId('run-row');
        await userEvent.setup().click(screen.getByLabelText('Only runs a trigger started'));
        await waitFor(() => expect(api.list).toHaveBeenLastCalledWith('app1', { origin: 'trigger' }, null));
    });

    it('a run opens its steps with durations, the error and the AI tokens and cost', async () => {
        const user = userEvent.setup();
        renderWithClient(<RunsView appId="app1" actionIds={['act_save']} api={api} />);
        await user.click(await screen.findByRole('button', { name: 'act_save' }));
        const steps = await screen.findAllByTestId('run-step');
        expect(api.get).toHaveBeenCalledWith('app1', 'sar_1');
        expect(steps).toHaveLength(2);
        expect(within(steps[0]).getByTestId('run-step-duration').textContent).toBe('840 ms');
        expect(within(steps[0]).getByTestId('run-step-ai').textContent).toContain('claude-x');
        expect(within(steps[0]).getByTestId('run-step-ai').textContent).toContain('120 in / 30 out tokens');
        expect(within(steps[0]).getByTestId('run-step-ai').textContent).toContain('$0.0012');
        expect(within(steps[1]).getByTestId('run-step-error').textContent).toBe('Record r1 was not found (not_found)');
        expect(steps[1].textContent).toContain('2 attempts');
        await user.click(screen.getByRole('button', { name: 'Back to all runs' }));
        expect(await screen.findByTestId('runs-view')).toBeTruthy();
    });

    it('older runs load on request', async () => {
        const user = userEvent.setup();
        renderWithClient(<RunsView appId="app1" actionIds={[]} api={api} />);
        await screen.findByTestId('run-row');
        await user.click(screen.getByRole('button', { name: 'Show older runs' }));
        await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));
        expect(api.list).toHaveBeenLastCalledWith('app1', expect.anything(), 'c1');
        expect(screen.queryByRole('button', { name: 'Show older runs' })).toBeNull();
    });

    it('no runs yet says so', async () => {
        api.list.mockResolvedValue({ runs: [], nextCursor: null, retentionDays: 0 });
        renderWithClient(<RunsView appId="app1" actionIds={[]} api={api} />);
        expect(await screen.findByTestId('runs-empty')).toBeTruthy();
        expect(screen.getByTestId('runs-retention').textContent).toContain('until the app is deleted');
    });

    it('a run on hold shows as such and can be cancelled from its detail; the log is read again after', async () => {
        const user = userEvent.setup();
        const held = RUN({ origin: 'background', status: 'paused', error: null, errorCode: null, errorStep: null, endedAt: null, durationMs: null, failedSteps: 0, waiting: { kind: 'approval', wakeAt: null, waitingFor: { kind: 'user', name: 'Ann' } } });
        api.list.mockResolvedValue({ runs: [held], nextCursor: null, retentionDays: 30 });
        api.get.mockResolvedValueOnce({ run: held, steps: [] }).mockResolvedValue({ run: { ...held, status: 'cancelled' }, steps: [] });
        const cancel = vi.fn(async () => ({ status: 'cancelled' }));
        renderWithClient(<RunsView appId="app1" actionIds={['act_save']} api={{ ...api, cancel }} />);
        expect((await screen.findByTestId('run-row')).textContent).toContain('On hold');
        expect(Array.from(screen.getByLabelText('Status').querySelectorAll('option')).map((o) => o.value)).toContain('paused');
        await user.click(screen.getByRole('button', { name: 'act_save' }));
        expect((await screen.findByTestId('run-detail-waiting')).textContent).toBe('Waiting for approval by Ann');
        await user.click(await screen.findByRole('button', { name: 'Cancel run' }));
        expect(cancel).toHaveBeenCalledWith('app1', 'sar_1');
        await waitFor(() => expect(screen.getByTestId('run-detail-status').textContent).toBe('Cancelled'));
        expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
    });

    it('only a server run that is still going offers Cancel: not a click run, not an ended run', async () => {
        const user = userEvent.setup();
        const cancel = vi.fn(async () => ({ status: 'cancelled' }));
        api.get.mockResolvedValue({ run: RUN({ origin: 'click', status: 'running', error: null }), steps: [] });
        renderWithClient(<RunsView appId="app1" actionIds={['act_save']} api={{ ...api, cancel }} />);
        await user.click(await screen.findByRole('button', { name: 'act_save' }));
        await screen.findByTestId('run-detail');
        expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
    });
});
