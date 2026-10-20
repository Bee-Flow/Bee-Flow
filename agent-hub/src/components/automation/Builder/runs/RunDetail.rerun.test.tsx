import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withQueryClient } from '../../../../test/queryWrapper';
import { authFetch } from '../../../../utils/helpers';
import useConfirm from '../../../shared/useConfirm';
import { BuilderConfirmProvider } from '../BuilderConfirmContext';
import RunDetail from './RunDetail';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../OutputView', () => ({ default: () => <div /> }));

const STEPS = {
    steps: [
        { runId: 'run-1', stepId: 'read', stepType: 'action', status: 'success', output: { rows: 3 } },
        { runId: 'run-1', stepId: 'mail', stepType: 'action', status: 'success', output: { sent: true } },
    ],
    definition: { steps: [{ id: 'read', label: 'Read the list' }, { id: 'mail', label: 'Send the summary' }] },
};

const plan = (over: Record<string, unknown> = {}) => ({
    seedRunId: 'run-1', willExecute: ['mail'], missingUpstream: [], sideEffects: [], requiresConfirm: false, replayStale: [], ...over,
});
const MAIL_EFFECT = { stepId: 'mail', type: 'action', tool: 'gmail_send', label: 'Send the summary', effect: 'sends' };

type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[] = [];
let planBody: unknown;
let postResult: { status: number; body: unknown };
let runStatus = 'success';

const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response);

/** The builder's confirm, as BuilderShell mounts it. */
function Shell({ children }: { children: React.ReactNode }) {
    const { confirm, confirmDialog } = useConfirm();
    return <BuilderConfirmProvider value={confirm as never}>{children}{confirmDialog}</BuilderConfirmProvider>;
}

function open(onOpenRun = vi.fn()) {
    render(withQueryClient(
        <Shell>
            <RunDetail
                automationId="a1" runId="run-1" seed={{ id: 'run-1', status: 'success' }} active
                selectedStepId="mail" onSelectStep={vi.fn()} onOpenRun={onOpenRun} onViewCanvas={vi.fn()} onClose={vi.fn()}
            />
        </Shell>,
    ));
    return onOpenRun;
}

beforeEach(() => {
    calls = [];
    runStatus = 'success';
    planBody = { rerunPlan: plan() };
    postResult = { status: 200, body: { run: { id: 'run-2' }, steps: [], rerunPlan: plan() } };
    vi.mocked(authFetch).mockImplementation(((url: string, init?: RequestInit) => {
        const method = init?.method || 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.includes('/rerun-plan')) return reply(200, planBody);
        if (method === 'POST' && url.endsWith('/steps/mail/run')) return reply(postResult.status, postResult.body);
        if (url.endsWith('/runs/run-1/steps')) return reply(200, STEPS);
        return reply(200, { run: { id: 'run-1', status: runStatus } });
    }) as typeof authFetch);
});
afterEach(() => cleanup());

const rerunButton = () => screen.findByRole('button', { name: 'Re-run from this step' });
const posts = () => calls.filter(c => c.method === 'POST');

describe('Re-run from this step', () => {
    it('asks the server for the plan with the run, then runs from the step with that run\'s data', async () => {
        const user = userEvent.setup();
        const onOpenRun = open();
        await user.click(await rerunButton());
        await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith('run-2'));
        const planCall = calls.find(c => c.url.includes('/rerun-plan'));
        expect(planCall?.url).toBe('/api/automation/a1/steps/mail/rerun-plan?seedRunId=run-1&mode=from');
        expect(posts()).toHaveLength(1);
        expect(posts()[0].url).toBe('/api/automation/a1/steps/mail/run');
        expect(posts()[0].body).toEqual({ mode: 'from', seedRunId: 'run-1', confirmSideEffects: false });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('lists the steps that send or write and waits for a yes', async () => {
        planBody = { rerunPlan: plan({ sideEffects: [MAIL_EFFECT], requiresConfirm: true }) };
        const user = userEvent.setup();
        const onOpenRun = open();
        await user.click(await rerunButton());
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Run these steps again?')).toBeTruthy();
        expect(dialog.textContent).toContain('Send the summary');
        expect(dialog.textContent).toContain('sends something');
        expect(posts()).toHaveLength(0);

        await user.click(within(dialog).getByRole('button', { name: 'Re-run anyway' }));
        await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith('run-2'));
        expect(posts()[0].body).toEqual({ mode: 'from', seedRunId: 'run-1', confirmSideEffects: true });
    });

    it('runs nothing when the person cancels', async () => {
        planBody = { rerunPlan: plan({ sideEffects: [MAIL_EFFECT], requiresConfirm: true }) };
        const user = userEvent.setup();
        const onOpenRun = open();
        await user.click(await rerunButton());
        await user.click(await screen.findByTestId('confirm-dialog-cancel'));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(posts()).toHaveLength(0);
        expect(onOpenRun).not.toHaveBeenCalled();
    });

    it('explains a run that lacks the data the step needs (409 seed_missing_upstream)', async () => {
        postResult = { status: 409, body: { error: 'x', code: 'seed_missing_upstream', details: { stepIds: ['read'] } } };
        const user = userEvent.setup();
        const onOpenRun = open();
        await user.click(await rerunButton());
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('no recorded output for Read the list');
        expect(alert.textContent).toContain('Pick a run that got that far');
        expect(onOpenRun).not.toHaveBeenCalled();
    });

    it('says the same when the plan already shows the gap, without starting a run', async () => {
        planBody = { rerunPlan: plan({ missingUpstream: ['read'] }) };
        const user = userEvent.setup();
        open();
        await user.click(await rerunButton());
        expect((await screen.findByRole('alert')).textContent).toContain('no recorded output for Read the list');
        expect(posts()).toHaveLength(0);
    });

    it('explains a dry run as the source', async () => {
        vi.mocked(authFetch).mockImplementation(((url: string) => {
            if (url.includes('/rerun-plan')) return reply(409, { error: 'x', code: 'seed_run_synthetic' });
            return reply(200, url.endsWith('/steps') ? STEPS : { run: { id: 'run-1', status: 'success' } });
        }) as typeof authFetch);
        const user = userEvent.setup();
        open();
        await user.click(await rerunButton());
        expect((await screen.findByRole('alert')).textContent).toContain('dry run has no real data');
    });

    it('is not offered while the run is still going', async () => {
        runStatus = 'running';
        open();
        await screen.findByRole('button', { name: /Send the summary/ });
        expect(screen.queryByRole('button', { name: 'Re-run from this step' })).toBeNull();
    });
});
