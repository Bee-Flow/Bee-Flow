import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import SharedChatReadOnly, { isReadOnlySharedChat } from './SharedChatReadOnly';

describe('isReadOnlySharedChat', () => {
    it('is read-only when the server says the reader may not post', () => {
        // GET /agents/:id/conversations/:convId and GET /ai/direct/conversations/:id
        // answer a project viewer with this projection.
        expect(isReadOnlySharedChat({ readOnly: true, access: { canPost: false } })).toBe(true);
        expect(isReadOnlySharedChat({ access: { canPost: false } })).toBe(true);
    });

    it('leaves the owner’s own chat and an editor’s shared chat writable', () => {
        expect(isReadOnlySharedChat({ readOnly: false, access: { canPost: true } })).toBe(false);
        expect(isReadOnlySharedChat({})).toBe(false);
        expect(isReadOnlySharedChat(null)).toBe(false);
    });
});

describe('SharedChatReadOnly', () => {
    it('explains why there is no composer', () => {
        render(<SharedChatReadOnly />);
        expect(screen.getByRole('note')).toHaveTextContent(/You can read it; ask the project owner for editor access/);
    });
});
