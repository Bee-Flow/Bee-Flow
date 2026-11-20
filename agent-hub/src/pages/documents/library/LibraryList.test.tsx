import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import LibraryList, { type LibraryListProps } from './LibraryList';
import type { LibraryRow } from '../documentQueries';

/**
 * A template a Solution stage manages: the server refuses its archive, so the
 * row offers no Archive and cannot be selected for a bulk action. An ordinary
 * template of the same owner still can.
 */

const now = new Date().toISOString();
const managed: LibraryRow = { id: 't1', name: 'Stage offer', userId: 'me', docType: 'designed', kind: 'template', managed: true, updatedAt: now };
const free: LibraryRow = { id: 't2', name: 'Own offer', userId: 'me', docType: 'designed', kind: 'template', managed: false, updatedAt: now };

function props(rows: LibraryRow[]): LibraryListProps {
    return {
        rows, people: {}, currentUserId: 'me', status: 'ok', refreshing: false, archivedView: false, filtered: false,
        selection: [], onSelect: vi.fn(), onOpen: vi.fn(), onDuplicate: vi.fn(), onArchive: vi.fn(async () => undefined),
        onUnarchive: vi.fn(), onRetry: vi.fn(), onCreate: vi.fn(), busyId: null,
    };
}

it('a managed template offers neither Archive nor a selection box; an ordinary one does', () => {
    render(<LibraryList {...props([managed, free])} />);
    const stage = screen.getByTestId('library-row-t1');
    expect(within(stage).queryByRole('button', { name: 'Archive Stage offer' })).not.toBeInTheDocument();
    expect(within(stage).queryByRole('checkbox')).not.toBeInTheDocument();
    const own = screen.getByTestId('library-row-t2');
    expect(within(own).getByRole('button', { name: 'Archive Own offer' })).toBeInTheDocument();
    expect(within(own).getByRole('checkbox', { name: 'Select Own offer' })).toBeInTheDocument();
});

it('an organisation admin sees no Archive on a managed team template either', () => {
    render(<LibraryList {...props([{ ...managed, userId: 'someone', visibility: 'team' }])} orgAdmin />);
    expect(screen.queryByRole('button', { name: 'Archive Stage offer' })).not.toBeInTheDocument();
});
