// One message's extras: the Copy hover action, the search's <mark> painting
// and the ring on the active match, and an outside request to open the editor
// (ArrowUp in the empty composer).

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamChatMessage } from '../../../../api/queries/projectChats';
import ChatMessageGroup from './ChatMessageGroup';
import type { MessageContext } from './ChatMessageBubble';
import type { MessageGroup } from './messageGroups';

const message: TeamChatMessage = {
    id: 'u1', seq: 1, authorKind: 'user', authorUserId: 'me', agentId: null, content: 'Copy me please', mentions: [], replyTo: null,
    createdAt: '2026-10-01T10:00:00Z', editedAt: null, deleted: false,
};
const group = (m: TeamChatMessage): MessageGroup => ({
    key: m.id, authorKind: m.authorKind, authorUserId: m.authorUserId, agentId: null, createdAt: m.createdAt,
    items: [{ type: 'message', key: m.id, message: m }],
});
const ctx = (extra: Partial<MessageContext> = {}): MessageContext => ({
    currentUserId: 'me', isProjectOwner: false, canPost: true, nameOf: () => 'Me', assistantName: () => 'AI assistant', mentionTokens: [],
    findMessage: () => undefined, onDelete: vi.fn(), onEdit: vi.fn(), onRetry: vi.fn(), onDiscard: vi.fn(), onNotHelpful: vi.fn(),
    ...extra,
} as MessageContext);

const writeText = vi.fn();
beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
});

describe('the Copy action', () => {
    it('copies the message text to the clipboard', async () => {
        const user = userEvent.setup();
        // userEvent.setup() installs its own clipboard stub, so mock after it.
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        render(<ol><ChatMessageGroup group={group(message)} ctx={ctx()} /></ol>);
        await user.click(screen.getByRole('button', { name: 'Copy' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('Copy me please'));
    });

    it('is not offered on a deleted message', () => {
        render(<ol><ChatMessageGroup group={group({ ...message, content: '', deleted: true })} ctx={ctx()} /></ol>);
        expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    });
});

describe('search highlighting', () => {
    it('wraps matches in <mark>, carries the message id, and rings the active match', () => {
        const { container } = render(
            <ol><ChatMessageGroup group={group(message)} ctx={ctx({ highlight: { query: 'copy', activeMessageId: 'u1' } })} /></ol>,
        );
        const bubble = screen.getByTestId('team-chat-message-u1');
        expect(bubble).toHaveAttribute('data-message-id', 'u1');
        expect(bubble.className).toContain('ring-2');
        const mark = container.querySelector('mark');
        expect(mark).toHaveTextContent('Copy');
    });

    it('paints nothing without a highlight', () => {
        const { container } = render(<ol><ChatMessageGroup group={group(message)} ctx={ctx()} /></ol>);
        expect(container.querySelector('mark')).toBeNull();
        expect(screen.getByTestId('team-chat-message-u1').className).not.toContain('ring-2');
    });
});

describe('an edit request from outside', () => {
    it('opens the message editor', () => {
        render(<ol><ChatMessageGroup group={group(message)} ctx={ctx({ editRequest: { messageId: 'u1', nonce: 7 } })} /></ol>);
        expect(screen.getByRole('textbox', { name: 'Edit message' })).toHaveValue('Copy me please');
    });

    it('leaves other messages alone', () => {
        render(<ol><ChatMessageGroup group={group(message)} ctx={ctx({ editRequest: { messageId: 'other', nonce: 7 } })} /></ol>);
        expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument();
    });
});

describe('the AI answer in the house style', () => {
    const answer: TeamChatMessage = { ...message, id: 'a1', authorKind: 'assistant', authorUserId: null, content: 'Here is the answer' };

    it('wears the 26 px agent tile and has no bubble', () => {
        render(<ol><ChatMessageGroup group={group(answer)} ctx={ctx()} /></ol>);
        const tile = screen.getByTestId('assistant-avatar');
        expect(tile.className).toContain('w-[26px]');
        expect(tile).toHaveStyle({ color: 'var(--type-ai)' });
        expect(screen.getByTestId('team-chat-message-a1').className).not.toMatch(/rounded-2xl|bg-/);
    });

    it('offers Copy even to a reader who cannot post', () => {
        render(<ol><ChatMessageGroup group={group(answer)} ctx={ctx({ canPost: false })} /></ol>);
        expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    });

    it('sits on the same 760 px column as the composer', () => {
        render(<ol><ChatMessageGroup group={group(answer)} ctx={ctx()} /></ol>);
        expect(screen.getByTestId('team-chat-group').className).toContain('max-w-[760px]');
    });
});
