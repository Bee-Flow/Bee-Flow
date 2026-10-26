import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildSidePanelPayload } from './sidePanelPayload';
import { updateAgentUrl, updateDirectChatUrl } from './hubUrl';
import useChatScroll from './useChatScroll';
import useHubStartup from './useHubStartup';
import useSelectConversation from './useSelectConversation';
import useChatSignals from '../components/chat/chatSignals/useChatSignals';
import useChatEngine from '../hooks/useChatEngine';
import { chatSignalsSurfaceFor, resolveTurnEndpoint, type ChatSignalsTurnSurface } from '../hooks/useChatEngine/turnEndpoint';
import { DEFAULT_AGENT_EMOJI, pickAgentAvatar } from '../utils/agentAvatar';
import { API_BASE, generateMessageId } from '../utils/helpers';
import { memoryLockOf } from '../utils/memoryMode';
import { hasRenderableContent, normalizeLoadedMessages, type ShapedMessage } from '../utils/messageShape';
import type { GammaPreview } from '../hooks/useChatEngine/sse/gammaPreview';
import type { ChatMessage } from '../hooks/useChatEngine/types';
import type { SessionSkill } from '../components/skills/sessionSkillState';
import type { TurnConversation } from './useProjectChatStart';
import type { UseAgentHubDataArgs } from './useAgentHubData.types';
import { request, RefusedError } from '../api/mutate';
export type { IdRef, AgentLike, HubUser } from './useAgentHubData.types';

