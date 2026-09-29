import { useCallback, useEffect, useEffectEvent } from 'react';
import { DEFAULT_AGENT_EMOJI, pickAgentAvatar } from '../utils/agentAvatar';
import { API_BASE, authFetch, generateMessageId } from '../utils/helpers';
import scopedStorage from '../utils/scopedStorage';

// The "All Chats" aggregation and the window-event listeners that steer the
// hub from outside (Settings' chat-history-mode switch, NotificationCenter's
// "Open in Direct Chat"). Moved verbatim from AgentHub.jsx and called from
// the same position, so hook order is unchanged.
const useDirectChatEvents = ({
    chatHistoryMode, setChatHistoryMode, setAllAgentConversations,
    isMobile, setSidebarOpen,
    setDirectChatMode, setSelectedAgent,
    setCurrentConversation, setCurrentDirectConversation, setMessages,
    setNotebookContent, setNotebookSelection, setShowNotebook, setNotebookLinkedId,
    updateDirectChatUrl, loadDirectConversations, loadModelTiers, selectConversation,
}) => {
    // Load ALL conversations across all agents (for "All Chats" mode)
    const loadAllConversations = useCallback(async () => {
        try {
            const [agentRes, directRes] = await Promise.all([
                authFetch(`${API_BASE}/agents/conversations/all`),
                authFetch(`${API_BASE}/ai/direct/conversations`),
            ]);
            let all = [];
            if (agentRes.ok) {
                const agentConvs = await agentRes.json();
                all = [...agentConvs.map(c => ({ ...c, _source: 'agent' }))];
            }
            if (directRes.ok) {
                const directConvs = await directRes.json();
                all = [...all, ...directConvs.map(c => ({ ...c, _source: 'direct' }))];
            }
            all.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
            setAllAgentConversations(all);
        } catch (e) { console.error('Failed to load all conversations:', e); }
    }, [setAllAgentConversations]);

    // Load all conversations when mode is 'all-chats'
    useEffect(() => {
        if (chatHistoryMode === 'all-chats') loadAllConversations();
    }, [chatHistoryMode, loadAllConversations]);

    // Listen for mode changes from Settings panel
    useEffect(() => {
        const handler = (e) => {
            setChatHistoryMode(e.detail);
        };
        window.addEventListener('chatHistoryModeChanged', handler);
        return () => window.removeEventListener('chatHistoryModeChanged', handler);
    }, [setChatHistoryMode]);

    // Listen for "Open in Direct Chat" events from NotificationCenter (AI Task results).
    // An Effect Event: selectConversation and the load helpers are new each render.
    const openWithContext = useEffectEvent(async (detail) => {
            const { title, content, agentId, conversationId, surface } = detail || {};
            if (!content) return;
            // What the seeded first message calls the thing — a cowork result
            // announcing itself as "my routine" is the wrong feature's name.
            const noun = surface === 'cowork' ? 'cowork' : 'routine';

            // R2: routine result came from an agent — open the agent's chat
            // (continuing the same conversation the routine ran in when
            // possible) instead of generic direct chat.
            if (agentId) {
                try {
                    const agentRes = await authFetch(`${API_BASE}/agents/${agentId}`);
                    if (agentRes.ok) {
                        const agent = await agentRes.json();
                        setDirectChatMode(false);
                        setSelectedAgent(agent);
                        scopedStorage.setItem('lastUsedMode', 'agent');
                        if (isMobile) setSidebarOpen(false);

                        // Try to attach the routine's persisted conversation so
                        // the user picks up the same thread the routine wrote
                        // to. Falls back to a fresh thread seeded with the
                        // result if the conversation can't be loaded.
                        if (conversationId) {
                            try { await selectConversation(agentId, conversationId); return; }
                            catch (_) { /* fall through */ }
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
                    console.warn('Failed to open agent for routine result, falling back to direct chat:', err);
                }
            }

            // Default path: direct chat (no agent on the routine, or lookup failed).
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
    useEffect(() => {
        const handler = (e) => { openWithContext(e.detail); };
        window.addEventListener('openDirectChatWithContext', handler);
        return () => window.removeEventListener('openDirectChatWithContext', handler);
    }, []);
};

export default useDirectChatEvents;
