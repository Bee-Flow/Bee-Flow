import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ExecutionRow from './ExecutionRow';
import type { RunLogRow } from './runLogSentence';

/**
 * The ⋯ menu offers Stop for a run that WAITS (pauses F6, run-watch F9): a run
 * paused on a form page or an approval has nothing executing, but the server
 * closes it without an answer. A waiting test run is discarded, and says so.
 */

type Api = React.ComponentProps<typeof ExecutionRow>['api'];

const run = (over: Partial<RunLogRow> = {}): RunLogRow => ({
    id: 'r1', automationId: 'a1', status: 'awaiting_form', mode: 'live', startedAt: '2026-11-03T10:00:00.000Z', ...over,
});

function renderRow(row: RunLogRow) {
    const cancelRun = vi.fn().mockResolvedValue({});
    const patchRow = vi.fn();
    const api = { cancelRun, retryRun: vi.fn(), approveRun: vi.fn(), approveStep: vi.fn() } as unknown as Api;
    render(<ExecutionRow run={row} isGlobal api={api} patchRow={patchRow} refresh={vi.fn()} onOpen={vi.fn()} />);
    return { cancelRun, patchRow };
}

afterEach(() => cleanup());

describe('ExecutionRow — stopping a waiting run', () => {
    it('a production run waiting on a form page can be stopped, addressing its live leg', async () => {
        const user = userEvent.setup();
        const { cancelRun, patchRow } = renderRow(run({ status: 'awaiting_form', journeyRunId: 'r9' }));
        await user.click(screen.getByTitle('Actions'));
        await user.click(screen.getByRole('button', { name: 'Stop it' }));
        await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('r9'));
        expect(patchRow).toHaveBeenCalledWith('r1', { status: 'cancelled' });
    });

    it('a waiting TEST run is discarded, on a form page and on an approval', async () => {
        const user = userEvent.setup();
        for (const status of ['awaiting_form', 'awaiting_approval']) {
            cleanup();
            const { cancelRun } = renderRow(run({ status, isTest: true }));
            await user.click(screen.getByTitle('Actions'));
            await user.click(screen.getByRole('button', { name: 'Discard this test run' }));
            await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('r1'));
        }
    });

    it('a finished run offers no Stop', async () => {
        const user = userEvent.setup();
        renderRow(run({ status: 'success' }));
        await user.click(screen.getByTitle('Actions'));
        expect(screen.queryByRole('button', { name: 'Stop it' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Discard this test run' })).toBeNull();
    });
});
