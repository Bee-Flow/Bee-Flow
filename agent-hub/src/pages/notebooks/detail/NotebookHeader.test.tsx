import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotebookHeaderStatus from './NotebookHeaderStatus';
import NotebookSaveStatus from './NotebookSaveStatus';

const PROJECT = { id: 'p1', name: 'Launch plan', kind: 'workspace' as const, color: null, icon: null, role: 'editor' as const };

afterEach(cleanup);

describe('NotebookHeaderStatus', () => {
    it('a viewer sees "View only" and the project it belongs to, with a link', async () => {
        const user = userEvent.setup();
        const onOpenProject = vi.fn();
        render(<NotebookHeaderStatus readOnly project={PROJECT} onOpenProject={onOpenProject} />);
        expect(screen.getByTestId('notebook-view-only')).toHaveTextContent('View only');
        const chip = screen.getByTestId('notebook-project-chip');
        expect(chip).toHaveAttribute('href', '/app/projects/p1/notebooks');
        await user.click(chip);
        expect(onOpenProject).toHaveBeenCalledWith('p1');
    });

    it('an editor in no project sees neither chip, but the facts and the save status', () => {
        render(<NotebookHeaderStatus readOnly={false} project={null} meta="2 sources" saveStatus={<span>Saved</span>} />);
        expect(screen.queryByTestId('notebook-view-only')).not.toBeInTheDocument();
        expect(screen.queryByTestId('notebook-project-chip')).not.toBeInTheDocument();
        expect(screen.getByTestId('notebook-meta')).toHaveTextContent('2 sources');
        expect(screen.getByText('Saved')).toBeInTheDocument();
    });
});

describe('NotebookSaveStatus', () => {
    it('says what is true for each state, and a failed save is a retry button', async () => {
        const user = userEvent.setup();
        const onRetry = vi.fn();
        const { rerender } = render(<NotebookSaveStatus mode="saving" />);
        expect(screen.getByRole('status')).toHaveTextContent('Saving…');
        rerender(<NotebookSaveStatus mode="live" />);
        expect(screen.getByRole('status')).toHaveTextContent('Saved as you type');
        rerender(<NotebookSaveStatus mode="offline" />);
        expect(screen.getByRole('status')).toHaveTextContent('Offline');
        rerender(<NotebookSaveStatus mode="idle" lastSavedAt={Date.now()} />);
        expect(screen.getByRole('status')).toHaveTextContent('Saved just now');
        rerender(<NotebookSaveStatus mode="readonly" />);
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
        rerender(<NotebookSaveStatus mode="error" onRetry={onRetry} />);
        await user.click(screen.getByRole('button', { name: /Save failed/ }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});
