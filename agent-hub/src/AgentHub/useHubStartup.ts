import { useEffect, useEffectEvent, useRef, type Dispatch, type SetStateAction } from 'react';
import { request, RefusedError } from '../api/mutate';
import { loadWorkspaceNotebook } from '../api/workspaceNotebook';
import type { ChatMessage } from '../hooks/useChatEngine/types';
import { API_BASE } from '../utils/helpers';
import { normalizeLoadedMessages, type ShapedMessage } from '../utils/messageShape';
import scopedStorage from '../utils/scopedStorage';
import { updateAgentUrl, updateDirectChatUrl } from './hubUrl';
import type { AgentLike, IdRef } from './useAgentHubData.types';

// The multi-step flows behind the hub's startup: which chat to open, and how a
// short conversation id from the address becomes a full one. They read inside
// the startup effects on purpose (and so stay on the fetch-in-effect list):
// each step decides the next from the last answer and writes several pieces of
// hub state in order.

type Conversation = { id: string };

/** The id in `convs` that `prefix` names: the full id, or the 8-character form the URL carries. */
function matchByPrefix(convs: Conversation[], prefix: string): Conversation | undefined {
    return convs.find((c): boolean => c.id === prefix || c.id.startsWith(prefix));
}

/** GET a JSON answer; null when the server refused it. */
async function getJsonOrNull<T>(url: string): Promise<T | null> {
    const res = await request(url).catch((err: unknown) => {
        if (err instanceof RefusedError) return null;
        throw err;
    });
    return res ? res.json() as Promise<T> : null;
}

/** What the stored preferences say the hub should open on, for an address that names nothing. */
export interface StoredStart {
    /** An agent id (or prefix) to select, or null. */
    agentId: string | null;
    /** Open the direct chat. */
    direct: boolean;
}

/**
 * The starting chat from the user's stored preferences. These keys are
 * user-specific, so they must not survive an account switch on a shared browser.
 */
function storedStart(): StoredStart {
    const mode = scopedStorage.getItem('defaultAgentMode') || 'last-used';
    if (mode === 'direct-chat') return { agentId: null, direct: true };
    if (mode === 'specific') return { agentId: scopedStorage.getItem('defaultAgentId') || null, direct: false };
    if (mode !== 'last-used') return { agentId: null, direct: false };
    if (scopedStorage.getItem('lastUsedMode') === 'direct-chat') return { agentId: null, direct: true };
    return { agentId: scopedStorage.getItem('lastUsedAgentId') || null, direct: false };
}

/** The setters the direct-conversation restore writes. */
interface DirectRestorePorts {
    setCurrentDirectConversation: Dispatch<SetStateAction<IdRef | null>>;
    setDirectChatKBIds: Dispatch<SetStateAction<string[]>>;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setSelectedTier: Dispatch<SetStateAction<string>>;
    setNotebookContent: Dispatch<SetStateAction<string>>;
    setShowNotebook: Dispatch<SetStateAction<boolean>>;
    setNotebookLinkedId: Dispatch<SetStateAction<string | null>>;
    openAtLatest: () => void;
}

/** Open the direct conversation /d/:prefix names: its detail, its knowledge bases, its messages, its notebook. */
async function restoreDirectConversation(prefix: string, ports: DirectRestorePorts): Promise<void> {
    try {
        const convs = await getJsonOrNull<Conversation[]>(`${API_BASE}/ai/direct/conversations`);
        const match = convs && matchByPrefix(convs, prefix);
        if (!match) return;
        const detailData = await getJsonOrNull<IdRef & { knowledgeBaseIds?: unknown; messages?: (ChatMessage & ShapedMessage)[]; model_tier?: string }>(
            `${API_BASE}/ai/direct/conversations/${match.id}`,
        );
        if (!detailData) return;
        ports.setCurrentDirectConversation(detailData);
        // The knowledge bases this chat is grounded on come from the detail GET
        // and nowhere else: the server re-checks access on every read, so its
        // list is the authorised one and a missing field means none rather than
        // "keep what the previous chat had".
        ports.setDirectChatKBIds(Array.isArray(detailData.knowledgeBaseIds) ? detailData.knowledgeBaseIds : []);
        // normalizeLoadedMessages also marks policy-removed messages as deleted.
        // A restored chat opens at its latest message (BFSF-453).
        ports.openAtLatest();
        ports.setMessages(normalizeLoadedMessages(detailData.messages || []));
        if (detailData.model_tier) ports.setSelectedTier(detailData.model_tier);
        updateDirectChatUrl(match.id);
        await loadWorkspaceNotebook(
            `${API_BASE}/ai/direct/conversations/${match.id}/workspace`,
            { setNotebookLinkedId: ports.setNotebookLinkedId, setNotebookContent: ports.setNotebookContent, setShowNotebook: ports.setShowNotebook },
            { logLabel: 'Failed to fetch direct notebook from URL:' },
        );
    } catch (e) { console.error('Failed to load direct conversation from URL:', e); }
}

