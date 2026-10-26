import { useEffect, useEffectEvent, type Dispatch, type SetStateAction } from 'react';
import { DEFAULT_AGENT_EMOJI, pickAgentAvatar } from '../utils/agentAvatar';
import { API_BASE, generateMessageId } from '../utils/helpers';
import scopedStorage from '../utils/scopedStorage';
import type { ChatMessage } from '../hooks/useChatEngine/types';
import type { AgentLike, IdRef } from './useAgentHubData';
import { logger } from '../utils/logger';
import { request, RefusedError } from '../api/mutate';

// The "All Chats" aggregation and the window-event listeners that steer the
// hub from outside (Settings' chat-history-mode switch, NotificationCenter's
// "Open in Direct Chat"). Moved verbatim from AgentHub.jsx and called from
// the same position, so hook order is unchanged.
interface UseDirectChatEventsArgs {
    setChatHistoryMode: Dispatch<SetStateAction<string>>;
    isMobile: boolean;
    setSidebarOpen: Dispatch<SetStateAction<boolean>>;
    setDirectChatMode: Dispatch<SetStateAction<boolean>>;
    setSelectedAgent: Dispatch<SetStateAction<AgentLike | null>>;
    setCurrentConversation: Dispatch<SetStateAction<IdRef | null>>;
    setCurrentDirectConversation: Dispatch<SetStateAction<IdRef | null>>;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setNotebookContent: Dispatch<SetStateAction<string>>;
    setNotebookSelection: Dispatch<SetStateAction<string>>;
    setShowNotebook: Dispatch<SetStateAction<boolean>>;
    setNotebookLinkedId: Dispatch<SetStateAction<string | null>>;
    updateDirectChatUrl: (convId: string | null) => void;
    loadDirectConversations: () => Promise<void>;
    loadModelTiers: () => Promise<void>;
    selectConversation: (agentId: string, convId: string) => Promise<void>;
}

/** The detail the "Open in Direct Chat" event carries (NotificationCenter). */
interface OpenWithContextDetail {
    title?: string;
    content?: string;
    agentId?: string;
    conversationId?: string;
    surface?: string;
}


const useDirectChatEvents = ({
    setChatHistoryMode,
    isMobile, setSidebarOpen,
    setDirectChatMode, setSelectedAgent,
    setCurrentConversation, setCurrentDirectConversation, setMessages,
    setNotebookContent, setNotebookSelection, setShowNotebook, setNotebookLinkedId,
    updateDirectChatUrl, loadDirectConversations, loadModelTiers, selectConversation,
}: UseDirectChatEventsArgs) => {
    // Listen for mode changes from Settings panel
    useEffect(() => {
        const handler = (e: Event) => {
            setChatHistoryMode((e as CustomEvent<SetStateAction<string>>).detail);
        };
        window.addEventListener('chatHistoryModeChanged', handler);
        return () => window.removeEventListener('chatHistoryModeChanged', handler);
    }, [setChatHistoryMode]);

    // Listen for "Open in Direct Chat" events from NotificationCenter (AI Task results).
    // An Effect Event: selectConversation and the load helpers are new each render.
    const openWithContext = useEffectEvent(async (detail: OpenWithContextDetail | null | undefined) => {
            const { title, content, agentId, conversationId, surface } = detail || {};
            if (!content) return;
            // What the seeded first message calls the thing — a cowork result
            // announcing itself as "my automation" is the wrong feature's name.
            const noun = surface === 'cowork' ? 'cowork' : 'automation';

            // R2: automation result came from an agent — open the agent's chat
            // (continuing the same conversation the automation ran in when
            // possible) instead of generic direct chat.
            if (agentId) {
                try {
                    const agentRes = await request(`${API_BASE}/agents/${agentId}`).catch((apiErr: unknown) => {
                        if (apiErr instanceof RefusedError) return null;
                        throw apiErr;
                    });
                    if (agentRes) {
                        const agent = await agentRes.json();
                        setDirectChatMode(false);
                        setSelectedAgent(agent);
                        scopedStorage.setItem('lastUsedMode', 'agent');
                        if (isMobile) setSidebarOpen(false);

                        // Try to attach the automation's persisted conversation so
                        // the user picks up the same thread the automation wrote
                        // to. Falls back to a fresh thread seeded with the
                        // result if the conversation can't be loaded.
                        if (conversationId) {
                            try { await selectConversation(agentId, conversationId); return; }
                            catch (err) { logger.debug('fall through', err); }
                        }
                        const now = new Date().toISOString();
                        setCurrentConversation(null);
                        setMessages([
                            { id: generateMessageId(), role: 'user',
                              content: `Show me the result from my ${noun} "${title}"`, timestamp: now },
                            { id: generateMessageId(), role: 'assistant',
                              content, timestamp: now,
                              respondingAgentAvatar: pickAgentAvatar(agent) || DEFAULT_AGENT_EMOJI },
                        ]);
                        return;
                    }
                } catch (err) {
                    console.warn('Failed to open agent for automation result, falling back to direct chat:', err);
                }
            }

            // Default path: direct chat (no agent on the automation, or lookup failed).
            setDirectChatMode(true);
            setSelectedAgent(null);
            setCurrentConversation(null);
            setCurrentDirectConversation(null);
            setMessages([]);
            setNotebookContent('');
            setNotebookSelection('');
            setShowNotebook(false);
            setNotebookLinkedId(null);
            scopedStorage.setItem('lastUsedMode', 'direct-chat');
            loadDirectConversations();
            loadModelTiers();
            updateDirectChatUrl(null);
            if (isMobile) setSidebarOpen(false);

            const now = new Date().toISOString();
            setTimeout(() => {
                setMessages([
                    { id: generateMessageId(), role: 'user',
                      content: `Show me the result from my ${noun} "${title}"`, timestamp: now },
                    { id: generateMessageId(), role: 'assistant',
                      content, timestamp: now, respondingAgentAvatar: '🤖' },
                ]);
            }, 100);
    });
    // The listener is the Effect Event itself (a reference, never called here):
    // the effect only subscribes, the request happens when the event fires.
    const onOpenWithContext = useEffectEvent((e: Event) => { openWithContext((e as CustomEvent<OpenWithContextDetail | null | undefined>).detail); });
    useEffect(() => {
        window.addEventListener('openDirectChatWithContext', onOpenWithContext);
        return () => window.removeEventListener('openDirectChatWithContext', onOpenWithContext);
    }, []);
};

export default useDirectChatEvents;
