import type { Dispatch, SetStateAction } from 'react';
import { projectErrorText } from '../components/projects/workspace/projectErrorText';
import { toast } from '../components/shared/Toast';
import { API_BASE, authFetch } from '../utils/helpers';
import { mutate, ApiError, errorBody, RefusedError } from '../api/mutate';
import type { TranslateFn } from '../hooks/useTranslation';
import { errorMessage } from '../utils/caughtError';

/** One row of a conversation list, as the hub's lists carry it. */
export interface ConversationRow {
    id: string;
    title?: string | null;
    project_id?: string | null;
    agent_id?: string | null;
    agent_name?: string;
    shared_scope?: string | null;
    pinned?: boolean | number;
    labels_json?: string | null;
    updated_at?: string | null;
    created_at?: string | null;
    /** 'direct' for a direct chat in the all-chats timeline. */
    _source?: string;
    [key: string]: unknown;
}

/** A conversation label (name + colour). */
export interface ConversationLabel {
    id: string;
    name: string;
    color: string;
    [key: string]: unknown;
}

interface ConfirmOptions {
    title: string;
    description?: string;
    confirmLabel?: string;
    destructive?: boolean;
}

interface UseConversationMetaArgs {
    t: TranslateFn;
    directChatMode: boolean;
    selectedAgent: { id: string } | null;
    loadDirectConversations: () => void;
    loadConversations: (agentId: string) => void;
    setDirectConversations: Dispatch<SetStateAction<ConversationRow[]>>;
    setConversations: Dispatch<SetStateAction<ConversationRow[]>>;
    setConversationLabels: Dispatch<SetStateAction<ConversationLabel[]>>;
    confirm: (options: ConfirmOptions) => Promise<boolean>;
}

