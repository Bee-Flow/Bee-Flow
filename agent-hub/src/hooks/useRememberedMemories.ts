import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { RecentMemory } from '../api/memoryApi';
import { rememberedMemoriesKey, useRememberedMemoriesPoll } from '../api/queries/rememberedMemories';

/**
 * After a turn ends, ask the server what it saved: at 2 s, 6 s and 15 s after the
 * stream finished (extraction runs after the answer), stopping at the first
 * non-empty answer. Leaving the conversation (unmount, or another conversation)
 * cancels whatever is pending. Pass `enabled: false` when the turn could not have
 * saved anything (writing off, memory paused or off for the organisation).
 */
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
    const queryClient = useQueryClient();
    // What was found, kept for the life of the chip: once a turn has its answer nothing is asked again.
    const [items, setItems] = useState<RecentMemory[] | null>(null);
    const polling = enabled && !!conversationId && !!since && !until && items === null;

    // Leaving the turn (unmount, another conversation, the next turn) drops its lookups,
    // an ask in flight included, so coming back starts the waits again.
    useEffect(() => {
        if (!polling || !conversationId || !since) return undefined;
        return () => queryClient.removeQueries({ queryKey: rememberedMemoriesKey(conversationId, since) });
    }, [polling, conversationId, since, queryClient]);

    const read = useRememberedMemoriesPoll(conversationId ?? '', since ?? '', polling);
    const fresh = polling ? read.found : EMPTY;
    if (items === null && fresh.length > 0) setItems(fresh);
    const held = items ?? fresh;

    const visible = useMemo(() => createdBefore(held, until), [held, until]);

    return { items: visible, done: items !== null || read.done };
}

const EMPTY: RecentMemory[] = [];

/** The items created before the next turn started (all of them while there is no next turn). */
function createdBefore(items: RecentMemory[], until: string | null | undefined): RecentMemory[] {
    const limit = until ? Date.parse(until) : NaN;
    if (!Number.isFinite(limit)) return items;
    return items.filter(i => {
        const created = i.created_at ? Date.parse(i.created_at) : NaN;
        return !Number.isFinite(created) || created <= limit;
    });
}
