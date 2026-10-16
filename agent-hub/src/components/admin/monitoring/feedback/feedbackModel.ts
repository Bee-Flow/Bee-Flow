import type { CSSProperties } from 'react';

/** One thumbs up/down, as the feedback endpoint returns it. */
export interface FeedbackItem {
    id: string;
    rating: 'up' | 'down' | string;
    comment?: string | null;
    user_id?: string | null;
    agent_id?: string | null;
    agent_name?: string | null;
    source?: string | null;
    model?: string | null;
    model_tier?: string | null;
    conversation_id?: string | null;
    message_id?: string | null;
    organization_id?: string | null;
    /** The conversation the user chose to share, as JSON text or already parsed. */
    conversation_snapshot?: string | SnapshotMessage[] | null;
    created_at?: string;
}

export interface SnapshotMessage {
    role: string;
    content: unknown;
    timestamp?: string;
}

export interface FeedbackSummary {
    thumbs_up?: number;
    thumbs_down?: number;
    total?: number;
    with_comments?: number;
}

export type FeedbackFilter = 'all' | 'positive' | 'negative' | 'comments' | 'with_convo';

export const PAGE_SIZE = 10;

/** The shared conversation, or null when there is none (or it does not parse). */
export function parseSnapshot(raw: FeedbackItem['conversation_snapshot']): SnapshotMessage[] | null {
    if (!raw) return null;
    try {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(data) ? data : null;
    } catch { return null; }
}

/** The entries the filter chip and the search box let through. */
export function filterFeedback(feedback: FeedbackItem[], filter: FeedbackFilter, search: string): FeedbackItem[] {
    let data = feedback;
    if (filter === 'positive') data = data.filter(f => f.rating === 'up');
    if (filter === 'negative') data = data.filter(f => f.rating === 'down');
    if (filter === 'comments') data = data.filter(f => f.comment);
    if (filter === 'with_convo') data = data.filter(f => f.conversation_snapshot);
    if (search) {
        const q = search.toLowerCase();
        data = data.filter(f =>
            f.comment?.toLowerCase().includes(q) ||
            f.agent_id?.toLowerCase().includes(q) ||
            f.user_id?.toLowerCase().includes(q) ||
            f.source?.toLowerCase().includes(q) ||
            f.conversation_id?.toLowerCase().includes(q)
        );
    }
    return data;
}

/** A small rounded label next to the user's name. */
export function chipStyle(background: string, color: string, withIcon = false): CSSProperties {
    return {
        ...(withIcon ? { display: 'flex', alignItems: 'center', gap: '3px' } : {}),
        padding: '1px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 600,
        background, color,
    };
}

export const paginationBtn: CSSProperties = {
    padding: '5px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
    border: '1px solid var(--border-default, rgba(255,255,255,0.1))',
    background: 'var(--bg-secondary, #1a1a2e)', color: 'var(--text-secondary, #aaa)',
    cursor: 'pointer',
};
