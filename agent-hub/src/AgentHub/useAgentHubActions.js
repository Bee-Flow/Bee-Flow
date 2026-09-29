import { API_BASE, authFetch } from '../utils/helpers';
import { normalizeLoadedMessages } from '../utils/messageShape';
import scopedStorage from '../utils/scopedStorage';
import { loadWorkspaceNotebook } from '../utils/workspaceNotebook';

// Navigation-level handlers of the hub: selecting agents and conversations,
// entering direct chat, new chat / delete, search-result routing, favourites,
// unpublish and the notebook save/open-in-notebook paths. Plain closures (no
// hooks) moved verbatim from AgentHub.jsx; they are recreated per render
// exactly as before. `closeAllOverlays` stays in AgentHub.jsx (it is pinned
// by AgentHub.overlayOrder.test.js) and is passed in.
const useAgentHubActions = ({
    agents, conversations, favorites, setFavorites,
    selectedAgent, setSelectedAgent, directChatMode, setDirectChatMode,
    currentConversation, setCurrentConversation,
    currentDirectConversation, setCurrentDirectConversation,
    setConversations, setDirectConversations, setAllAgentConversations,
    setMessages, setDirectSessionSkills, setDirectActivatedSessionSkillIds, setDirectCompletedSessionSkillIds,
    setDirectChatKBIds,
    setNotebookContent, setNotebookSelection, setShowNotebook,
    notebookLinkedId, setNotebookLinkedId,
    setSelectedTier, setDesignMode,
    setShowMarketplace,
    setShowProjectsStore, setActiveProjectId, setShowSearch,
    isMobile, setSidebarOpen, closeAllOverlays,
    updateAgentUrl, updateDirectChatUrl,
    refreshAgents, selectConversation, loadDirectConversations, loadModelTiers,
    onNavigate,
    confirm,
    openAtLatest,
}) => {
    // --- Actions ---

    const handleSelectAgent = (agent) => {
        closeAllOverlays();
        setSelectedAgent(agent);
        setDesignMode(false);
        setDirectChatMode(false);

        // Auto-start new chat — reset notebook only when switching agents
        setCurrentConversation({ id: null, title: 'New Chat', messages: [] });
        setMessages([]);
        setNotebookContent('');
        setNotebookSelection('');
        setShowNotebook(false);
        setNotebookLinkedId(null);

        // Auto-close sidebar on mobile
        if (isMobile) setSidebarOpen(false);

        // Persist last used & update URL
        if (agent) {
            scopedStorage.setItem('lastUsedAgentId', agent.id);
            scopedStorage.setItem('lastUsedMode', 'agent');
            updateAgentUrl(agent.id, null);
        } else {
            updateAgentUrl(null, null);
        }
    };

    const handleDirectChat = () => {
        setDirectChatMode(true);
        setSelectedAgent(null);
        setCurrentConversation(null);
        setMessages([]);
        setCurrentDirectConversation(null);
        setDirectSessionSkills([]);
        setDirectActivatedSessionSkillIds([]);
        setDirectCompletedSessionSkillIds([]);
        // A new chat is grounded on nothing until this one says otherwise —
        // carrying the previous conversation's bases over would attach them
        // silently on the first turn.
        setDirectChatKBIds([]);
        setNotebookContent('');
        setNotebookSelection('');
        setShowNotebook(false);
        setNotebookLinkedId(null);
        setSelectedTier('auto');
        setShowMarketplace(false);
        setShowProjectsStore(false);
        setActiveProjectId(null);
        closeAllOverlays();
        scopedStorage.setItem('lastUsedMode', 'direct-chat');
        loadDirectConversations();
        loadModelTiers();
        updateDirectChatUrl(null);
    };

    const handleSelectDirectConversation = async (conv) => {
        try {
            const res = await authFetch(`${API_BASE}/ai/direct/conversations/${conv.id}`);
            if (res.ok) {
                const data = await res.json();
                setCurrentDirectConversation(data);
                setDirectSessionSkills(Array.isArray(data.sessionSkills) ? data.sessionSkills : []);
                setDirectActivatedSessionSkillIds(Array.isArray(data.activatedSessionSkillIds) ? data.activatedSessionSkillIds : []);
                setDirectCompletedSessionSkillIds(Array.isArray(data.completedSessionSkillIds) ? data.completedSessionSkillIds : []);
                // What this chat is grounded on is the SERVER's answer, re-authorised
                // on this read — never what the previous conversation left in state. A
                // missing field means none: the composer then shows an empty pill, which
                // is only honest because the list itself came back.
                setDirectChatKBIds(Array.isArray(data.knowledgeBaseIds) ? data.knowledgeBaseIds : []);
                // normalizeLoadedMessages handles both the deleted-placeholder
                // marking AND lifting legacy string thinking into the canonical
                // thinkingParts shape the UI expects. A picked chat opens at
                // its latest message (BFSF-453).
                openAtLatest();
                setMessages(normalizeLoadedMessages(data.messages || []));
                if (data.model_tier) setSelectedTier(data.model_tier);
                updateDirectChatUrl(conv.id);

                // Fetch notebook content — always swap to match the selected conversation
                await loadWorkspaceNotebook(
                    `${API_BASE}/ai/direct/conversations/${conv.id}/workspace`,
                    { setNotebookLinkedId, setNotebookContent, setShowNotebook },
                    { logLabel: 'Failed to fetch direct notebook' },
                );
            }
        } catch (e) { console.error('Failed to load direct conversation:', e); }
    };

    const handleDeleteDirectConversation = async (convId) => {
        try {
            await authFetch(`${API_BASE}/ai/direct/conversations/${convId}`, { method: 'DELETE' });
            setDirectConversations(prev => prev.filter(c => c.id !== convId));
            setAllAgentConversations(prev => prev.filter(c => c.id !== convId));
            if (currentDirectConversation?.id === convId) {
                setCurrentDirectConversation(null);
                setMessages([]);
                setDirectSessionSkills([]);
                setDirectActivatedSessionSkillIds([]);
                setDirectChatKBIds([]);
            }
        } catch (e) { console.error('Failed to delete direct conversation:', e); }
    };

    const handleNewChat = () => {
        closeAllOverlays();
        if (directChatMode) {
            setCurrentDirectConversation(null);
            setMessages([]);
            setDirectSessionSkills([]);
            setDirectActivatedSessionSkillIds([]);
            setDirectChatKBIds([]);
            setNotebookContent('');
            setNotebookSelection('');
            setShowNotebook(false);
            setNotebookLinkedId(null);
            setSelectedTier('auto');
            updateDirectChatUrl(null);
            return;
        }
        if (!selectedAgent) {
            // No agent selected — fall back to direct chat mode
            setDirectChatMode(true);
            setSelectedAgent(null);
            setCurrentDirectConversation(null);
            setMessages([]);
            setDirectSessionSkills([]);
            setDirectActivatedSessionSkillIds([]);
            setNotebookContent('');
            setNotebookSelection('');
            setShowNotebook(false);
            setNotebookLinkedId(null);
            setSelectedTier('auto');
            scopedStorage.setItem('lastUsedMode', 'direct-chat');
            loadDirectConversations();
            loadModelTiers();
            updateDirectChatUrl(null);
            return;
        }
        setCurrentConversation({ id: null, title: 'New Chat', messages: [] });
        setMessages([]);
        setSelectedTier('auto');
        setNotebookContent('');
        setNotebookSelection('');
        setShowNotebook(false);
        setNotebookLinkedId(null);
        updateAgentUrl(selectedAgent.id, null);
    };
    const handleDeleteConversation = async (convId, agentId) => {
        try {
            agentId = agentId || selectedAgent?.id;
            if (!agentId) {
                console.error('Delete failed: no agentId available');
                return;
            }
            const res = await authFetch(`${API_BASE}/agents/${agentId}/conversations/${convId}`, { method: 'DELETE' });
            if (!res.ok) {
                console.error('Delete failed with status:', res.status);
                return;
            }
            setConversations(prev => prev.filter(c => c.id !== convId));
            setAllAgentConversations(prev => prev.filter(c => c.id !== convId));
            if (currentConversation?.id === convId) {
                handleNewChat();
            }
        } catch (err) {
            console.error("Delete failed", err);
        }
    };

    const handleSearchResultSelect = (result) => {
        setShowSearch(false);
        if (result.kind === 'direct') {
            setDirectChatMode(true);
            handleSelectDirectConversation({ id: result.id });
            return;
        }
        // Switch agent if needed
        if (!selectedAgent || selectedAgent.id !== result.agent_id) {
            const agent = agents.find(a => a.id === result.agent_id);
            if (agent) {
                handleSelectAgent(agent);
            }
        }
        // Open conversation
        selectConversation(result.agent_id, result.id);
    };

    const getGroupedConversations = () => {
        const groups = { Today: [], Yesterday: [], 'Last 30 Days': [], Older: [] };

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        conversations.forEach(c => {
            const date = new Date(c.updated_at);
            const msgStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());

            const diffDays = Math.floor((todayStart - msgStart) / (1000 * 60 * 60 * 24));

            if (diffDays <= 0) groups.Today.push(c);
            else if (diffDays === 1) groups.Yesterday.push(c);
            else if (diffDays <= 30) groups['Last 30 Days'].push(c);
            else groups.Older.push(c);
        });
        return Object.entries(groups).filter(([_, list]) => list.length > 0);
    };

    const handleToggleFavorite = async (id) => {
        const wasFav = favorites.includes(id);
        const newFavs = wasFav ? favorites.filter(f => f !== id) : [...favorites, id];
        setFavorites(newFavs);
        try {
            const res = await authFetch(`${API_BASE}/agents/${id}/favorite`, {
                method: wasFav ? 'DELETE' : 'PUT',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
            console.error('[AgentHub] Failed to toggle agent favorite:', e);
            setFavorites(favorites);
        }
    };

    const handleUnpublishAgent = async (agentId) => {
        if (!(await confirm({ title: 'Unpublish this agent?', description: 'It will no longer be visible in the Agent Store, but its configuration will be preserved.', confirmLabel: 'Unpublish', destructive: true }))) return;
        try {
            const res = await authFetch(`${API_BASE}/agents/${agentId}/publish`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isPublished: false })
            });
            if (res.ok) {
                // If this was the currently selected agent, deselect it
                if (selectedAgent?.id === agentId) {
                    setSelectedAgent(null);
                }
                refreshAgents();
            }
        } catch (err) {
            console.error('Failed to unpublish agent:', err);
        }
    };

    const saveNotebook = async (content, nbId) => {
        setNotebookContent(content); // Optimistic update

        // If a new notebook ID was provided, persist it
        const notebookIdToSave = nbId !== undefined ? nbId : notebookLinkedId;

        try {
            if (directChatMode && currentDirectConversation?.id) {
                // Direct chat notebook save
                await authFetch(`${API_BASE}/ai/direct/conversations/${currentDirectConversation.id}/workspace`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content, notebookId: notebookIdToSave })
                });
            } else if (selectedAgent && currentConversation?.id) {
                // Agent chat notebook save
                await authFetch(`${API_BASE}/agents/${selectedAgent.id}/conversations/${currentConversation.id}/workspace`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content, notebookId: notebookIdToSave })
                });
            }
        } catch (err) {
            console.error('Failed to save notebook', err);
        }
    };

    const handleOpenInNotebook = async (markdownContent, existingNotebookId) => {
        try {
            let nbId = existingNotebookId;

            // If no existing notebook, create one
            if (!nbId) {
                const createRes = await authFetch(`${API_BASE}/api/notebooks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: `Chat Notebook – ${new Date().toLocaleDateString()}` }),
                });
                if (!createRes.ok) throw new Error('Failed to create notebook');
                const { notebook } = await createRes.json();
                nbId = notebook.id;
            }

            // Sync markdown content to the notebook's document field
            await authFetch(`${API_BASE}/api/notebooks/${nbId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentContent: markdownContent }),
            });

            // Navigate to the notebook
            if (onNavigate) onNavigate(`notebooks/${nbId}`);
        } catch (err) {
            console.error('[AgentHub] Failed to open in notebook:', err);
        }
    };

    return {
        handleSelectAgent, handleDirectChat,
        handleSelectDirectConversation, handleDeleteDirectConversation,
        handleNewChat, handleDeleteConversation, handleSearchResultSelect,
        getGroupedConversations, handleToggleFavorite, handleUnpublishAgent,
        saveNotebook, handleOpenInNotebook,
    };
};

export default useAgentHubActions;
