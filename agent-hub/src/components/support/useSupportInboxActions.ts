import { useEffect, useState } from 'react';
import { supportInboxApi } from '../../api/supportInboxApi';
import { errorMessage } from '../../utils/caughtError';
import type { CannedResponse, SupportThread, ThreadPatch } from './SupportInboxPanel.types';
import { logger } from '../../utils/logger';

interface RefreshDeps {
    selectedId: string | null;
    fetchThread: (id: string | null) => Promise<void>;
    fetchThreads: () => Promise<void>;
}

/** The bulk selection of the thread list and the actions on it. */
export function useSupportBulk({ selectedId, fetchThread, fetchThreads }: RefreshDeps) {
    const [selectedIds, setSelectedIds] = useState(() => new Set<string>()); // bulk selection
    const [bulkBusy, setBulkBusy] = useState(false);

    const toggleSelected = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const runBulk = async (action: string, params: Record<string, string> = {}) => {
        const ids = Array.from(selectedIds);
        if (!ids.length) return;
        setBulkBusy(true);
        try {
            const res = await supportInboxApi.bulk(ids, action, params);
            if (res.ok) {
                setSelectedIds(new Set());
                await fetchThreads();
                if (selectedId && ids.includes(selectedId)) await fetchThread(selectedId);
            }
        } finally {
            setBulkBusy(false);
        }
    };

    return { selectedIds, setSelectedIds, bulkBusy, toggleSelected, runBulk };
}

/** Edits to the open thread: status, priority and tags, and the follow-up flag. */
export function useSupportThreadEdits({ selectedId, fetchThread, fetchThreads, thread }: RefreshDeps & { thread: SupportThread | null }) {
    const [newTag, setNewTag] = useState('');

    const patchThread = async (patch: ThreadPatch) => {
        if (!selectedId) return;
        const res = await supportInboxApi.patchThread(selectedId, patch);
        if (res.ok) {
            await fetchThread(selectedId);
            await fetchThreads();
        }
    };

    // Clearing the flag is an agent's act, never automatic — the whole point of
    // the signal is that a person decides whether the customer needs telling.
    const clearFollowup = async () => {
        if (!selectedId) return;
        try {
            const res = await supportInboxApi.followupDone(selectedId);
            if (res.ok) { await fetchThread(selectedId); await fetchThreads(); }
        } catch (e) {
            console.warn('[Support] clearFollowup:', errorMessage(e));
        }
    };

    const addTag = async () => {
        const t = newTag.trim();
        if (!t || !thread) return;
        const tags = [...(thread.tags || []), t];
        setNewTag('');
        await patchThread({ tags });
    };
    const removeTag = async (t: string) => {
        if (!thread) return;
        await patchThread({ tags: (thread.tags || []).filter(x => x !== t) });
    };

    return { newTag, setNewTag, patchThread, clearFollowup, addTag, removeTag };
}

/** The reply composer: the draft, the internal-note switch and the canned-response picker. */
export function useSupportReplyComposer({ selectedId, fetchThread, fetchThreads }: RefreshDeps) {
    const [reply, setReply] = useState('');
    const [internalNote, setInternalNote] = useState(false);
    const [sending, setSending] = useState(false);
    const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>([]);
    const [showCanned, setShowCanned] = useState(false);

    const sendReply = async () => {
        const body = reply.trim();
        if (!body || !selectedId) return;
        setSending(true);
        try {
            const res = await supportInboxApi.sendMessage(selectedId, body, internalNote);
            if (res.ok) {
                setReply('');
                setInternalNote(false);
                await fetchThread(selectedId);
                await fetchThreads();
            }
        } finally {
            setSending(false);
        }
    };

    // Load canned responses once (used by the reply composer picker).
    useEffect(() => {
        (async () => {
            try {
                const res = await supportInboxApi.canned();
                if (res.ok) { const d = await res.json(); setCannedResponses(d.responses || []); }
            } catch (err) { logger.warn('canned responses load failed', err); }
        })();
    }, []);

    const insertCanned = async (canned: CannedResponse) => {
        try {
            const res = await supportInboxApi.renderCanned(canned.id, selectedId);
            const rendered = res.ok ? (await res.json()).rendered : canned.body;
            setReply(prev => (prev ? `${prev}\n${rendered}` : rendered));
        } catch {
            setReply(prev => (prev ? `${prev}\n${canned.body}` : canned.body));
        }
        setShowCanned(false);
    };

    return { reply, setReply, internalNote, setInternalNote, sending, cannedResponses, showCanned, setShowCanned, sendReply, insertCanned };
}
