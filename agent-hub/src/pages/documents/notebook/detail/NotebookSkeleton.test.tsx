import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { NotebookLoadError } from './NotebookSkeleton';

/**
 * A link to a notebook the reader can no longer open (archived by its owner,
 * deleted, or no longer shared) says so, archived included, and offers no
 * retry that cannot help.
 */

it('a notebook that is not there names archiving among the reasons, without a retry', () => {
    render(<NotebookLoadError status={404} onBack={() => undefined} onRetry={() => undefined} />);
    expect(screen.getByText('This notebook is not available')).toBeInTheDocument();
    expect(screen.getByText('It may have been archived or deleted, or it is no longer shared with you.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});

it('a failed load keeps its own message and the retry', () => {
    render(<NotebookLoadError status={500} message="Server unavailable" onRetry={() => undefined} />);
    expect(screen.getByText('Server unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});
