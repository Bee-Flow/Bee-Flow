import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import AgentChatView from './AgentChatView';

let composer: { onSendMessage: (...a: unknown[]) => void } | null = null;
vi.mock('../components/chat/InputArea', () => ({ default: (p: { onSendMessage: (...a: unknown[]) => void }) => { composer = p; return null; } }));
vi.mock('./DocumentsHeaderButton', () => ({ default: () => null }));
vi.mock('./EmptyChatState', () => ({ default: (p: { composerProps?: { onSendMessage: (...a: unknown[]) => void } }) => { composer = p.composerProps ?? composer; return null; } }));

const noop = () => {};
const MESSAGES = [{ id: 'm', role: 'user', content: 'hi' }];

function renderView(extra: Record<string, unknown> = {}) {
    const props = {
        isMobile: false, setSidebarOpen: noop, selectedAgent: { id: 'a', name: 'A' }, user: {}, onNavigate: noop, favorites: [],
        showAgentMenu: false, setShowAgentMenu: noop, handleNewChat: noop, handleToggleFavorite: noop, handleUnpublishAgent: noop,
        setCoworkModeForAgent: noop, messagesContainerRef: { current: null }, messagesEndRef: { current: null },
        shouldForceScrollRef: { current: false }, messages: MESSAGES, chatInput: '', setChatInput: noop,
        sendMessage: vi.fn(), stopGenerating: noop, isLoading: false, conversationStarted: true, renderSidePanels: () => null,
        ...extra,
    };
    return render(<AgentChatView {...(props as unknown as ComponentProps<typeof AgentChatView>)} />);
}

describe('AgentChatView composer', () => {
    it('does not pass the thread parent on as sendMessage isHidden', () => {
        const sendMessage = vi.fn();
        renderView({ sendMessage });
        expect(composer).not.toBeNull();
        composer?.onSendMessage('hello', [], { id: 'parent' });
        expect(sendMessage).toHaveBeenCalledWith('hello', [], false);
    });
});

describe('AgentChatView incognito', () => {
    const fresh = { messages: [], conversationStarted: false };

    it('offers the ghost on a new chat, off by default, keyboard reachable', async () => {
        const onIncognitoChange = vi.fn();
        renderView({ ...fresh, onIncognitoChange });
        const toggle = screen.getByTestId('incognito-toggle');
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
        // A real button: it takes focus and answers Enter.
        toggle.focus();
        expect(document.activeElement).toBe(toggle);
        await userEvent.keyboard('{Enter}');
        expect(onIncognitoChange).toHaveBeenCalledWith(true);
        expect(screen.queryByTestId('incognito-banner')).toBeNull();
    });

    it('while on: pressed, framed, labelled, and the composer is told (no Cowork)', () => {
        renderView({ ...fresh, incognito: true, onIncognitoChange: noop, coworkComposer: { agents: [] } });
        expect(screen.getByTestId('incognito-toggle')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('incognito-banner')).toHaveTextContent('Incognito chat');
        expect(screen.getByTestId('incognito-banner')).toHaveTextContent('knowledge base query log');
        expect(document.querySelector('[data-incognito="true"]')).not.toBeNull();
        expect(screen.queryByTestId('cowork-mode-switch')).toBeNull();
    });

    it('locks once the first message is sent: the toggle goes, the label stays', () => {
        renderView({ incognito: true, onIncognitoChange: noop });
        expect(screen.queryByTestId('incognito-toggle')).toBeNull();
        expect(screen.getByTestId('incognito-banner')).toBeTruthy();
        expect(composer).toMatchObject({ incognito: true, cowork: undefined });
    });

    it('ends the incognito chat when the view goes away', () => {
        const onLeaveIncognito = vi.fn();
        const { unmount } = renderView({ incognito: true, onLeaveIncognito });
        expect(onLeaveIncognito).not.toHaveBeenCalled();
        unmount();
        expect(onLeaveIncognito).toHaveBeenCalledTimes(1);
    });
});
