import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotebookTitle from './NotebookTitle';
import NotebookSaveStatus from './NotebookSaveStatus';

const PROJECT = { id: 'p1', name: 'Launch plan', kind: 'workspace' as const, color: null, icon: null, role: 'editor' as const };

afterEach(cleanup);

describe('NotebookTitle', () => {
    it('renames in place: Enter saves, Escape puts the old title back', async () => {
        const user = userEvent.setup();
        const onRename = vi.fn().mockResolvedValue(undefined);
        render(<NotebookTitle name="Research" canRename readOnly={false} project={null} onRename={onRename} />);
        await user.click(screen.getByTestId('notebook-title'));
        const input = screen.getByTestId('notebook-title-input');
        await user.clear(input);
        await user.type(input, '  Market   research {Enter}');
        expect(onRename).toHaveBeenCalledWith('Market research');

        await user.click(screen.getByTestId('notebook-title'));
        await user.type(screen.getByTestId('notebook-title-input'), 'x{Escape}');
        expect(onRename).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('notebook-title')).toHaveTextContent('Research');
    });

    it('a rename that fails keeps what was typed and says why', async () => {
        const user = userEvent.setup();
        const onRename = vi.fn().mockRejectedValue(new Error('Only the owner can do this.'));
        render(<NotebookTitle name="Research" canRename readOnly={false} project={null} onRename={onRename} />);
        await user.click(screen.getByTestId('notebook-title'));
        await user.type(screen.getByTestId('notebook-title-input'), ' 2{Enter}');
        expect(await screen.findByRole('alert')).toHaveTextContent('Only the owner can do this.');
        expect(screen.getByTestId('notebook-title-input')).toHaveValue('Research 2');
    });

    it('a viewer sees "View only", no rename, and the project it belongs to with a link', async () => {
        const user = userEvent.setup();
        const onOpenProject = vi.fn();
        render(<NotebookTitle name="Research" canRename={false} readOnly project={PROJECT} onRename={vi.fn()} onOpenProject={onOpenProject} />);
        expect(screen.getByTestId('notebook-view-only')).toHaveTextContent('View only');
        expect(screen.getByTestId('notebook-title').tagName).toBe('H2');
        const chip = screen.getByTestId('notebook-project-chip');
        expect(chip).toHaveAttribute('href', '/app/projects/p1/notebooks');
        await user.click(chip);
        expect(onOpenProject).toHaveBeenCalledWith('p1');
    });

    it('the command palette can start a rename', () => {
        const { rerender } = render(<NotebookTitle name="Research" canRename readOnly={false} project={null} onRename={vi.fn()} editSignal={0} />);
        expect(screen.queryByTestId('notebook-title-input')).not.toBeInTheDocument();
        rerender(<NotebookTitle name="Research" canRename readOnly={false} project={null} onRename={vi.fn()} editSignal={1} />);
        expect(screen.getByTestId('notebook-title-input')).toBeInTheDocument();
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
