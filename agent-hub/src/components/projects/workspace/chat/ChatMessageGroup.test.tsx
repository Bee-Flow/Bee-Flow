import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TeamChatMessage } from '../../../../api/queries/projectChats';
import ChatMessageGroup from './ChatMessageGroup';
import type { MessageContext } from './ChatMessageBubble';
import type { MessageGroup } from './messageGroups';

const message: TeamChatMessage = {
    id: 'm1', seq: 1, authorKind: 'assistant', authorUserId: null, agentId: null, content: 'Hello', mentions: [], replyTo: null,
    createdAt: '2026-10-01T10:00:00Z', editedAt: null, deleted: false,
};
const group = (extra: Partial<MessageGroup> = {}): MessageGroup => ({
    key: 'g1', authorKind: 'assistant', authorUserId: null, agentId: null, createdAt: message.createdAt,
    items: [{ type: 'message', key: 'm1', message }], ...extra,
});
const ctx = (extra: Partial<MessageContext> = {}): MessageContext => ({
    currentUserId: 'me', isProjectOwner: false, canPost: true, nameOf: () => 'Someone', assistantName: () => 'AI assistant', mentionTokens: [],
    findMessage: () => undefined, onDelete: vi.fn(), onEdit: vi.fn(), onRetry: vi.fn(), onDiscard: vi.fn(), onNotHelpful: vi.fn(),
    ...extra,
} as MessageContext);

const renderGroup = (g: MessageGroup, c: MessageContext) => render(<ol><ChatMessageGroup group={g} ctx={c} /></ol>);

describe('the AI assistant\'s avatar in a team chat', () => {
    it('wears the project\'s own icon', () => {
        renderGroup(group(), ctx({ aiIcon: '🚀' }));
        expect(screen.getByText('🚀')).toBeInTheDocument();
    });

    it('keeps the plain AI mark when there is no icon, and an agent keeps its own mark', () => {
        const { container, unmount } = renderGroup(group(), ctx());
        expect(container.querySelector('svg')).toBeTruthy();
        unmount();
        renderGroup(group({ agentId: 'agent-1' }), ctx({ aiIcon: '🚀' }));
        expect(screen.queryByText('🚀')).not.toBeInTheDocument();
    });
});

describe('who is on which side', () => {
    const own: TeamChatMessage = { ...message, id: 'u1', authorKind: 'user', authorUserId: 'me', content: 'What I typed' };
    const theirs: TeamChatMessage = { ...message, id: 'u2', authorKind: 'user', authorUserId: 'jan', content: 'What Jan typed' };
    const userGroup = (m: TeamChatMessage, id: string): MessageGroup => ({ key: m.id, authorKind: 'user', authorUserId: id, agentId: null, createdAt: m.createdAt, items: [{ type: 'message', key: m.id, message: m }] });
    const named = (id: string | null | undefined) => (id === 'me' ? 'Me' : 'Jan Test');

    it('puts what the person typed on the right, in a bubble tinted with the project colour, without their name', () => {
        renderGroup(userGroup(own, 'me'), ctx({ nameOf: named }));
        expect(screen.getByTestId('team-chat-group')).toHaveAttribute('data-mine', 'true');
        expect(screen.getByTestId('team-chat-group').className).toContain('flex-row-reverse');
        expect(screen.getByTestId('team-chat-message-u1').className).toContain('ml-auto');
        expect(screen.queryByText('Me')).not.toBeInTheDocument();
        expect(screen.getByText('What I typed')).toBeInTheDocument();
    });

    it('keeps a colleague on the left, with their name, in a grey bubble', () => {
        renderGroup(userGroup(theirs, 'jan'), ctx({ nameOf: named }));
        expect(screen.getByTestId('team-chat-group')).not.toHaveAttribute('data-mine');
        expect(screen.getByTestId('team-chat-group').className).not.toContain('flex-row-reverse');
        expect(screen.getByTestId('team-chat-message-u2').className).not.toContain('ml-auto');
        expect(screen.getByText('Jan Test')).toBeInTheDocument();
    });

    it('keeps the AI on the left, in its wide card', () => {
        renderGroup(group(), ctx({ nameOf: named }));
        expect(screen.getByTestId('team-chat-group')).not.toHaveAttribute('data-mine');
        expect(screen.getByText('AI assistant')).toBeInTheDocument();
    });
});

describe('a person\'s colour in the chat', () => {
    const own: TeamChatMessage = { ...message, id: 'u1', authorKind: 'user', authorUserId: 'me', content: 'Mine' };
    const theirs: TeamChatMessage = { ...message, id: 'u2', authorKind: 'user', authorUserId: 'jan', content: 'Theirs' };
    const g = (m: TeamChatMessage, id: string): MessageGroup => ({ key: m.id, authorKind: 'user', authorUserId: id, agentId: null, createdAt: m.createdAt, items: [{ type: 'message', key: m.id, message: m }] });
    const colors: Record<string, string> = { me: '#22c55e', jan: '#f43f5e' };
    const withColors = () => ctx({ colorOf: (id) => colors[id || ''] || '#64748b', nameOf: (id) => (id === 'me' ? 'Me' : 'Jan Test') });

    it('washes a bubble with its author\'s colour, only slightly', () => {
        renderGroup(g(theirs, 'jan'), withColors());
        const style = screen.getByTestId('team-chat-message-u2').getAttribute('style') || '';
        expect(style).toContain('#f43f5e');
        expect(style).toMatch(/8%/);
        expect(style).not.toMatch(/(?:[3-9]\d|100)%/);
    });

    it('uses the shared Direct chat theme for your own bubble', () => {
        renderGroup(g(own, 'me'), withColors());
        expect(screen.getByTestId('team-chat-message-u1').getAttribute('style')).toContain('var(--user-bubble-bg)');
    });

    it('paints a colleague\'s name in their colour, kept readable by the theme\'s ink', () => {
        renderGroup(g(theirs, 'jan'), withColors());
        const name = screen.getByText('Jan Test');
        expect(name.getAttribute('style')).toContain('#f43f5e');
        expect(name.getAttribute('style')).toContain('var(--text-primary)');
    });
});

