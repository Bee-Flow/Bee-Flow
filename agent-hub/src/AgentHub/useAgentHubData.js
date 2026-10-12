import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import followToBottom from './followToBottom';
import { buildSidePanelPayload } from './sidePanelPayload';
import useChatSignals from '../components/chat/chatSignals/useChatSignals';
import { directChatKbList } from '../components/chat/knowledgeBaseClaim';
import useChatEngine from '../hooks/useChatEngine';
import { chatSignalsSurfaceFor, resolveTurnEndpoint } from '../hooks/useChatEngine/turnEndpoint';
import { DEFAULT_AGENT_EMOJI, pickAgentAvatar } from '../utils/agentAvatar';
import { API_BASE, authFetch, generateMessageId } from '../utils/helpers';
import { memoryLockOf, OPEN_MEMORY_PANEL_EVENT } from '../utils/memoryMode';
import { hasRenderableContent, normalizeLoadedMessages } from '../utils/messageShape';
import scopedStorage from '../utils/scopedStorage';
import { loadWorkspaceNotebook } from '../utils/workspaceNotebook';

// The data/engine core of AgentHub, moved verbatim from AgentHub.jsx: the
// per-user hydration effect, the chat engine wiring, UI/marketplace state,
// URL helpers, scroll effects, agent/KB stores, startup logic and the
// race-guarded selectConversation. Every hook below runs in AgentHub's fiber,
// in the exact call order the inline code had — this hook is called from the
// same position the block occupied.
const useAgentHubData = ({
    user, initialAgentId, initialConversationId, initialDirectConvId,
    showSettings, showAgentDesigner, showAgentWizard, showStudio, showSkillsPanel,
    coworkMode, setCoworkMode,
    selectedAgent, setSelectedAgent,
    directChatMode, setDirectChatMode,
    currentConversation, setCurrentConversation,
    currentDirectConversation, setCurrentDirectConversation,
    setConversations, setDirectConversations, setConversationLabels,
    setAgents, setAgentCategories, setModelTiers,
    selectedTier, setSelectedTier,
    activeProject,
    activeSkillIds, setActiveSkillIds, setChatHistoryMode,
    directSessionSkills, setDirectSessionSkills,
    directActivatedSessionSkillIds, setDirectActivatedSessionSkillIds, setDirectCompletedSessionSkillIds,
    directChatKBIds, setDirectChatKBIds,
    notebooksEnabled,
    notebookContent, setNotebookContent, notebookSelection, setNotebookSelection,
    showNotebook, setShowNotebook, setNotebookLinkedId,
    setShowGammaPreview, setGammaPreview,
    sidePanelWebpageId, sidePanelWebpage, sidePanelWebpageFiles, setSidePanelWebpageFiles, setSidePanelReloadKey,
    sidePanelDocumentId,
    attachedWebpageSelection,
    setSidebarOpen,
    setShowProjectsStore, setActiveProjectId,
}) => {
    // Hydrate user-scoped preferences once the user id is known.
    //
    // The original implementation chained the favorites fetch and the
    // legacy-favorites migration sequentially, gating first paint on both.
    // We now:
    //   1. Read local prefs synchronously (fast).
    //   2. Start the favorites GET — set state as soon as it lands so the
    //      sidebar can render its primary list.
    //   3. If a legacy migration is needed, run it in the background after
    //      the GET resolves — it must NOT block first paint, and a missing
    //      migration result silently falls back to the server response.
    useEffect(() => {
        if (!user?.id) return;
        // React fires child effects before parent effects on mount, so App.jsx's
        // scopedStorage.setCurrentUser hasn't run yet on first hydration. Set it
        // here (idempotent) so getItem returns the stored value instead of null.
        scopedStorage.setCurrentUser(user.id);
        const storedMode = scopedStorage.getItem('chatHistoryMode');
        if (storedMode) setChatHistoryMode(storedMode);
        const storedSkills = scopedStorage.getJSON('activeSkillIds', null);
        if (Array.isArray(storedSkills)) setActiveSkillIds(storedSkills);

        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/agents/favorites`);
                if (!res.ok) return;
                const serverFavs = await res.json();
                if (cancelled) return;
                const legacy = scopedStorage.getJSON('agentFavorites', null);
                const needsMigration =
                    Array.isArray(legacy) && legacy.length &&
                    Array.isArray(serverFavs) && serverFavs.length === 0;

                // Set whatever the server returned right away so the sidebar
                // can render. Migration (if needed) replaces this value later.
                setFavorites(Array.isArray(serverFavs) ? serverFavs : []);
                if (Array.isArray(legacy) && !needsMigration) {
                    scopedStorage.removeItem('agentFavorites');
                }

                if (needsMigration) {
                    // Background: replace the list with the merged result once
                    // the bulk upload comes back. Errors don't roll the UI back
                    // — the server state we just rendered is still correct.
                    authFetch(`${API_BASE}/agents/favorites/bulk`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ agentIds: legacy }),
                    }).then(async (bulkRes) => {
                        if (cancelled || !bulkRes.ok) return;
                        const merged = await bulkRes.json();
                        if (cancelled) return;
                        setFavorites(Array.isArray(merged) ? merged : []);
                        scopedStorage.removeItem('agentFavorites');
                    }).catch((e) => {
                        if (!cancelled) console.warn('[AgentHub] favorites migration failed:', e);
                    });
                }
            } catch (e) {
                console.warn('[AgentHub] Failed to load agent favorites from server:', e);
            }
        })();
        return () => { cancelled = true; };
    }, [user?.id, setChatHistoryMode, setActiveSkillIds]);

    // The conversation the latest turn wrote to, as the server reported it: a
    // new object per report. A chat started from a project shares exactly the
    // conversation its own turn created (useProjectChatStart), never whichever
    // chat happens to be on screen when the turn ends.
    const [turnConversation, setTurnConversation] = useState(null);

    // Chat signals: the notice for the endpoint the next turn really goes to
    // (resolved by the same function the engine uses, so a webpage panel,
    // which reroutes the turn, has no notice), and the marker the engine adds
    // to that turn. The engine reads the latest getter through a ref, so a
    // change of notice never rebuilds sendMessage.
    const chatSignals = useChatSignals({
        user,
        surface: chatSignalsSurfaceFor(resolveTurnEndpoint({
            isDirectMode: !!directChatMode,
            customEndpoint: sidePanelWebpageId ? '/ai/chat/webpage/stream' : undefined,
            agentId: selectedAgent?.id,
        })),
        agentId: selectedAgent?.id,
    });
    const chatSignalsPayloadRef = useRef(chatSignals.payloadFor);
    useEffect(() => { chatSignalsPayloadRef.current = chatSignals.payloadFor; }, [chatSignals.payloadFor]);
    const getChatSignalsPayload = useCallback((surface) => chatSignalsPayloadRef.current?.(surface) ?? null, []);
    // Lets the engine skip the "Remembered" lookup when memory is paused or off for the org.
    const getMemoryLock = useCallback(() => memoryLockOf(user), [user]);

    // Chat engine hook — owns messages, isLoading, sendMessage, stopGenerating
    const { messages, setMessages, isLoading, sendMessage, stopGenerating, retryMessage, editAndRegenerate } = useChatEngine({
        selectedAgent,
        currentConversation: directChatMode ? currentDirectConversation : currentConversation,
        onConversationCreated: useCallback((conversationId) => {
            // A direct turn's `done` lands here too: the chat on screen says which kind it is.
            setTurnConversation({ type: selectedAgent ? 'agent' : 'direct', id: conversationId });
            setCurrentConversation(prev => ({ ...prev, id: conversationId }));
            if (selectedAgent) {
                updateAgentUrl(selectedAgent.id, conversationId);
                loadConversations(selectedAgent.id);
            }
        }, [selectedAgent]),
        getNotebookPayload: useCallback(() => {
            // `notebookspaceAvailable` flags that the Notebook panel exists in
            // this UI even when it's closed (BFSF-207: gated on notebooksEnabled).
            // See sidePanelPayload.ts for the rest.
            return buildSidePanelPayload({
                notebooksEnabled, showNotebook, notebookContent, notebookSelection,
                sidePanelWebpageId, sidePanelWebpage, sidePanelDocumentId,
            });
        }, [notebookContent, notebookSelection, showNotebook, sidePanelWebpageId, sidePanelWebpage, sidePanelDocumentId, notebooksEnabled]),
        onNotebookUpdate: useCallback((content) => {
            // BFSF-207: never open the notebook panel for users without the
            // notebooks entitlement (server withholds the tools, this guards
            // stale/replayed SSE events too).
            if (!notebooksEnabled) return;
            // On mobile, silently ignore notebook writes from AI
            if (window.innerWidth < 768) return;
            setShowGammaPreview(false);
            setNotebookContent(content);
            if (content && content.trim()) setShowNotebook(true);
        }, [notebooksEnabled, setShowGammaPreview, setNotebookContent, setShowNotebook]),
        onGammaPreview: useCallback((preview) => {
            if (window.innerWidth < 768) return;
            setGammaPreview(prev => ({ ...(prev || {}), ...preview }));
            setShowNotebook(false);
            setShowGammaPreview(true);
        }, [setGammaPreview, setShowNotebook, setShowGammaPreview]),
        directMode: directChatMode ? {
            enabled: true,
            modelTier: selectedTier,
            // When the user has a webpage open in the side panel we reroute the
            // chat to the dedicated webpage endpoint — same one the standalone
            // Webpage Editor uses, so the AI gets the full toolbelt
            // (file/multi-file/db tools + sources).
            ...(sidePanelWebpageId ? { customEndpoint: '/ai/chat/webpage/stream' } : {}),
            getExtraPayload: () => ({
                ...(Array.isArray(directSessionSkills) && directSessionSkills.length > 0 ? { sessionSkills: directSessionSkills } : {}),
                ...(Array.isArray(directActivatedSessionSkillIds) && directActivatedSessionSkillIds.length > 0 ? { activatedSessionSkillIds: directActivatedSessionSkillIds } : {}),
                ...(Array.isArray(directChatKBIds) && directChatKBIds.length > 0 ? { knowledgeBaseIds: directChatKBIds } : {}),
                ...(sidePanelWebpageId ? {
                    webpageId: sidePanelWebpageId,
                    htmlContent: sidePanelWebpageFiles.html,
                    cssContent: sidePanelWebpageFiles.css,
                    jsContent: sidePanelWebpageFiles.js,
                    chatMode: 'auto',
                    ...(attachedWebpageSelection ? {
                        webpageSelection: {
                            text: attachedWebpageSelection.text,
                            file: 'html',
                        },
                    } : {}),
                } : {}),
            }),
        } : undefined,
        onWebpageDocUpdate: useCallback((data) => {
            const { file, content } = data || {};
            if (!file) return;
            setSidePanelWebpageFiles(prev => ({ ...prev, [file]: content || '' }));
            setSidePanelReloadKey(k => k + 1);
        }, [setSidePanelWebpageFiles, setSidePanelReloadKey]),
        onWebpageExtraUpdate: useCallback(() => {
            setSidePanelReloadKey(k => k + 1);
        }, [setSidePanelReloadKey]),
        onWebpageExtraDeleted: useCallback(() => {
            setSidePanelReloadKey(k => k + 1);
        }, [setSidePanelReloadKey]),
        onWebpageSourceAdded: useCallback(() => { /* surfaced inline in chat; no panel action */ }, []),
        activeProject,
        onDirectConversationCreated: useCallback(({ conversationId, title }) => {
            if (conversationId) setTurnConversation({ type: 'direct', id: conversationId });
            if (conversationId && !currentDirectConversation?.id) {
                setCurrentDirectConversation(prev => ({ ...prev, id: conversationId }));
                updateDirectChatUrl(conversationId);
            }
            if (title) {
                setCurrentDirectConversation(prev => prev ? { ...prev, title } : prev);
            }
            // Refresh conversations list
            loadDirectConversations();
        }, [currentDirectConversation]),
        activeSkillIds,
        onSessionSkillsChanged: useCallback(({ skills, activatedSkillIds, completedSkillIds }) => {
            setDirectSessionSkills(Array.isArray(skills) ? skills : []);
            setDirectActivatedSessionSkillIds(Array.isArray(activatedSkillIds) ? activatedSkillIds : []);
            if (Array.isArray(completedSkillIds)) {
                setDirectCompletedSessionSkillIds(completedSkillIds);
            }
        }, [setDirectSessionSkills, setDirectActivatedSessionSkillIds, setDirectCompletedSessionSkillIds]),
        // Refetch the persisted turn after a dropped stream. useChatEngine
        // exposes this hook and the recovery poller is gated on it — but the
        // main chat surface never passed one, so the whole auto-recovery path
        // was dead code exactly where it matters most. The server persists the
        // finished reply even when the SSE connection dies, so this turns an
        // "interrupted" notice into the real answer without a page reload.
        reloadConversation: useCallback(async () => {
            const convId = directChatMode ? currentDirectConversation?.id : currentConversation?.id;
            if (!convId) return null;
            const url = directChatMode
                ? `${API_BASE}/ai/direct/conversations/${convId}`
                : `${API_BASE}/agents/${selectedAgent?.id}/conversations/${convId}`;
            if (!directChatMode && !selectedAgent?.id) return null;
            const res = await authFetch(url);
            if (!res.ok) return null;
            const data = await res.json();
            const raw = typeof data.messages === 'string' ? JSON.parse(data.messages) : (data.messages || []);
            return normalizeLoadedMessages(raw)
                .filter(m => m.role !== 'tool' && m.role !== 'system' && hasRenderableContent(m))
                .map(({ toolCall, isStreaming, ...clean }) => clean);
        }, [directChatMode, currentDirectConversation?.id, currentConversation?.id, selectedAgent?.id]),
        getChatSignalsPayload,
        getMemoryLock,
    });

    // Once a thread has a message in it the mode is settled — see
    // CoworkModeToggle for why. `coworkMode` is hub-level state, so without this
    // reset, flipping to Work and then opening an existing conversation would
    // strand that chat in Cowork mode with the switch already hidden.
    const conversationStarted = messages.length > 0;
    useEffect(() => {
        if (conversationStarted && coworkMode === 'cowork') setCoworkMode('chat');
    }, [conversationStarted, coworkMode, setCoworkMode]);

    // Voice Chat (Beta) — completed voice turns flow up from the embedded
    // VoiceInlinePanel and are injected into the chat conversation here so
    // they render as regular MessageItem bubbles. Voice messages carry a
    // `source: 'voice'` marker plus an optional `tools` array (chip data).
    const handleVoiceTurnComplete = useCallback(({ user: userMsg, assistant: assistantMsg }) => {
        if (!userMsg) return;
        const timestamp = new Date().toISOString();
        const newMessages = [{
            id: generateMessageId(),
            role: 'user',
            content: userMsg.content || '',
            attachments: [],
            timestamp,
            source: 'voice',
        }];
        if (assistantMsg) {
            newMessages.push({
                id: generateMessageId(),
                role: 'assistant',
                content: assistantMsg.content || '',
                respondingAgentId: selectedAgent?.id || 'direct',
                respondingAgentName: selectedAgent?.name || null,
                respondingAgentAvatar: pickAgentAvatar(selectedAgent) || DEFAULT_AGENT_EMOJI,
                timestamp,
                source: 'voice',
                voiceTools: Array.isArray(assistantMsg.tools) ? assistantMsg.tools : [],
            });
        }
        setMessages(prev => [...prev, ...newMessages]);
        shouldForceScrollRef.current = true;
    }, [selectedAgent, setMessages]);




    // Skills handlers
    const handleToggleSkill = useCallback((skillId) => {
        setActiveSkillIds(prev => {
            const next = prev.includes(skillId)
                ? prev.filter(id => id !== skillId)
                : [...prev.slice(0, 4), skillId]; // max 5
            scopedStorage.setJSON('activeSkillIds', next);
            return next;
        });
    }, [setActiveSkillIds]);

    // Skills attached to the currently selected agent via agent.config.attachedSkillIds
    const agentAttachedSkillIds = useMemo(() => {
        const ids = selectedAgent?.config?.attachedSkillIds;
        return Array.isArray(ids) ? ids : [];
    }, [selectedAgent]);

    // UI/Mode State
    const [designMode, setDesignMode] = useState(false);
    const [createMode, setCreateMode] = useState(false);
    const [showMarketplace, setShowMarketplace] = useState(false);
    const [kbs, setKbs] = useState([]);
    const [kbsLoadedOnce, setKbsLoadedOnce] = useState(false);
    // Did GET /api/kb ever actually ANSWER? `kbs` is `[]` before the first
    // fetch and stays `[]` when one comes back 401/500, so the list alone
    // cannot tell "this user has no knowledge bases" from "we never got to
    // ask" — and the composer's KB pill has to tell those two apart, because
    // showing "nothing attached" for the second is a claim about where an
    // answer came from that nothing here can support. Only a readable array
    // sets this, and a later failed refresh leaves the last known list in
    // place rather than pretending the answer is empty.
    const [kbListKnown, setKbListKnown] = useState(false);
    // Direct-chat picker only sees KBs whose usage_contexts include 'direct_chat'.
    // (The Knowledge Bases marketplace continues to show the full `kbs` list.)
    // `null` until the list is known — see kbListKnown above; InputArea reads
    // null as "say nothing", never as "none".
    const directChatKbs = useMemo(() => directChatKbList(kbs, kbListKnown), [kbs, kbListKnown]);
    const [showSearch, setShowSearch] = useState(false);

    // Admin Theme Studio preview: when the iframe URL contains
    // ?themePreview=1, honour the optional hints — `overlay=search` auto-opens
    // the search overlay, `sidebar=collapsed` folds the conversation rail so
    // a Settings/Studio preview reads cleaner without the chat list dominating.
    useEffect(() => {
        try {
            const params = new URLSearchParams(window.location.search);
            if (params.get('themePreview') !== '1') return;
            if (params.get('overlay') === 'search') setShowSearch(true);
            if (params.get('sidebar') === 'collapsed') setSidebarOpen(false);
        } catch (_) { /* search params unavailable */ }
    }, [setSidebarOpen]);

    const [showMemoryPanel, setShowMemoryPanel] = useState(false);
    // Message rows (the "Memory used" and "Remembered" lines) ask for the panel
    // by event: they sit too deep in the tree to be handed a callback.
    useEffect(() => {
        const open = () => setShowMemoryPanel(true);
        window.addEventListener(OPEN_MEMORY_PANEL_EVENT, open);
        return () => window.removeEventListener(OPEN_MEMORY_PANEL_EVENT, open);
    }, []);
    const [showAgentMenu, setShowAgentMenu] = useState(false);

    // Favourites hydrate per-user via the same `user?.id` effect below.
    const [favorites, setFavorites] = useState([]);

    const messagesEndRef = useRef(null);
    const messagesContainerRef = useRef(null);
    const shouldForceScrollRef = useRef(false);
    // Bumped right before a loaded conversation's messages are set, in the
    // same batch: the effect below then opens it at its latest message
    // (BFSF-453). State rather than a flag on shouldForceScrollRef: its
    // effect runs on the commit that renders those messages, and the
    // effect's cleanup ends the follow when the next conversation opens.
    const [openAtLatestTick, setOpenAtLatestTick] = useState(0);
    const openAtLatest = useCallback(() => setOpenAtLatestTick(n => n + 1), []);
    const hasInitialized = useRef(false);
    const pendingConversationId = useRef(initialConversationId);
    const pendingDirectConvId = useRef(initialDirectConvId);

    // URL sync helper — updates browser URL to reflect selected agent/conversation
    // Uses first 8 chars of IDs for clean short URLs
    const updateAgentUrl = useCallback((agentId, conversationId) => {
        if (!agentId) {
            // Don't reset URL if in direct chat mode (handled by updateDirectChatUrl)
            if (!window.location.pathname.startsWith('/d/')) {
                window.history.replaceState({}, '', '/');
            }
            return;
        }
        const shortAgent = agentId.substring(0, 8);
        const path = conversationId
            ? `/a/${shortAgent}/${conversationId.substring(0, 8)}`
            : `/a/${shortAgent}`;
        window.history.replaceState({}, '', path);
    }, []);

    // URL sync helper for direct chat — /d/:8chars
    const updateDirectChatUrl = useCallback((convId) => {
        if (!convId) {
            window.history.replaceState({}, '', '/');
            return;
        }
        const shortConv = convId.substring(0, 8);
        window.history.replaceState({}, '', `/d/${shortConv}`);
    }, []);

    // --- Hooks ---


    const sendMessageRef = useRef(null);



    // --- Effects ---

    const scrollToBottom = (behavior = 'smooth') => {
        messagesEndRef.current?.scrollIntoView({ behavior });
    };

    useEffect(() => {
        const lastMsg = messages[messages.length - 1];
        const isStreaming = lastMsg?.isStreaming;

        // Force-scroll when user just sent a message
        if (shouldForceScrollRef.current) {
            shouldForceScrollRef.current = false;
            scrollToBottom('auto');
            return;
        }

        // Smart scroll: only auto-scroll if user is near the bottom
        const container = messagesContainerRef.current;
        if (container) {
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            const isNearBottom = distanceFromBottom < 300;
            if (isNearBottom) {
                scrollToBottom(isStreaming ? 'auto' : 'smooth');
            }
        } else {
            scrollToBottom(isStreaming ? 'auto' : 'smooth');
        }
    }, [messages]);

    // A conversation that was just loaded or restored opens at its latest
    // message, and stays there while images and code blocks finish laying
    // out, until the reader scrolls up (BFSF-453). Without this, only the
    // "near the bottom" rule above applied, and a reloaded list sits at
    // scrollTop 0, far from it. The cleanup stops the follow when the next
    // conversation opens or the hub unmounts.
    useEffect(() => {
        if (openAtLatestTick === 0) return undefined;
        const container = messagesContainerRef.current;
        return container ? followToBottom(container) : undefined;
    }, [openAtLatestTick]);

    useEffect(() => {
        sendMessageRef.current = (text) => sendMessage(text, []);
    }, [selectedAgent, isLoading]);

    // Global Cmd/Ctrl+K to open Search
    useEffect(() => {
        const onKey = (e) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setShowSearch(prev => !prev);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);



    // Reusable function to (re-)fetch the agent list shown across the hub.
    // Merges two sources so the list matches what the user can actually open:
    //   1. /agents/published — agents published in the user's org / groups
    //   2. /agents          — the user's own agents, INCLUDING personal drafts
    // Without (2), an agent set to "Personal" disappeared from the marketplace
    // for its own owner, even though they're the only person who can use it.
    const refreshAgents = useCallback(async () => {
        try {
            const [publishedRes, ownRes] = await Promise.all([
                authFetch(`${API_BASE}/agents/published?t=${Date.now()}`, { cache: 'no-store' }),
                authFetch(`${API_BASE}/agents?t=${Date.now()}`, { cache: 'no-store' }),
            ]);
            if (publishedRes.ok || ownRes.ok) {
                const published = publishedRes.ok ? await publishedRes.json() : [];
                const own = ownRes.ok ? await ownRes.json() : [];
                // Dedup by id — published records are authoritative when both
                // lists return the same agent (they carry parsed tool_params).
                const byId = new Map();
                for (const a of (Array.isArray(own) ? own : [])) byId.set(a.id, a);
                for (const a of (Array.isArray(published) ? published : [])) byId.set(a.id, a);
                const merged = Array.from(byId.values());
                setAgents(merged);

                // Also load agent categories
                try {
                    const catRes = await authFetch(`${API_BASE}/agents/categories`);
                    if (catRes.ok) {
                        const cats = await catRes.json();
                        setAgentCategories(Array.isArray(cats) ? cats : []);
                    }
                } catch (e) { console.warn('Failed to load agent categories', e); }

                return merged;
            }
        } catch (err) {
            console.error("Failed to refresh agents", err);
        }
        return null;
    }, [user, setAgents, setAgentCategories]);

    // Refresh agents whenever the Agent Store (marketplace) opens
    useEffect(() => {
        if (showMarketplace) refreshAgents();
    }, [showMarketplace, refreshAgents]);

    // ── Knowledge Bases ────────────────────────────────────────────────
    const refreshKBs = useCallback(async () => {
        try {
            // Studio is for KBs managed by the user. Webpage-owned KBs (auto-created
            // or explicitly tagged) are managed inside the webpage UI, not here.
            const kbRes = await authFetch(`${API_BASE}/api/kb?excludeContext=webpage&t=${Date.now()}`, { cache: 'no-store' });
            if (kbRes.ok) {
                const data = await kbRes.json();
                if (Array.isArray(data)) {
                    setKbs(data);
                    setKbListKnown(true);
                }
            }
            setKbsLoadedOnce(true);
        } catch (err) {
            console.error('Failed to refresh KBs', err);
        }
    }, []);

    // Lazy-load KBs the first time direct chat is active, so the input-area
    // picker has data to show without forcing the user to open the store first.
    useEffect(() => {
        if (directChatMode && !kbsLoadedOnce) refreshKBs();
    }, [directChatMode, kbsLoadedOnce, refreshKBs]);

    // Close the Projects views when the user navigates to a chat (agent or direct).
    // Mirrors how the agent marketplace closes itself in handleSelectAgent etc.
    useEffect(() => {
        if (showMarketplace || showSettings || showAgentDesigner || showAgentWizard || showStudio || showSkillsPanel) {
            setShowProjectsStore(false);
            setActiveProjectId(null);
        }
    }, [showMarketplace, showSettings, showAgentDesigner, showAgentWizard, showStudio, showSkillsPanel, setShowProjectsStore, setActiveProjectId]);

    // Load Agents and Handle Startup Logic
    useEffect(() => {
        const loadAgents = async () => {
            const data = await refreshAgents();
            if (!data) return;

            loadLabels(); // Always load labels on init

            // Startup Logic — URL agent takes priority over scopedStorage.
            // These four keys are user-specific preferences so they must not
                // survive an account switch on a shared browser.
            let targetId = initialAgentId;
            if (!targetId && !initialDirectConvId) {
                const mode = scopedStorage.getItem('defaultAgentMode') || 'last-used';
                const defaultId = scopedStorage.getItem('defaultAgentId');
                const lastUsedId = scopedStorage.getItem('lastUsedAgentId');
                if (mode === 'direct-chat') {
                    setDirectChatMode(true);
                    loadDirectConversations();
                    loadLabels();
                    loadModelTiers();
                } else if (mode === 'specific' && defaultId) {
                    targetId = defaultId;
                } else if (mode === 'last-used') {
                    const lastMode = scopedStorage.getItem('lastUsedMode');
                    if (lastMode === 'direct-chat') {
                        setDirectChatMode(true);
                        loadDirectConversations();
                        loadLabels();
                        loadModelTiers();
                    } else if (lastUsedId) {
                        targetId = lastUsedId;
                    }
                }
            }

            // Auto-load direct chat conversation from URL /d/:convId
            if (initialDirectConvId) {
                setDirectChatMode(true);
                loadModelTiers();
                loadLabels();
                loadDirectConversations().then(async () => {
                    try {
                        const convPrefix = initialDirectConvId;
                        const listRes = await authFetch(`${API_BASE}/ai/direct/conversations`);
                        if (listRes.ok) {
                            const convs = await listRes.json();
                            const match = convs.find(c => c.id === convPrefix || c.id.startsWith(convPrefix));
                            if (match) {
                                const detailRes = await authFetch(`${API_BASE}/ai/direct/conversations/${match.id}`);
                                if (detailRes.ok) {
                                    const detailData = await detailRes.json();
                                    setCurrentDirectConversation(detailData);
                                    // The knowledge bases this chat is grounded on come from
                                    // the detail GET and nowhere else: the server re-checks
                                    // access on every read, so its list is the authorised one
                                    // and a missing field means none rather than "keep what
                                    // the previous chat had".
                                    setDirectChatKBIds(Array.isArray(detailData.knowledgeBaseIds) ? detailData.knowledgeBaseIds : []);
                                    // normalizeLoadedMessages also marks policy-removed messages as deleted.
                                    // A restored chat opens at its latest message (BFSF-453).
                                    openAtLatest();
                                    setMessages(normalizeLoadedMessages(detailData.messages || []));
                                    if (detailData.model_tier) setSelectedTier(detailData.model_tier);
                                    updateDirectChatUrl(match.id);

                                    // Fetch notebook content
                                    await loadWorkspaceNotebook(
                                        `${API_BASE}/ai/direct/conversations/${match.id}/workspace`,
                                        { setNotebookLinkedId, setNotebookContent, setShowNotebook },
                                        { logLabel: 'Failed to fetch direct notebook from URL:' },
                                    );
                                }
                            }
                        }
                    } catch (e) { console.error('Failed to load direct conversation from URL:', e); }
                });
                scopedStorage.setItem('lastUsedMode', 'direct-chat');
            }

            if (targetId) {
                const targetAgent = data.find(a => a.id === targetId || a.id.startsWith(targetId));
                if (targetAgent) {
                    setSelectedAgent(targetAgent);
                }
            }
        };
        loadAgents();
    }, []);

    // Load Conversations when Agent Selected
    const loadConversations = useCallback(async (agentId) => {
        if (!agentId) return;
        try {
            const res = await authFetch(`${API_BASE}/agents/${agentId}/conversations`);
            if (res.ok) {
                const data = await res.json();
                setConversations(data.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));
            }
        } catch (err) {
            console.error("Failed to load conversations", err);
        }
    }, [setConversations]);

    useEffect(() => {
        if (selectedAgent) {
            loadConversations(selectedAgent.id).then(async () => {
                // Auto-select conversation from URL on initial load
                if (pendingConversationId.current) {
                    const convPrefix = pendingConversationId.current;
                    pendingConversationId.current = null; // only once
                    // Find full conversation ID by prefix match
                    const res2 = await authFetch(`${API_BASE}/agents/${selectedAgent.id}/conversations`);
                    if (res2.ok) {
                        const convs = await res2.json();
                        const match = convs.find(c => c.id === convPrefix || c.id.startsWith(convPrefix));
                        if (match) {
                            selectConversation(selectedAgent.id, match.id);
                        }
                    }
                } else if (!/^\/app\/documents(?:\/|$)/.test(window.location.pathname)) {
                    // A stored default agent initializes behind the member
                    // library too. Keep the bookmarked document address intact.
                    updateAgentUrl(selectedAgent.id, null);
                }
            });
        } else {
            setConversations([]);
            setMessages([]);
            setCurrentConversation(null);
            setNotebookContent('');
            setNotebookSelection('');
            setShowNotebook(false);
            setNotebookLinkedId(null);
        }
    }, [selectedAgent, loadConversations]);

    // Generation counter for selectConversation — same guard as
    // NotebooksPage.selectNotebook. Two sequential awaits (the conversation
    // GET, then the workspace GET) mean a slow response for conversation A can
    // land AFTER the user has already clicked B, and every setter below then
    // re-applies A on top of B: the messages, the URL, the notebook pane and
    // the sidebar highlight (which derives from currentConversation). The click
    // on B is silently lost, and the next send — plus saveNotebook's PUT —
    // goes to whichever id won the race. Every write is gated on still being
    // the newest selection.
    const selectConvGenRef = useRef(0);

    // Load Messages when Conversation Selected
    const selectConversation = async (agentId, convId) => {
        const gen = ++selectConvGenRef.current;
        const isStale = () => selectConvGenRef.current !== gen;
        try {
            const res = await authFetch(`${API_BASE}/agents/${agentId}/conversations/${convId}`);
            if (isStale()) return;
            if (res.ok) {
                const data = await res.json();
                if (isStale()) return;
                setCurrentConversation(data);
                updateAgentUrl(agentId, data.id);

                // Fetch notebook content — always swap to match the selected conversation
                if (agentId && data.id) {
                    // The setters are wrapped rather than checked afterwards:
                    // loadWorkspaceNotebook applies them itself, so this is the
                    // only place a newer selection can be honoured.
                    await loadWorkspaceNotebook(
                        `${API_BASE}/agents/${agentId}/conversations/${data.id}/workspace`,
                        {
                            setNotebookLinkedId: (v) => { if (!isStale()) setNotebookLinkedId(v); },
                            setNotebookContent: (v) => { if (!isStale()) setNotebookContent(v); },
                            setShowNotebook: (v) => { if (!isStale()) setShowNotebook(v); },
                        },
                        { logLabel: 'Failed to fetch notebook' },
                    );
                    if (isStale()) return;
                }

                let parsedMessages = [];
                if (typeof data.messages === 'string') {
                    parsedMessages = JSON.parse(data.messages);
                } else {
                    parsedMessages = data.messages || [];
                }

                // Canonicalise FIRST: normalizeLoadedMessages flattens block content
                // to text (BFSF-307), so everything below can assume a string.
                parsedMessages = normalizeLoadedMessages(parsedMessages);

                // Filter out tool messages and empty messages - only show user and assistant with content
                // `system` is dropped too: chatStream injects a tool-loop nudge as a
                // system turn, and MessageItem only special-cases user/tool, so a
                // persisted system row renders as an assistant bubble.
                parsedMessages = parsedMessages.filter(m =>
                    m.role !== 'tool' && m.role !== 'system' && hasRenderableContent(m)
                );

                // Strip streaming-only progress fields — these are only relevant during live chat
                parsedMessages = parsedMessages.map(m => {
                    const { toolCall, isStreaming, ...clean } = m;
                    // Strip raw tool-call JSON blocks from content (e.g. { "action": "generate_image", ... })
                    if (clean.content && typeof clean.content === 'string' && clean.role === 'assistant') {
                        clean.content = clean.content.replace(/\{\s*"action":\s*"[^"]*"\s*,\s*"action_input":\s*"[^"]*"(?:\s*\}\s*,\s*"thought":\s*"[^"]*"\s*\}|\s*\})/g, '').trim();
                    }
                    return clean;
                });


                // Remove messages that became empty after cleanup
                parsedMessages = parsedMessages.filter(m => m.role === 'user' || hasRenderableContent(m));

                if (isStale()) return;
                // A loaded conversation opens at its latest message (BFSF-453).
                openAtLatest();
                setMessages(parsedMessages);
            }
        } catch (err) {
            console.error("Failed to load conversation", err);
        }
    };

    // --- Direct Chat Handlers ---

    const loadDirectConversations = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/direct/conversations`);
            if (res.ok) setDirectConversations(await res.json());
        } catch (e) { console.error('Failed to load direct conversations:', e); }
    };

    const loadLabels = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/labels`);
            if (res.ok) setConversationLabels(await res.json());
        } catch (e) { console.error('Failed to load labels:', e); }
    };

    const loadModelTiers = async () => {
        try {
            // Use the permission- and task-aware endpoint so custom tiers appear
            // only when the user's groups grant access AND the tier is allowed
            // for the direct_chat task type. Standard tiers always pass through.
            const res = await authFetch(`${API_BASE}/ai/config/tiers-for-user?taskType=direct_chat`);
            if (res.ok) setModelTiers(await res.json());
        } catch (e) { console.error('Failed to load model tiers:', e); }
    };

    return {
        messages, setMessages, isLoading, sendMessage, stopGenerating, retryMessage, editAndRegenerate,
        turnConversation, chatSignals,
        conversationStarted, handleVoiceTurnComplete,
        handleToggleSkill, agentAttachedSkillIds,
        designMode, setDesignMode,
        showMarketplace, setShowMarketplace,
        kbs, directChatKbs,
        showSearch, setShowSearch,
        showMemoryPanel, setShowMemoryPanel,
        showAgentMenu, setShowAgentMenu,
        favorites, setFavorites,
        messagesEndRef, messagesContainerRef, shouldForceScrollRef, openAtLatest,
        updateAgentUrl, updateDirectChatUrl,
        refreshAgents, refreshKBs,
        loadConversations, selectConversation,
        loadDirectConversations, loadLabels, loadModelTiers,
    };
};

export default useAgentHubData;
