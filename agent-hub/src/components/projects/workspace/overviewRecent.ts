// "Recent in this project": team chats, shared AI chats, documents, notebooks
// and meetings in one list, newest first. Pure: the caller decides what an
// entry looks like and where it opens.

import type { TeamChat } from '../../../api/queries/projectChats';
import type { ProjectResources, ProjectThread } from '../../../api/queries/projects';

export type RecentKind = 'team_chat' | 'ai_chat' | 'document' | 'notebook' | 'meeting';

export interface RecentEntry {
    kind: RecentKind;
    id: string;
    title: string;
    at: string | null;
    /** For an AI chat: how the app opens it. */
    threadType?: 'direct' | 'agent';
    agentId?: string | null;
}

type Row = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function timeOf(...values: unknown[]): string | null {
    for (const v of values) if (typeof v === 'string' && v) return v;
    return null;
}

function stamp(at: string | null): number {
    const n = at ? Date.parse(at) : NaN;
    return Number.isNaN(n) ? 0 : n;
}

function fromRows(rows: unknown, kind: RecentKind, titleKeys: string[]): RecentEntry[] {
    if (!Array.isArray(rows)) return [];
    return (rows as Row[])
        .filter((r) => r && typeof r.id === 'string')
        .map((r) => ({
            kind,
            id: r.id as string,
            title: text(titleKeys.map((k) => r[k]).find((v) => typeof v === 'string' && v)),
            at: timeOf(r.updatedAt, r.createdAt),
        }));
}

export function mergeRecent(sources: {
    teamChats?: Array<Pick<TeamChat, 'id' | 'title' | 'lastMessageAt' | 'updatedAt' | 'createdAt'>> | null;
    threads?: ProjectThread[] | null;
    resources?: ProjectResources | null;
}, limit = 8): RecentEntry[] {
    const team: RecentEntry[] = (sources.teamChats || []).map((c) => ({
        kind: 'team_chat',
        id: c.id,
        title: text(c.title),
        at: timeOf(c.lastMessageAt, c.updatedAt, c.createdAt),
    }));
    const ai: RecentEntry[] = (sources.threads || []).map((th) => ({
        kind: 'ai_chat',
        id: th.id,
        title: text(th.title),
        at: timeOf(th.updatedAt, th.createdAt),
        threadType: th.type,
        agentId: th.agentId ?? null,
    }));
    const res = sources.resources || {};
    const all = [
        ...team,
        ...ai,
        ...fromRows(res.documents, 'document', ['name', 'title']),
        ...fromRows(res.notebooks, 'notebook', ['name', 'title']),
        ...fromRows(res.meetings, 'meeting', ['title', 'name']),
    ];
    return all.sort((a, b) => stamp(b.at) - stamp(a.at)).slice(0, limit);
}