/** The full id of the agent conversation /a/:agent/:prefix names, or undefined. */
async function findAgentConversation(agentId: string, prefix: string): Promise<string | undefined> {
    const convs = await getJsonOrNull<Conversation[]>(`${API_BASE}/agents/${agentId}/conversations`);
    return convs ? matchByPrefix(convs, prefix)?.id : undefined;
}

interface HubStartupArgs {
    initialAgentId: string | null;
    initialConversationId: string | null;
    initialDirectConvId: string | null;
    selectedAgent: AgentLike | null;
    setSelectedAgent: Dispatch<SetStateAction<AgentLike | null>>;
    setDirectChatMode: Dispatch<SetStateAction<boolean>>;
    setCurrentConversation: Dispatch<SetStateAction<IdRef | null>>;
    setCurrentDirectConversation: Dispatch<SetStateAction<IdRef | null>>;
    setSelectedTier: Dispatch<SetStateAction<string>>;
    setDirectChatKBIds: Dispatch<SetStateAction<string[]>>;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setNotebookContent: Dispatch<SetStateAction<string>>;
    setNotebookSelection: Dispatch<SetStateAction<string>>;
    setShowNotebook: Dispatch<SetStateAction<boolean>>;
    setNotebookLinkedId: Dispatch<SetStateAction<string | null>>;
    openAtLatest: () => void;
    refreshAgents: () => Promise<AgentLike[] | null>;
    loadConversations: (agentId: string) => Promise<void>;
    loadDirectConversations: () => Promise<void>;
    loadLabels: () => Promise<void>;
    loadModelTiers: () => Promise<void>;
    selectConversation: (agentId: string, convId: string) => Promise<void>;
}

/**
 * What the hub does when it opens, and when an agent is picked: choose the
 * starting chat from the URL or the stored defaults, and resolve a short
 * conversation id from the address (/a/:agent/:conv, /d/:conv) to the full one.
 * These are ordered, multi-step flows (list, match by prefix, open the detail,
 * then its notebook) that write several pieces of hub state in sequence, so
 * they stay as flows rather than becoming independent reads.
 */
export default function useHubStartup({
    initialAgentId, initialConversationId, initialDirectConvId,
    selectedAgent, setSelectedAgent, setDirectChatMode,
    setCurrentConversation, setCurrentDirectConversation, setSelectedTier, setDirectChatKBIds,
    setMessages, setNotebookContent, setNotebookSelection, setShowNotebook, setNotebookLinkedId,
    openAtLatest, refreshAgents, loadConversations, loadDirectConversations, loadLabels, loadModelTiers, selectConversation,
}: HubStartupArgs) {
    const pendingConversationId = useRef(initialConversationId);

    const openDirectChat = useEffectEvent(() => {
        setDirectChatMode(true);
        loadDirectConversations();
        loadLabels();
        loadModelTiers();
    });

    // Load the agents, then open the starting chat. The URL takes priority over
    // the stored preferences.
    const runStartup = useEffectEvent(async () => {
        const data = await refreshAgents();
        if (!data) return;
        loadLabels(); // Always load labels on init

        let targetId = initialAgentId;
        if (!targetId && !initialDirectConvId) {
            const start = storedStart();
            if (start.direct) openDirectChat();
            else targetId = start.agentId;
        }

        // Auto-load direct chat conversation from URL /d/:convId
        if (initialDirectConvId) {
            setDirectChatMode(true);
            loadModelTiers();
            loadLabels();
            loadDirectConversations().then(() => restoreDirectConversation(initialDirectConvId, {
                setCurrentDirectConversation, setDirectChatKBIds, setMessages, setSelectedTier,
                setNotebookContent, setShowNotebook, setNotebookLinkedId, openAtLatest,
            }));
            scopedStorage.setItem('lastUsedMode', 'direct-chat');
        }
        const targetAgent = targetId ? data.find(a => a.id === targetId || a.id.startsWith(targetId)) : undefined;
        if (targetAgent) setSelectedAgent(targetAgent);
    });
    useEffect(() => { runStartup(); }, []);

    // An agent picked (or none): load its conversations, then either open the
    // conversation the address names (once) or put the agent in the address.
    const openAgentConversationFromUrl = useEffectEvent(async (agent: AgentLike) => {
        await loadConversations(agent.id);
        const prefix = pendingConversationId.current;
        if (prefix) {
            pendingConversationId.current = null; // only once
            const convId = await findAgentConversation(agent.id, prefix);
            if (convId) selectConversation(agent.id, convId);
        } else if (!/^\/app\/documents(?:\/|$)/.test(window.location.pathname)) {
            // A stored default agent initializes behind the member library too.
            // Keep the bookmarked document address intact.
            updateAgentUrl(agent.id, null);
        }
    });
    const clearConversation = useEffectEvent(() => {
        setMessages([]);
        setCurrentConversation(null);
        setNotebookContent('');
        setNotebookSelection('');
        setShowNotebook(false);
        setNotebookLinkedId(null);
    });
    useEffect(() => {
        if (selectedAgent) openAgentConversationFromUrl(selectedAgent);
        else clearConversation();
    }, [selectedAgent]);
}