// The chat core of AgentHub: the chat engine wiring (chat signals, the
// notebook / webpage / skills payloads a turn carries), the voice turns that
// flow into the conversation, the scroll behaviour of the message list, and
// the two flows that open conversations (useSelectConversation, useHubStartup).
// What the hub only SHOWS lives in slices that own their state and read
// through the query cache: useAgentFavorites, useAgentCatalog,
// useHubKnowledgeBases, useConversationLists, useHubPrefs, useHubOverlays.
const useAgentHubData = ({
    user, route, chat, skills, notebook, gamma, webpage, lists,
}: UseAgentHubDataArgs) => {
    const { initialAgentId, initialConversationId, initialDirectConvId } = route;
    const {
        selectedAgent, setSelectedAgent, directChatMode, setDirectChatMode,
        currentConversation, setCurrentConversation, currentDirectConversation, setCurrentDirectConversation,
        selectedTier, setSelectedTier, activeProject, coworkMode, setCoworkMode,
    } = chat;
    const {
        activeSkillIds, directSessionSkills, directActivatedSessionSkillIds,
        setDirectSessionSkills, setDirectActivatedSessionSkillIds, setDirectCompletedSessionSkillIds,
        directChatKBIds, setDirectChatKBIds,
    } = skills;
    const {
        notebooksEnabled, notebookContent, notebookSelection, showNotebook,
        setNotebookContent, setNotebookSelection, setShowNotebook, setNotebookLinkedId,
    } = notebook;
    const { setShowGammaPreview, setGammaPreview } = gamma;
    const {
        sidePanelWebpageId, sidePanelWebpage, sidePanelWebpageFiles, setSidePanelWebpageFiles,
        setSidePanelReloadKey, sidePanelDocumentId, attachedWebpageSelection,
    } = webpage;
    const { refreshAgents, loadConversations, loadDirectConversations, loadLabels, loadModelTiers } = lists;

    // The conversation the latest turn wrote to, as the server reported it: a
    // new object per report. A chat started from a project shares exactly the
    // conversation its own turn created (useProjectChatStart), never whichever
    // chat happens to be on screen when the turn ends.
    const [turnConversation, setTurnConversation] = useState<TurnConversation | null>(null);

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
    const getChatSignalsPayload = useCallback((surface: ChatSignalsTurnSurface) => chatSignalsPayloadRef.current?.(surface) ?? null, []);
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
        }, [selectedAgent, setCurrentConversation, loadConversations]),
        getNotebookPayload: useCallback(() => {
            // `notebookspaceAvailable` flags that the Notebook panel exists in
            // this UI even when it's closed (BFSF-207: gated on notebooksEnabled).
            // See sidePanelPayload.ts for the rest.
            return buildSidePanelPayload({
                notebooksEnabled, showNotebook, notebookContent, notebookSelection,
                sidePanelWebpageId, sidePanelWebpage, sidePanelDocumentId,
            });
        }, [notebookContent, notebookSelection, showNotebook, sidePanelWebpageId, sidePanelWebpage, sidePanelDocumentId, notebooksEnabled]),
        onNotebookUpdate: useCallback((content?: string) => {
            // BFSF-207: never open the notebook panel for users without the
            // notebooks entitlement (server withholds the tools, this guards
            // stale/replayed SSE events too).
            if (!notebooksEnabled) return;
            // On mobile, silently ignore notebook writes from AI
            if (window.innerWidth < 768) return;
            setShowGammaPreview(false);
            setNotebookContent(content as string);
            if (content && content.trim()) setShowNotebook(true);
        }, [notebooksEnabled, setShowGammaPreview, setNotebookContent, setShowNotebook]),
        onGammaPreview: useCallback((preview: unknown) => {
            if (window.innerWidth < 768) return;
            setGammaPreview(prev => ({ ...(prev || {}), ...(preview as GammaPreview) }));
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
        onWebpageDocUpdate: useCallback((data: { file: unknown; content: unknown; title: unknown }) => {
            const { file, content } = data || {};
            if (!file) return;
            setSidePanelWebpageFiles(prev => ({ ...prev, [String(file)]: content || '' }));
            setSidePanelReloadKey(k => k + 1);
        }, [setSidePanelWebpageFiles, setSidePanelReloadKey]),
        onWebpageExtraUpdate: useCallback(() => {
            setSidePanelReloadKey(k => k + 1);
        }, [setSidePanelReloadKey]),
        onWebpageExtraDeleted: useCallback(() => {
            setSidePanelReloadKey(k => k + 1);
        }, [setSidePanelReloadKey]),
        onWebpageSourceAdded: useCallback(() => { /* surfaced inline in chat; no panel action */ }, []),
        activeProject: activeProject as { id?: string; [key: string]: unknown } | null,
        onDirectConversationCreated: useCallback((info: unknown) => {
            const { conversationId, title } = info as { conversationId?: string; title?: string };
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
        }, [currentDirectConversation, setCurrentDirectConversation, loadDirectConversations]),
        activeSkillIds,
        onSessionSkillsChanged: useCallback((payload: unknown) => {
            const { skills, activatedSkillIds, completedSkillIds } = payload as { skills?: SessionSkill[]; activatedSkillIds?: string[]; completedSkillIds?: string[] };
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
            let res: Response;
            try {
                res = await request(url);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                return null;
            }
            const data = await res.json();
            const raw = typeof data.messages === 'string' ? JSON.parse(data.messages) : (data.messages || []);
            return normalizeLoadedMessages<ChatMessage & ShapedMessage>(raw)
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

    const { messagesEndRef, messagesContainerRef, shouldForceScrollRef, openAtLatest } = useChatScroll(messages);

    // Voice Chat (Beta) — completed voice turns flow up from the embedded
    // VoiceInlinePanel and are injected into the chat conversation here so
    // they render as regular MessageItem bubbles. Voice messages carry a
    // `source: 'voice'` marker plus an optional `tools` array (chip data).
    const handleVoiceTurnComplete = useCallback(({ user: userMsg, assistant: assistantMsg }: { user?: { content?: string } | null; assistant?: { content?: string; tools?: unknown[] } | null }) => {
        if (!userMsg) return;
        const timestamp = new Date().toISOString();
        const newMessages: ChatMessage[] = [{
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
    }, [selectedAgent, setMessages, shouldForceScrollRef]);

    const agentAttachedSkillIds = useMemo(() => {
        const ids = selectedAgent?.config?.attachedSkillIds;
        return Array.isArray(ids) ? ids : [];
    }, [selectedAgent]);

    const selectConversation = useSelectConversation({
        setCurrentConversation, setMessages, setNotebookContent, setShowNotebook, setNotebookLinkedId, openAtLatest,
    });
    useHubStartup({
        initialAgentId, initialConversationId, initialDirectConvId,
        selectedAgent, setSelectedAgent, setDirectChatMode,
        setCurrentConversation, setCurrentDirectConversation, setSelectedTier, setDirectChatKBIds,
        setMessages, setNotebookContent, setNotebookSelection, setShowNotebook, setNotebookLinkedId,
        openAtLatest, refreshAgents, loadConversations, loadDirectConversations, loadLabels, loadModelTiers, selectConversation,
    });

    return {
        messages, setMessages, isLoading, sendMessage, stopGenerating, retryMessage, editAndRegenerate,
        turnConversation, chatSignals,
        conversationStarted, handleVoiceTurnComplete,
        agentAttachedSkillIds,
        messagesEndRef, messagesContainerRef, shouldForceScrollRef, openAtLatest,
        selectConversation,
    };
};

export default useAgentHubData;
