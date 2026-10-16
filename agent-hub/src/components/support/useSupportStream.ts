import { useEffect, useRef } from 'react';
import { API_BASE } from '../../api/mutate';
import { errorMessage } from '../../utils/caughtError';

interface StreamDeps {
    selectedId: string | null;
    setSelectedId: (id: string | null) => void;
    fetchThreads: () => Promise<void>;
    fetchThread: (id: string | null) => Promise<void>;
    fetchMailbox: () => Promise<void>;
}

/** SSE — listen for thread_created / thread_updated / threads_purged and refresh. */
export function useSupportStream({ selectedId, setSelectedId, fetchThreads, fetchThread, fetchMailbox }: StreamDeps) {
    const esRef = useRef<EventSource | null>(null);
    useEffect(() => {
        try {
            const es = new EventSource(`${API_BASE}/api/support/stream`, { withCredentials: true });
            esRef.current = es;
            const refresh = () => fetchThreads();
            const refreshOpen = (e: MessageEvent) => {
                try {
                    const payload = JSON.parse(e.data || '{}');
                    if (selectedId && payload.threadId === selectedId) fetchThread(selectedId);
                } catch {}
                refresh();
            };
            // Another super-admin disconnected the mailbox: the open thread may
            // no longer exist, so drop the selection before refetching.
            const purged = () => { setSelectedId(null); fetchMailbox(); refresh(); };
            es.addEventListener('thread_created', refresh);
            es.addEventListener('thread_updated', refreshOpen);
            es.addEventListener('threads_purged', purged);
            es.onerror = () => { /* let EventSource auto-retry */ };
            return () => {
                try { es.close(); } catch {}
            };
        } catch (e) {
            console.warn('[Support] SSE failed:', errorMessage(e));
        }
    }, [fetchThreads, fetchThread, fetchMailbox, selectedId]);
}
