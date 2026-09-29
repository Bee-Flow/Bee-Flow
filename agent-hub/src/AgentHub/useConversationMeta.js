import { toast } from '../components/shared/Toast';
import { API_BASE, authFetch } from '../utils/helpers';

// Conversation bookkeeping shared by the sidebar rows: project filing/sharing,
// rename, pin and labels. Plain closures (no hooks) moved verbatim from
// AgentHub.jsx; they are recreated per render exactly as before.
const useConversationMeta = ({
    t, directChatMode, selectedAgent,
    loadDirectConversations, loadConversations,
    setDirectConversations, setConversations, setConversationLabels,
    confirm,
}) => {
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
    const handleShareToProject = async (conv) => {
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

    const handleMoveToProject = async (conv, targetProject) => {
        try {
            const type = directChatMode ? 'direct' : 'agent';
            if (targetProject) {
                // Assign to project
                await authFetch(`${API_BASE}/api/projects/${targetProject.id}/conversations`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ assign: [{ id: conv.id, type }] }),
                });
            } else {
                // Find current project and unassign
                const currentProjId = conv.project_id;
                if (currentProjId) {
                    await authFetch(`${API_BASE}/api/projects/${currentProjId}/conversations`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ unassign: [{ id: conv.id, type }] }),
                    });
                }
            }
            // Refresh conversation lists to reflect project_id changes
            if (directChatMode) loadDirectConversations();
            else if (selectedAgent) loadConversations(selectedAgent.id);
        } catch (e) {
            console.error('Failed to move conversation to project:', e);
        }
    };

    const handleRenameConversation = async (conv, newTitle) => {
        try {
            if (directChatMode) {
                await authFetch(`${API_BASE}/ai/direct/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: newTitle }),
                });
                setDirectConversations(prev => prev.map(c => c.id === conv.id ? { ...c, title: newTitle } : c));
            } else {
                const agentId = conv.agent_id || selectedAgent?.id;
                await authFetch(`${API_BASE}/agents/${agentId}/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: newTitle }),
                });
                setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, title: newTitle } : c));
            }
        } catch (e) {
            console.error('Failed to rename conversation:', e);
        }
    };

    const handlePinConversation = async (conv) => {
        const newPinned = !conv.pinned;
        try {
            if (directChatMode) {
                await authFetch(`${API_BASE}/ai/direct/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pinned: newPinned }),
                });
                setDirectConversations(prev => prev.map(c => c.id === conv.id ? { ...c, pinned: newPinned } : c));
            } else {
                const agentId = conv.agent_id || selectedAgent?.id;
                await authFetch(`${API_BASE}/agents/${agentId}/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pinned: newPinned }),
                });
                setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, pinned: newPinned } : c));
            }
        } catch (e) {
            console.error('Failed to pin/unpin conversation:', e);
        }
    };

    const handleLabelConversation = async (conv, label) => {
        // Toggle label: if already has it, remove; otherwise add
        const currentLabels = (() => { try { return JSON.parse(conv.labels_json || '[]'); } catch { return []; } })();
        const newLabels = currentLabels.includes(label)
            ? currentLabels.filter(l => l !== label)
            : [...currentLabels, label];
        try {
            if (directChatMode) {
                await authFetch(`${API_BASE}/ai/direct/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ labels: newLabels }),
                });
                setDirectConversations(prev => prev.map(c => c.id === conv.id ? { ...c, labels_json: JSON.stringify(newLabels) } : c));
            } else {
                const agentId = conv.agent_id || selectedAgent?.id;
                await authFetch(`${API_BASE}/agents/${agentId}/conversations/${conv.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ labels: newLabels }),
                });
                setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, labels_json: JSON.stringify(newLabels) } : c));
            }
        } catch (e) {
            console.error('Failed to update conversation labels:', e);
        }
    };

    const handleCreateLabel = async (name, color) => {
        try {
            const res = await authFetch(`${API_BASE}/ai/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color }),
            });
            if (res.ok) {
                const label = await res.json();
                setConversationLabels(prev => [...prev, label]);
                return label;
            }
        } catch (e) {
            console.error('Failed to create label:', e);
        }
    };

    const handleDeleteLabel = async (labelId) => {
        try {
            await authFetch(`${API_BASE}/ai/labels/${labelId}`, { method: 'DELETE' });
            setConversationLabels(prev => prev.filter(l => l.id !== labelId));
        } catch (e) {
            console.error('Failed to delete label:', e);
        }
    };

    const handleEditLabel = async (labelId, updates) => {
        try {
            const res = await authFetch(`${API_BASE}/ai/labels/${labelId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });
            if (res.ok) {
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
