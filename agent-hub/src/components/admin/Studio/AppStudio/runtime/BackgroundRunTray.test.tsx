import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import BackgroundRunTray from './BackgroundRunTray';
import type { ActionState } from './actionRunner/core';

const progress = (over = {}) => ({ stepIndex: 0, kind: 'ai_generate', executed: 0, message: null, loop: null, waiting: null, ...over });

describe('BackgroundRunTray', () => {
    it('renders nothing without background jobs', () => {
        const { container } = render(<BackgroundRunTray actionState={{ act_x: { status: 'running', result: undefined, error: null } }} />);
        expect(container.innerHTML).toBe('');
    });

    it('shows the progress text, the loop position, a budget wait and the step count', () => {
        const state: ActionState = {
            a: { status: 'running', result: undefined, error: null, jobId: 'j1', progress: progress({ message: 'Reading the order' }) },
            b: { status: 'running', result: undefined, error: null, jobId: 'j2', progress: progress({ loop: { index: 1, count: 5 } }) },
            c: { status: 'running', result: undefined, error: null, jobId: 'j3', progress: progress({ waiting: 'budget' }) },
            d: { status: 'running', result: undefined, error: null, jobId: 'j4', progress: progress({ executed: 3 }) },
        };
        render(<BackgroundRunTray actionState={state} />);
        expect(screen.getByText('Reading the order')).toBeTruthy();
        expect(screen.getByText('Item 2 of 5')).toBeTruthy();
        expect(screen.getByText('Waiting for the AI budget…')).toBeTruthy();
        expect(screen.getByText('Step 3')).toBeTruthy();
    });

    it('a finished or failed job stays until dismissed', async () => {
        const state: ActionState = {
            a: { status: 'success', result: 1, error: null, jobId: 'j1' },
            b: { status: 'error', result: undefined, error: 'The AI gave no answer within 120 s', jobId: 'j2' },
        };
        render(<BackgroundRunTray actionState={state} />);
        expect(screen.getByText('Finished')).toBeTruthy();
        expect(screen.getByText('The AI gave no answer within 120 s')).toBeTruthy();
        const [first] = screen.getAllByRole('button', { name: 'Dismiss' });
        await userEvent.click(first);
        expect(screen.queryByText('Finished')).toBeNull();
    });

    it('a job on hold says what it waits for; a cancelled job says so until dismissed', () => {
        const state: ActionState = {
            a: { status: 'running', result: undefined, error: null, jobId: 'j1', progress: progress({ waiting: 'timer' }), waiting: { kind: null, wakeAt: '2026-11-12T09:30:00.000Z' } },
            b: { status: 'running', result: undefined, error: null, jobId: 'j2', progress: progress({ waiting: 'approval' }), waiting: { kind: 'approval', wakeAt: '2026-11-12T09:30:00.000Z' } },
            c: { status: 'running', result: undefined, error: null, jobId: 'j3', progress: progress({ waiting: 'resume' }), waiting: { kind: null, wakeAt: null } },
            d: { status: 'idle', result: undefined, error: null, jobId: 'j4', cancelled: true },
        };
        const { container } = render(<BackgroundRunTray actionState={state} />);
        expect(screen.getByText(/^Waiting until .*2026/)).toBeTruthy();
        expect(screen.getByText('Waiting for an approval')).toBeTruthy();
        expect(screen.getByText('Waiting to be continued')).toBeTruthy();
        expect(screen.getByText('Cancelled')).toBeTruthy();
        expect(container.querySelectorAll('[data-on-hold="true"]')).toHaveLength(3);
        // Without an app id there is nothing to cancel with.
        expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    });

    it('a job on hold for an approval says who decides', () => {
        const onHold = (jobId: string, waitingFor: object) => ({ status: 'running' as const, result: undefined, error: null, jobId, progress: progress({ waiting: 'approval', waitingFor }), waiting: { kind: 'approval', wakeAt: null } });
        render(<BackgroundRunTray actionState={{
            a: onHold('j1', { kind: 'group', name: 'Finance' }), b: onHold('j2', { kind: 'panel', count: 3 }), c: onHold('j3', { kind: 'owner' }),
        }} />);
        expect(screen.getByText('Waiting for approval by Finance')).toBeTruthy();
        expect(screen.getByText('Waiting for approval by 3 approvers')).toBeTruthy();
        expect(screen.getByText('Waiting for approval by the app owner')).toBeTruthy();
    });

    it('Cancel asks the server to stop the job and shows that it is stopping; a finished job has no Cancel', async () => {
        const sendCancel = vi.fn(async () => true);
        const state: ActionState = {
            a: { status: 'running', result: undefined, error: null, jobId: 'j1', progress: progress({ executed: 2 }) },
            b: { status: 'success', result: 1, error: null, jobId: 'j2' },
        };
        render(<BackgroundRunTray actionState={state} appId="app1" sendCancel={sendCancel} />);
        const buttons = screen.getAllByRole('button', { name: 'Cancel' });
        expect(buttons).toHaveLength(1);
        await userEvent.click(buttons[0]);
        expect(sendCancel).toHaveBeenCalledWith('app1', 'j1');
        expect(await screen.findByText('Stopping…')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    });

    it('a cancel the server did not take leaves the job as it was, with Cancel still there', async () => {
        const sendCancel = vi.fn(async () => false);
        const state: ActionState = { a: { status: 'running', result: undefined, error: null, jobId: 'j1', progress: progress({ executed: 2 }), waiting: { kind: null, wakeAt: null } } };
        render(<BackgroundRunTray actionState={state} appId="app1" sendCancel={sendCancel} />);
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(await screen.findByRole('button', { name: 'Cancel' })).toBeTruthy();
        expect(screen.getByText('Waiting to be continued')).toBeTruthy();
    });
});
