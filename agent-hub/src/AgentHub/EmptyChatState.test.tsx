import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import AgentChatViewJs from './AgentChatView';
import DirectChatViewJs from './DirectChatView';
import EmptyChatState, { EMPTY_CHAT_STATE_CLASS } from './EmptyChatState';

/**
 * BFSF-281: on a phone with the keyboard open, the empty chat's composer slid
 * out of view above the scroller.
 *
 * The empty state was a fixed-height (`h-full`) flex column centring heading,
 * composer and suggestions. Once the shell shrank to the visible viewport it
 * was taller than the scroller and overflowed at BOTH ends; the top part
 * (heading plus the composer's typing area) cannot be scrolled to, and a
 * negative top margin clipped a further 40px. These tests pin the class
 * contract and that both chat views use it. They cannot prove the layout
 * (jsdom has no layout engine); that needs a real device.
 */

// The heavy children are not what is under test; the composer is a marker so
// the test can see WHERE it ends up.
vi.mock('../components/chat/InputArea', () => ({ default: () => <div data-testid="composer" /> }));
vi.mock('../components/chat/MessageItem', () => ({ default: () => null }));
vi.mock('../components/cowork/CoworkModeToggle', () => ({ default: () => null }));
vi.mock('../components/chat/DirectChatWelcome', () => ({
    default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../components/shell/WelcomeScreen', () => ({
    default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

// The views are untyped .jsx with a long prop list; only a few matter here.
const DirectChatView = DirectChatViewJs as unknown as React.ComponentType<Record<string, unknown>>;
const AgentChatView = AgentChatViewJs as unknown as React.ComponentType<Record<string, unknown>>;

const common = {
    isMobile: true,
    messages: [],
    messagesContainerRef: { current: null },
    messagesEndRef: { current: null },
    shouldForceScrollRef: { current: false },
    renderSidePanels: () => null,
    setChatInput: () => {},
    setSidebarOpen: () => {},
};

function expectGrowingEmptyState() {
    const box = screen.getByTestId('empty-chat-state');
    expect(box.contains(screen.getByTestId('composer'))).toBe(true);
    const classes = box.className.split(/\s+/);
    expect(classes).toContain('min-h-full');
    expect(classes).toContain('justify-center-safe');
    expect(classes).not.toContain('h-full');
    expect(classes).not.toContain('justify-center');
    expect(classes.some(c => c.startsWith('-mt-'))).toBe(false);
}

describe('EmptyChatState — grows with its content instead of overflowing upward', () => {
    it('uses min-h-full and safe centring, with no negative top margin', () => {
        render(<EmptyChatState><span>welcome</span></EmptyChatState>);
        const box = screen.getByTestId('empty-chat-state');
        expect(box.className).toBe(EMPTY_CHAT_STATE_CLASS);
        expect(box).toHaveTextContent('welcome');
    });

    it('wraps the composer in the direct chat', () => {
        render(<DirectChatView {...common} coworkMode="chat" />);
        expectGrowingEmptyState();
    });

    it('wraps the composer in the agent chat', () => {
        render(<AgentChatView {...common} selectedAgent={{ id: 'agent-1', name: 'Helper' }} favorites={[]} />);
        expectGrowingEmptyState();
    });
});
