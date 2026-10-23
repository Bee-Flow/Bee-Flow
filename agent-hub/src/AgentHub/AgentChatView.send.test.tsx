import type { ComponentProps } from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import AgentChatView from './AgentChatView';

let composer: { onSendMessage: (...a: unknown[]) => void } | null = null;
vi.mock('../components/chat/InputArea', () => ({ default: (p: { onSendMessage: (...a: unknown[]) => void }) => { composer = p; return null; } }));
vi.mock('./DocumentsHeaderButton', () => ({ default: () => null }));
vi.mock('./EmptyChatState', () => ({ default: (p: { composerProps?: { onSendMessage: (...a: unknown[]) => void } }) => { composer = p.composerProps ?? composer; return null; } }));

describe('AgentChatView composer', () => {
    it('does not pass the thread parent on as sendMessage isHidden', () => {
        const sendMessage = vi.fn();
        const noop = () => {};
        const props = {
            isMobile: false, setSidebarOpen: noop, selectedAgent: { id: 'a', name: 'A' }, user: {}, onNavigate: noop, favorites: [],
            showAgentMenu: false, setShowAgentMenu: noop, handleNewChat: noop, handleToggleFavorite: noop, handleUnpublishAgent: noop,
            setCoworkModeForAgent: noop, messagesContainerRef: { current: null }, messagesEndRef: { current: null },
            shouldForceScrollRef: { current: false }, messages: [{ id: 'm', role: 'user', content: 'hi' }], chatInput: '', setChatInput: noop,
            sendMessage, stopGenerating: noop, isLoading: false, conversationStarted: true, renderSidePanels: () => null,
        };
        render(<AgentChatView {...(props as unknown as ComponentProps<typeof AgentChatView>)} />);
        expect(composer).not.toBeNull();
        composer?.onSendMessage('hello', [], { id: 'parent' });
        expect(sendMessage).toHaveBeenCalledWith('hello', [], false);
    });
});
