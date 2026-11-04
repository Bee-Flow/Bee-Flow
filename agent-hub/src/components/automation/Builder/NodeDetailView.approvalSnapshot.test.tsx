import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NodeDetailView from './NodeDetailView';
import { ndvProps } from './ndv/ndvTestProps';
import { renderWithClient } from '@/test/render';
import { installRunTransport, json } from '@/test/runTransport';
import { omitted } from '@/test/mocks';
import type { ComponentProps } from 'react';

/**
 * The step drawer's approval bar (pauses F5, run-watch F2/F10, RUN-02):
 *   - it shows only while the run the canvas follows waits on THIS step,
 *     never because a step row says "awaiting_approval";
 *   - its question and extra questions are the approval's SNAPSHOT (GET
 *     /runs/:runId/form pendingApproval), not the step as edited since: the
 *     server checks the answers against the snapshot;
 *   - a decision hands the run back to the canvas.
 * The server is authFetch's transport seam (test/runTransport); nothing is
 * module-mocked.
 */
const EDITED_APPROVAL = {
    id: 'ap', type: 'approval', label: 'Sign-off', prompt: 'Raw {{steps.x.output.client}}?',
    // Edited while the run waited: renamed field, a new required one.
    approval: { fields: [{ name: 'budget', label: 'Budget', type: 'number', required: true }] },
};
const DEFINITION = {
    trigger: { id: 't1', type: 'trigger', kind: 'manual' },
    steps: [EDITED_APPROVAL, { id: 'mail', type: 'notification', label: 'Mail' }],
    edges: [{ from: 't1', to: 'ap' }, { from: 'ap', to: 'mail' }],
};
const SNAPSHOT = {
    approvalId: 'apr1', prompt: 'Amount for Acme?', detailsMd: null,
    fields: [{ name: 'amount', label: 'Amount', type: 'number' }],
    canDecide: true, waitingOn: { stageName: null, seatCount: 1 }, isTest: true,
};
const PAUSED = { id: 'r1', status: 'awaiting_approval', awaitingStepId: 'ap', profile: { kind: 'dry' } };
const ROW = { runId: 'r1', stepId: 'ap', status: 'awaiting_approval', output: {} };

let server: ReturnType<typeof installRunTransport> | null = null;
beforeEach(() => {
    cleanup();
    server = installRunTransport((url) => {
        if (url.endsWith('/runs/r1/form')) return json({ runId: 'r1', status: 'awaiting_approval', waiting: false, pendingApproval: SNAPSHOT });
        if (url.endsWith('/runs/r1/approve-step')) return json({ accepted: true, pending: true, runId: 'child' }, 202);
        return null;
    });
});
afterEach(() => { server?.uninstall(); server = null; });

function open(step: Record<string, unknown>, over: Record<string, unknown>) {
    const props = ndvProps(step as { id: string; type: string }, DEFINITION, { catalog: { apps: [], triggerOutputs: {} }, runStep: ROW, ...over });
    return renderWithClient(<NodeDetailView {...omitted<ComponentProps<typeof NodeDetailView>>()} {...props} />);
}

describe('NodeDetailView — the approval bar reads the snapshot', () => {
    it('shows the question and fields the run paused with, not the step as edited since', async () => {
        open(EDITED_APPROVAL, { followedRun: PAUSED, onFollowRun: vi.fn() });
        // The bar is a lazy chunk behind a fetch: under a loaded CI runner the default 1 s is too short.
        expect(await screen.findByText('Amount for Acme?', {}, { timeout: 5000 })).toBeTruthy();
        const bar = screen.getByTestId('approval-action-bar');
        expect(bar.textContent).toContain('Amount');
        expect(bar.textContent).not.toContain('Budget');
        expect(bar.textContent).not.toContain('{{');
        expect(screen.getByTestId('approval-action-bar-title').textContent).toBe('Waiting for your decision (test)');
    });

    it('hands the run back to the canvas after the decision', async () => {
        const onFollowRun = vi.fn();
        open(EDITED_APPROVAL, { followedRun: PAUSED, onFollowRun });
        await screen.findByText('Amount for Acme?', {}, { timeout: 5000 });
        await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
        await waitFor(() => expect(onFollowRun).toHaveBeenCalledWith('r1'));
    });
});

describe('NodeDetailView — the approval bar follows the run, not the row', () => {
    it('no bar while the followed run executes again, even with the row still "awaiting_approval"', () => {
        open(EDITED_APPROVAL, { followedRun: { ...PAUSED, status: 'running' } });
        expect(screen.queryByTestId('approval-action-bar')).toBeNull();
        expect(screen.queryByTestId('approval-action-bar-loading')).toBeNull();
    });

    it('no bar when the run waits on another step', () => {
        open(EDITED_APPROVAL, { followedRun: { ...PAUSED, awaitingStepId: 'other' } });
        expect(screen.queryByTestId('approval-action-bar-loading')).toBeNull();
        expect(screen.queryByTestId('approval-action-bar')).toBeNull();
    });

    it('no bar without a followed run (a row from an old run)', () => {
        open(EDITED_APPROVAL, {});
        expect(screen.queryByTestId('approval-action-bar-loading')).toBeNull();
        expect(screen.queryByTestId('approval-action-bar')).toBeNull();
        expect(server?.calls.some(c => c.url.includes('/runs/r1/form'))).toBe(false);
    });
});
