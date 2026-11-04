import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
});