// Conversation bookkeeping shared by the sidebar rows: project filing/sharing,
// rename, pin and labels. Plain closures (no hooks) moved verbatim from
// AgentHub.jsx; they are recreated per render exactly as before.
const useConversationMeta = ({
    t, directChatMode, selectedAgent,
    loadDirectConversations, loadConversations,
    setDirectConversations, setConversations, setConversationLabels,
    confirm,
}: UseConversationMetaArgs) => {
    /**
     * Share a conversation into the project it is filed under — or stop.
     *
     * Distinct from handleMoveToProject: filing is private bookkeeping, this
     * publishes the conversation to every project member. It also RE-ENCRYPTS
     * the messages to a project-held key, which is why the confirm spells the
     * consequence out rather than asking "are you sure?", and why the server
     * accepts it only from the conversation's owner (on the zero-knowledge tier
     * only they hold the key that opens the current ciphertext).
     */
    const handleShareToProject = async (conv: ConversationRow) => {
        const projectId = conv.project_id;
        if (!projectId) return;
        const type = conv.agent_id ? 'agent' : 'direct';
        const currentlyShared = conv.shared_scope === 'project';

        if (!currentlyShared) {
            const ok = await confirm({
                title: `${t('projects.share_thread')}?`,
                description: t('projects.share_encryption_warning'),
                confirmLabel: t('projects.share_thread'),
                destructive: true,
            });
            if (!ok) return;
        }

        try {
            const url = `${API_BASE}/api/projects/${projectId}/threads`;
            const res = currentlyShared
                ? await authFetch(`${url}/${conv.id}?type=${type}`, { method: 'DELETE' })
                : await authFetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ conversationId: conv.id, type }),
                });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                // 403 = not the owner, 503 = the project key is unavailable.
                // Both are worth stating plainly; neither is a generic failure.
                toast.error(err.error || t('projects.share_owner_only'));
                return;
            }
            // Refresh so the row picks up its new shared_scope.
            if (directChatMode) loadDirectConversations();
            else if (selectedAgent) loadConversations(selectedAgent.id);
        } catch (e) {
            toast.error(t('projects.share_owner_only'));
        }
    };

    /**
     * File a conversation under a project (or take it out). Private
     * bookkeeping: nothing is shared by this.
     *
     * The conversation's own shape says what it is — the same rule sharing
     * uses — rather than the mode the hub happens to be in: in the all-chats
     * view an agent conversation is listed while the hub is in direct mode.
     * A refusal (a Solution holds no chats, a project that is gone) is said
     * out loud instead of leaving the row where it was without a word.
     */
    const handleMoveToProject = async (conv: ConversationRow, targetProject: { id: string } | null) => {
        const type = conv.agent_id ? 'agent' : 'direct';
        const projectId = targetProject ? targetProject.id : conv.project_id;
        if (!projectId) return;
        const change = targetProject ? { assign: [{ id: conv.id, type }] } : { unassign: [{ id: conv.id, type }] };
        const failed = t('sidebar.project_move_failed', 'Could not move this chat. It is still where it was.');
        try {
            try {
                await mutate(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/conversations`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(change),
            });
            } catch (apiErr) {
                if (!(apiErr instanceof RefusedError)) throw apiErr;
                const err = errorBody(apiErr) ?? {};
                toast.error(projectErrorText(t, err, failed));
                return;
            }
            // Refresh conversation lists to reflect project_id changes
            if (directChatMode) loadDirectConversations();
            else if (selectedAgent) loadConversations(selectedAgent.id);
        } catch {
            toast.error(failed);
        }
    };

    const handleRenameConversation = async (conv: ConversationRow, newTitle: string) => {
        try {
            if (directChatMode) {
                await mutate(`${API_BASE}/ai/direct/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: newTitle }),
                });
                setDirectConversations(prev => prev.map(c => c.id === conv.id ? { ...c, title: newTitle } : c));
            } else {
                const agentId = conv.agent_id || selectedAgent?.id;
                await mutate(`${API_BASE}/agents/${agentId}/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: newTitle }),
                });
                setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, title: newTitle } : c));
            }
        } catch (e) {
            console.error('Failed to rename conversation:', e);
            toast.error(errorMessage(e));
        }
    };

    const handlePinConversation = async (conv: ConversationRow) => {
        const newPinned = !conv.pinned;
        try {
            if (directChatMode) {
                await mutate(`${API_BASE}/ai/direct/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pinned: newPinned }),
                });
                setDirectConversations(prev => prev.map(c => c.id === conv.id ? { ...c, pinned: newPinned } : c));
            } else {
                const agentId = conv.agent_id || selectedAgent?.id;
                await mutate(`${API_BASE}/agents/${agentId}/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pinned: newPinned }),
                });
                setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, pinned: newPinned } : c));
            }
        } catch (e) {
            console.error('Failed to pin/unpin conversation:', e);
            toast.error(errorMessage(e));
        }
    };

    const handleLabelConversation = async (conv: ConversationRow, label: string) => {
        // Toggle label: if already has it, remove; otherwise add
        const currentLabels = (() => { try { return JSON.parse(conv.labels_json || '[]'); } catch { return []; } })();
        const newLabels = currentLabels.includes(label)
            ? currentLabels.filter((l: string) => l !== label)
            : [...currentLabels, label];
        try {
            if (directChatMode) {
                await mutate(`${API_BASE}/ai/direct/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ labels: newLabels }),
                });
                setDirectConversations(prev => prev.map(c => c.id === conv.id ? { ...c, labels_json: JSON.stringify(newLabels) } : c));
            } else {
                const agentId = conv.agent_id || selectedAgent?.id;
                await mutate(`${API_BASE}/agents/${agentId}/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ labels: newLabels }),
                });
                setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, labels_json: JSON.stringify(newLabels) } : c));
            }
        } catch (e) {
            console.error('Failed to update conversation labels:', e);
            toast.error(errorMessage(e));
        }
    };

    const handleCreateLabel = async (name: string, color: string) => {
        try {
            const res = await mutate(`${API_BASE}/ai/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color }),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                const label = await res.json();
                setConversationLabels(prev => [...prev, label]);
                return label;
            }
        } catch (e) {
            console.error('Failed to create label:', e);
        }
    };

    const handleDeleteLabel = async (labelId: string) => {
        try {
            await mutate(`${API_BASE}/ai/labels/${labelId}`, { method: 'DELETE' });
            setConversationLabels(prev => prev.filter(l => l.id !== labelId));
        } catch (e) {
            console.error('Failed to delete label:', e);
            toast.error(errorMessage(e));
        }
    };

    const handleEditLabel = async (labelId: string, updates: Partial<ConversationLabel>) => {
        try {
            const res = await mutate(`${API_BASE}/ai/labels/${labelId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                setConversationLabels(prev => prev.map(l => l.id === labelId ? { ...l, ...updates } : l));
            }
        } catch (e) {
            console.error('Failed to edit label:', e);
        }
    };

    return {
        handleShareToProject, handleMoveToProject,
        handleRenameConversation, handlePinConversation, handleLabelConversation,
        handleCreateLabel, handleDeleteLabel, handleEditLabel,
    };
};

export default useConversationMeta;
