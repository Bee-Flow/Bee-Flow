/**
 * The conversation list's sections: pinned first, then by how recently a chat
 * moved, then agent chats under their own heading.
 *
 * Date buckets rather than a flat list because a chronological wall of titles
 * is unreadable past about fifteen rows. Agent chats are a separate SECTION,
 * not interleaved: `/agents/conversations/all` is capped at 50 rows with no
 * cursor, so a merged, sorted list would silently drop older agent chats into
 * a gap it could never explain. An honest heading is uglier and correct.
 */

import { translate } from '@/core/i18n';
import type { ConversationSummary } from '@/features/chat';

/** The joined agent row, as far as the list needs it. */
export interface AgentChatRow {
    id: string;
    agent_id: string;
    title: string | null;
    agent_name: string | null;
    agent_avatar: string | null;
    /** Read by the row's menu (Pin to top / Unpin). */
    pinned?: boolean;
    updated_at: string;
}

export type ConversationRow = ConversationSummary | AgentChatRow;

export interface ConversationSection {
    title: string;
    data: ConversationRow[];
}

type BucketId = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'older';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The web's own headings where it has them. `sidebar.*` is the browser's chat
 * list — same subject — so an administrator who translated one client has
 * translated both.
 */
function bucketTitle(bucket: BucketId): string {
    switch (bucket) {
        case 'today':
            return translate('sidebar.today', 'Today');
        case 'yesterday':
            return translate('sidebar.yesterday', 'Yesterday');
        case 'this_week':
            return translate('mobile.chats.this_week', 'This week');
        case 'this_month':
            return translate('mobile.chats.this_month', 'This month');
        case 'older':
            return translate('sidebar.older', 'Older');
    }
}

function bucketOf(age: number): BucketId {
    if (age < DAY) return 'today';
    if (age < 2 * DAY) return 'yesterday';
    if (age < 7 * DAY) return 'this_week';
    if (age < 30 * DAY) return 'this_month';
    return 'older';
}

export function groupConversations(
    items: ConversationSummary[],
    agentChats: AgentChatRow[],
    now = Date.now(),
): ConversationSection[] {
    if (items.length === 0 && agentChats.length === 0) return [];

    // Keyed by id, not by the heading: the heading is a sentence the catalogue
    // owns, and a bucket keyed by it would be looked up in whatever language
    // happened to be loaded.
    const buckets: Record<BucketId, ConversationSummary[]> = {
        today: [],
        yesterday: [],
        this_week: [],
        this_month: [],
        older: [],
    };
    for (const conv of items.filter((c) => !c.pinned)) {
        buckets[bucketOf(now - new Date(conv.updated_at).getTime())].push(conv);
    }

    const sections: ConversationSection[] = [];
    const pinned = items.filter((c) => c.pinned);
    if (pinned.length) sections.push({ title: translate('sidebar.pinned', 'Pinned'), data: pinned });
    for (const [bucket, data] of Object.entries(buckets)) {
        if (data.length) sections.push({ title: bucketTitle(bucket as BucketId), data });
    }
    // Last, and named for what it is: honestly "recent", never "all".
    if (agentChats.length) {
        sections.push({
            title: translate('mobile.chats.recent_with_agents', 'Recent with agents'),
            data: [...agentChats].sort(
                (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
            ),
        });
    }
    return sections;
}
