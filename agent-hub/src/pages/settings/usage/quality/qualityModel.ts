import { isLargeInput } from '@/utils/terminationsModel';
import type { TerminationRow, TerminationsByType } from '@/pages/settings/OrgTerminationsPanel.types';
import type { FeedbackItem } from './qualityData';

export interface FeedbackSummaryCounts {
    total: number;
    thumbs_up: number;
    thumbs_down: number;
    with_comments: number;
}

export interface SnapshotMessage {
    role?: string;
    content?: unknown;
    duration_ms?: number;
    model?: string;
}

/** The share of ratings that are positive, as a whole percent; null with no ratings. */
export function approvalPct(summary: FeedbackSummaryCounts): number | null {
    const up = Number(summary.thumbs_up) || 0;
    const down = Number(summary.thumbs_down) || 0;
    return up + down > 0 ? Math.round((up / (up + down)) * 100) : null;
}

/** The messages of a shared conversation, or null when none was shared or it is unreadable. */
export function parseSnapshot(raw: string | undefined): SnapshotMessage[] | null {
    if (!raw) return null;
    try {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(data) && data.length > 0 ? data : null;
    } catch { return null; }
}

export type FeedbackFilter = 'all' | 'positive' | 'negative' | 'comments' | 'with_convo';

export function filterFeedback(items: FeedbackItem[], filter: FeedbackFilter, search: string): FeedbackItem[] {
    let data = items;
    if (filter === 'positive') data = data.filter(f => f.rating === 'up');
    if (filter === 'negative') data = data.filter(f => f.rating === 'down');
    if (filter === 'comments') data = data.filter(f => f.comment);
    if (filter === 'with_convo') data = data.filter(f => parseSnapshot(f.conversation_snapshot));
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter(f => [f.comment, f.agent_id, f.agent_name, f.user_id, f.source, f.conversation_id]
        .some(v => v?.toLowerCase().includes(q)));
}

export function feedbackCounts(items: FeedbackItem[]): Record<FeedbackFilter, number> {
    return {
        all: items.length,
        positive: items.filter(f => f.rating === 'up').length,
        negative: items.filter(f => f.rating === 'down').length,
        comments: items.filter(f => f.comment).length,
        with_convo: items.filter(f => parseSnapshot(f.conversation_snapshot)).length,
    };
}

/** Terminations that look caused by a big prompt or attachment. */
export const largeInputCount = (rows: TerminationRow[], showTokens: boolean) => rows.filter(r => isLargeInput(r, showTokens)).length;

/** Buckets of the summary in display order, missing ones as 0. */
export function typeCounts(by: TerminationsByType | undefined) {
    return {
        max_tokens: by?.max_tokens || 0,
        max_iterations: by?.max_iterations || 0,
        error: by?.error || 0,
        aborted: by?.aborted || 0,
    };
}
