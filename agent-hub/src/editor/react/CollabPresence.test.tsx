import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import CollabPresence from './CollabPresence';
import type { CollabHandle, CollabPeer } from '../collab/useCollab';

function handle(over: Partial<CollabHandle> = {}): CollabHandle {
    const ydoc = new Y.Doc();
    return {
        status: 'synced', canEdit: true, ready: true, peers: [], userId: 'me', retry: () => {}, destroy: () => {},
        ydoc, fragment: ydoc.getXmlFragment('content'), awareness: new Awareness(ydoc), ...over,
    };
}
const peer = (clientId: number, userId: string, name?: string, editing = true): CollabPeer => ({
    clientId, userId, name, editing, color: '#0284c7', colorIndex: 0, cursor: null,
});

describe('CollabPresence', () => {
    it('renders nothing without a session or when co-editing is off for this item', () => {
        const { container, rerender } = render(<CollabPresence handle={null} />);
        expect(container).toBeEmptyDOMElement();
        rerender(<CollabPresence handle={handle({ status: 'disabled' })} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('shows each other person once, named, with what they are doing', () => {
        render(<CollabPresence handle={handle({ peers: [peer(1, 'u2', 'Anna Berg'), peer(2, 'u2', 'Anna Berg', false), peer(3, 'u3', undefined, false), peer(4, 'me', 'Me')] })} />);
        const list = screen.getByRole('list', { name: 'People in this document' });
        expect(list.querySelectorAll('li')).toHaveLength(2);
        expect(screen.getByText('Anna Berg is editing')).toBeInTheDocument();
        expect(screen.getByText('Someone is viewing')).toBeInTheDocument();
        expect(list).toHaveTextContent('AB');
    });

    it('folds a crowd into a count', () => {
        const peers = Array.from({ length: 6 }, (_, i) => peer(i + 1, `u${i}`, `Person ${i}`));
        render(<CollabPresence handle={handle({ peers })} />);
        expect(screen.getAllByText('2 more').length).toBeGreaterThan(0);
    });

    it('says how the connection is, without interrupting anyone', () => {
        const { rerender } = render(<CollabPresence handle={handle({ status: 'connecting' })} />);
        expect(screen.getByRole('status')).toHaveTextContent('Connecting…');
        rerender(<CollabPresence handle={handle()} />);
        expect(screen.getByRole('status')).toHaveTextContent('Live');
        rerender(<CollabPresence handle={handle({ status: 'readonly', canEdit: false })} />);
        expect(screen.getByRole('status')).toHaveTextContent('View only');
        rerender(<CollabPresence handle={handle({ status: 'offline' })} />);
        expect(screen.getByRole('status')).toHaveAttribute('title', 'Your changes are kept and sent when the connection is back');
        rerender(<CollabPresence handle={handle({ status: 'error', lastError: 'DELETED' })} />);
        expect(screen.getByRole('status')).toHaveTextContent('Not connected');
        expect(screen.getByRole('status')).toHaveAttribute('title', 'This item was deleted.');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('never asks for an undo the ended session cannot take after a change too large to share', () => {
        render(<CollabPresence handle={handle({ status: 'error', lastError: 'UPDATE_TOO_LARGE' })} />);
        const title = screen.getByRole('status').getAttribute('title') || '';
        expect(title).toMatch(/live session stopped/);
        expect(title).not.toMatch(/undo/i);
    });
});
