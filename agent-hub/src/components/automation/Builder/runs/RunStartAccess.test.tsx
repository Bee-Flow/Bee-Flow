import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withQueryClient } from '../../../../test/queryWrapper';
import { authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import RunRow from './RunRow';
import RunList from './RunList';
import RunDetailHeader from './RunDetailHeader';
import TestRunMenu from '../header/TestRunMenu';
import type { RunRowData } from '../../../../api/queries/automation/runs';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./GoldenControl', () => ({ default: () => null }));
vi.mock('./CompareWithMenu', () => ({ default: () => null }));

const HINT = 'You can view this automation but not start it. Ask the owner for run access.';

const failed = (over: Partial<RunRowData> = {}): RunRowData => ({
    id: 'run-fail', automationId: 'a1', status: 'error', startedAt: new Date().toISOString(), version: 3,
    stepsTotal: 4, stepsDone: 1,
    outcome: { code: 'stopped_at', params: { step: 'Read invoice', stepId: 'step-2', reasonCode: 'no_access', reason: 'no access', where: '/' } },
    ...over,
});

afterEach(cleanup);
beforeEach(() => { vi.mocked(authFetch).mockReset(); vi.mocked(toast.error).mockReset(); });

describe('RunRow: "try again"', () => {
    const renderRow = (run: RunRowData, onRetry = vi.fn()) => {
        render(<RunRow run={run} selected={false} first onOpen={vi.fn()} onFix={vi.fn()} onRetry={onRetry} onRemind={vi.fn()} />);
        return onRetry;
    };

    it('is disabled, with the reason, for a viewer', async () => {
        const onRetry = renderRow(failed({ canStart: false }));
        const btn = screen.getByRole('button', { name: 'try again' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('title')).toBe(HINT);
        await userEvent.setup().click(btn);
        expect(onRetry).not.toHaveBeenCalled();
    });

    it.each([[true], [undefined]])('is enabled when canStart is %s (a run-role user, an editor, an older server)', async (canStart) => {
        const onRetry = renderRow(failed({ canStart }));
        const btn = screen.getByRole('button', { name: 'try again' }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
        await userEvent.setup().click(btn);
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});

describe('RunList: a refused start', () => {
    it('says the friendly sentence for automation_run_forbidden, and the generic one for anything else', async () => {
        const user = userEvent.setup();
        const answer = (status: number, code: string | null) => Promise.resolve({ ok: false, status, json: async () => (code ? { error: 'raw', code } : {}) } as Response);
        vi.mocked(authFetch).mockImplementationOnce(() => answer(403, 'automation_run_forbidden'));
        render(withQueryClient(
            <RunList automationId="a1" runs={[failed()]} loading={false} failed={false} selectedRunId={null} onOpenRun={vi.fn()} />,
        ));
        await user.click(screen.getByRole('button', { name: 'try again' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(HINT));

        vi.mocked(authFetch).mockImplementationOnce(() => answer(500, null));
        await user.click(screen.getByRole('button', { name: 'try again' }));
        await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith('Could not start the run again.'));
    });
});

describe('RunDetailHeader: "Run again with this input"', () => {
    const renderHeader = (run: RunRowData) => {
        render(withQueryClient(<RunDetailHeader automationId="a1" run={run} onOpenRun={vi.fn()} onClose={vi.fn()} />));
        return screen.getByRole('button', { name: 'Run again with this input' }) as HTMLButtonElement;
    };

    it('is disabled, with the reason, for a viewer', () => {
        const btn = renderHeader(failed({ canStart: false }));
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('title')).toBe(HINT);
    });

    it('is enabled for a run-role user or an editor', () => {
        expect(renderHeader(failed({ canStart: true })).disabled).toBe(false);
    });
});

describe('TestRunMenu: "Run live"', () => {
    it('is disabled with the reason for a viewer, and starts nothing', async () => {
        const user = userEvent.setup();
        const onRunLive = vi.fn();
        render(<TestRunMenu onDryRun={vi.fn()} onRunLive={onRunLive} canRunLive={false} />);
        await user.click(screen.getByRole('button', { name: 'More ways to run' }));
        const item = screen.getByRole('menuitem', { name: /Run live/ }) as HTMLButtonElement;
        expect(item.disabled).toBe(true);
        expect(item.getAttribute('title')).toBe(HINT);
        await user.click(item);
        expect(onRunLive).not.toHaveBeenCalled();
    });

    it('stays usable for an editor, and by default', async () => {
        const user = userEvent.setup();
        const onRunLive = vi.fn();
        render(<TestRunMenu onDryRun={vi.fn()} onRunLive={onRunLive} />);
        await user.click(screen.getByRole('button', { name: 'More ways to run' }));
        await user.click(screen.getByRole('menuitem', { name: /Run live/ }));
        expect(onRunLive).toHaveBeenCalledTimes(1);
    });
});
