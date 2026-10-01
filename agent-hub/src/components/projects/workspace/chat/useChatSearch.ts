// Search inside one chat. Messages are encrypted end-to-end with the project
// key, so the server can never search them: this filters the messages the
// reader has already loaded, in memory, and walks the matches up and down.

import { useMemo, useState } from 'react';
import type { TeamChatMessage } from '../../../../api/queries/projectChats';

export interface ChatSearch {
    query: string;
    /** A new query restarts at the first (oldest) match. */
    setQuery: (next: string) => void;
    /** Main-conversation messages whose text holds the query, oldest first. */
    matches: TeamChatMessage[];
    /** Index into `matches`; always in range while there are matches. */
    active: number;
    activeId: string | null;
    next: () => void;
    prev: () => void;
}

export default function useChatSearch(messages: TeamChatMessage[]): ChatSearch {
    const [query, setQueryState] = useState('');
    const [active, setActive] = useState(0);
    const matches = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        // Thread replies are not on the main list; deleted or undecryptable
        // messages have no text to match.
        return messages.filter(m => !m.threadId && !m.deleted && !m.unreadable && m.content.toLowerCase().includes(q));
    }, [messages, query]);
    const clamped = matches.length ? Math.min(active, matches.length - 1) : 0;
    return {
        query,
        setQuery: (next) => { setQueryState(next); setActive(0); },
        matches,
        active: clamped,
        activeId: matches[clamped]?.id ?? null,
        next: () => { if (matches.length) setActive((clamped + 1) % matches.length); },
        prev: () => { if (matches.length) setActive((clamped + matches.length - 1) % matches.length); },
    };
}
