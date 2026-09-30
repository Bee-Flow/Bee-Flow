/**
 * The per-section lists "Recently edited" reads — a port of
 * STUDIO_RECENT_SOURCES (agent-hub/src/utils/studioRecentSources.js): the
 * same URL, envelope, name/time fields and status reading per section, so the
 * phone's list and the web's cannot disagree about what a row is called or
 * what state it is in. The web file explains each choice; the short version:
 *
 *   - an agent is live on `published_version`, not `is_published` (the
 *     SHARING flag);
 *   - skills, knowledge bases, tables and Solutions carry NO status a list
 *     row could honestly show ('unsupported');
 *   - a flag this client cannot read is 'unknown', never a guess.
 */

import { field, pick } from '@/core/api/contract';

import type { RecentFetch, RecentItem, RecentSourceId, RecentStatus } from '../model/recent';

type Row = Record<string, unknown>;

export interface RecentSource {
    url: string;
    query?: Readonly<Record<string, number>>;
    /** The array inside the body; anything that is not one is an unreadable answer. */
    pick: (body: unknown) => unknown;
    name: (row: Row) => unknown;
    updatedAt: (row: Row) => unknown;
    /** Absent → the section has no status to give ('unsupported'). */
    status?: (row: Row) => RecentStatus;
}

const bare = (body: unknown) => body;
const inside = (key: string) => (body: unknown) => pick(body, key);

/** `isPublished` / `is_published` as a strict boolean; Postgres 't'/'f' pass through. */
function publishedFlag(row: Row): boolean | null {
    const v = row.isPublished ?? row.is_published;
    if (v === true || v === 't') return true;
    if (v === false || v === 'f') return false;
    return null;
}

function publishState(row: Row): RecentStatus {
    const flag = publishedFlag(row);
    if (flag === null) return 'unknown';
    return flag ? 'published' : 'draft';
}

function agentLiveState(row: Row): RecentStatus {
    const raw = row.publishedVersion ?? row.published_version;
    if (raw === null || raw === undefined || raw === '') return 'unknown';
    const n = Number(raw);
    if (!Number.isFinite(n)) return 'unknown';
    return n > 0 ? 'published' : 'draft';
}

function automationState(row: Row): RecentStatus {
    if (row.isDraft === true) return 'draft';
    if (row.lastStatus === 'error') return 'failed';
    if (row.isActive === true) return 'active';
    if (row.isActive === false) return 'paused';
    return 'unknown';
}

function appState(row: Row): RecentStatus {
    const flag = publishedFlag(row);
    if (flag === null) return 'unknown';
    if (!flag) return 'draft';
    // `Number(null)` is 0: test for absence first, or every legacy app would
    // report its whole draft history as unpublished changes.
    const live = row.publishedVersion == null ? NaN : Number(row.publishedVersion);
    const draft = row.definitionVersion == null ? NaN : Number(row.definitionVersion);
    if (!Number.isFinite(live) || !Number.isFinite(draft)) return 'published';
    return draft > live ? 'unpublished_changes' : 'published';
}

function meetingState(row: Row): RecentStatus {
    const s = typeof row.status === 'string' ? row.status.trim() : '';
    if (!s) return 'unknown';
    if (s === 'failed') return 'failed';
    if (s === 'completed') return 'ready';
    return 'processing';
}

function playbookState(row: Row): RecentStatus {
    const phases = Array.isArray(row.phases) ? (row.phases as Row[]) : [];
    const any = (status: string) => phases.some((p) => p && p.status === status);
    if (row.status === 'done') return 'ready';
    if (row.status === 'stopped') return 'paused';
    if (any('failed')) return 'failed';
    if (any('running')) return 'processing';
    if (any('awaiting')) return 'paused';
    return row.status === 'active' ? 'processing' : 'unknown';
}

const name = (row: Row) => row.name;
const title = (row: Row) => row.title;
const camelTime = (row: Row) => row.updatedAt;
const snakeTime = (row: Row) => row.updated_at;

export const RECENT_SOURCES: Record<RecentSourceId, RecentSource> = {
    agents: { url: '/agents/all', pick: bare, name, updatedAt: snakeTime, status: agentLiveState },
    skills: { url: '/api/skills', pick: bare, name, updatedAt: camelTime },
    knowledge: { url: '/api/kb', pick: bare, name, updatedAt: snakeTime },
    aiTasks: { url: '/api/automation', pick: inside('automations'), name: title, updatedAt: camelTime, status: automationState },
    webpages: { url: '/api/webpages', pick: inside('webpages'), name, updatedAt: camelTime, status: publishState },
    apps: { url: '/api/studio-apps/mine', pick: inside('apps'), name, updatedAt: camelTime, status: appState },
    datatables: { url: '/api/datatables', pick: inside('datatables'), name, updatedAt: camelTime },
    meetingNotes: {
        // Capped like the web's (FETCH_LIMIT): the list route itself is capped.
        url: '/api/transcriptions',
        query: { limit: 25 },
        pick: inside('transcriptions'),
        name: (row) => row.title || row.fileName,
        updatedAt: camelTime,
        status: meetingState,
    },
    playbooks: { url: '/api/playbooks', pick: inside('playbooks'), name: title, updatedAt: camelTime, status: playbookState },
    solutions: {
        url: '/api/projects',
        pick: (body) => (Array.isArray(body) ? body : pick(body, 'projects')),
        name,
        updatedAt: (row) => row.updatedAt || row.updated_at,
    },
};

/** An id the server sent as a number or a string; anything else drops the row. */
function idOf(row: Row): string {
    const id = row.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
}

/** One section's rows → what the list draws. A body with no array is not an empty section. */
export function readRecentRows(id: RecentSourceId, rows: unknown): Extract<RecentFetch, { refused: false }> {
    if (!Array.isArray(rows)) return { refused: false, items: [], whole: false };
    const source = RECENT_SOURCES[id];
    const items: RecentItem[] = [];
    for (const raw of rows) {
        if (raw === null || typeof raw !== 'object') continue;
        const row = raw as Row;
        const rowId = idOf(row);
        if (!rowId) continue;
        items.push({
            id: rowId,
            name: field.strOrNull(source.name(row)) || null,
            updatedAt: field.strOrNull(source.updatedAt(row)),
            status: source.status ? safeStatus(source.status, row) : 'unsupported',
        });
    }
    return { refused: false, items, whole: true };
}

/** An accessor that throws answers 'unknown': a screen may not print whatever a mapper returned. */
function safeStatus(read: (row: Row) => RecentStatus, row: Row): RecentStatus {
    try {
        return read(row);
    } catch {
        return 'unknown';
    }
}
