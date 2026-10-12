import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchRecentMemories, type RecentMemory } from '../components/chat/memory/memoryApi';

/**
 * After a turn ends, ask the server what it saved: at 2 s, 6 s and 15 s after the
 * stream finished (extraction runs after the answer), stopping at the first
 * non-empty answer. Leaving the conversation (unmount, or another conversation)
 * cancels whatever is pending. Pass `enabled: false` when the turn could not have
 * saved anything (writing off, memory paused or off for the organisation).
 */
export const REMEMBERED_POLL_DELAYS_MS: readonly number[] = [2000, 4000, 9000];

export interface UseRememberedMemoriesOptions {
    conversationId: string | null | undefined;
    /** ISO time the turn started. */
    since: string | null | undefined;
    /**
     * ISO time the next turn in this conversation started. Once set, polling stops
     * and memories created after it are ignored: they belong to the next turn.
     */
    until?: string | null;
    enabled: boolean;
}

export default function useRememberedMemories({ conversationId, since, until, enabled }: UseRememberedMemoriesOptions) {
    const [items, setItems] = useState<RecentMemory[]>([]);
    const [done, setDone] = useState(false);
    // The latest items, so the effect never has to depend on them.
    const foundRef = useRef(false);

    useEffect(() => {
        if (!enabled || !conversationId || !since || until || foundRef.current) return undefined;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();

        const attempt = (index: number) => {
            timer = setTimeout(async () => {
                let found: RecentMemory[] = [];
                try {
                    found = await fetchRecentMemories(conversationId, since, controller.signal);
                } catch {
                    // A failed lookup is the same as nothing yet: try the next time.
                }
                if (cancelled) return;
                if (found.length > 0) {
                    foundRef.current = true;
                    setItems(found);
                    setDone(true);
                } else if (index + 1 < REMEMBERED_POLL_DELAYS_MS.length) {
                    attempt(index + 1);
                } else {
                    setDone(true);
                }
            }, REMEMBERED_POLL_DELAYS_MS[index]);
        };
        attempt(0);

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            controller.abort();
        };
    }, [conversationId, since, until, enabled]);

    const visible = useMemo(() => {
        const limit = until ? Date.parse(until) : NaN;
        if (!Number.isFinite(limit)) return items;
        return items.filter(i => {
            const created = i.created_at ? Date.parse(i.created_at) : NaN;
            return !Number.isFinite(created) || created <= limit;
        });
    }, [items, until]);

    return { items: visible, done, setItems };
}
