import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectNotebookCard from './ProjectNotebookCard';

const NOTEBOOK = {
    id: 'nb-1', name: 'Market research', preview: 'Competitor pricing', sourceCount: 2, userId: 'u-owner',
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastEditedBy: 'u-anna', lastEditedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

afterEach(cleanup);

function renderCard(over: Record<string, unknown> = {}) {
    const onOpen = vi.fn();
    render(
        <ProjectNotebookCard
            notebook={NOTEBOOK}
            ownerName="Owen"
            editorName="Anna"
            canRemove={false}
            removing={false}
            onOpen={onOpen}
            onRemove={vi.fn()}
            {...over}
        />,
    );
    return { onOpen };
}

describe('ProjectNotebookCard', () => {
    it('says who changed the document last, and when', () => {
        renderCard();
        expect(screen.getByTestId('notebook-card-edited')).toHaveTextContent('Edited by Anna · 5m ago');
    });

    it('says nothing about an editor it cannot name', () => {
        renderCard({ editorName: '' });
        expect(screen.queryByTestId('notebook-card-edited')).not.toBeInTheDocument();
    });

    it('carries a quiet dot, and says so to a screen reader, when somebody else changed it', async () => {
        const user = userEvent.setup();
        const { onOpen } = renderCard({ unread: true });
        expect(screen.getByTestId('notebook-card-unread')).toBeInTheDocument();
        const open = screen.getByRole('button', { name: 'Open notebook Market research (changed since you last looked)' });
        await user.click(open);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('has no dot when there is nothing new', () => {
        renderCard({ unread: false });
        expect(screen.queryByTestId('notebook-card-unread')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open notebook Market research' })).toBeInTheDocument();
    });
});
