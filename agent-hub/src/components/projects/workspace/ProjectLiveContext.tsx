// One live connection per open project, shared by every panel on the page.
//
// The project workspace shows several lists that other people change while you
// look at them (members, chats, content, activity). Each used to open its own
// feed; this provider opens ONE (useProjectStream), turns durable events into
// React Query invalidations, and hands transient ones (typing, presence) to
// whoever subscribed. A panel that needs the raw events (the open team chat,
// to pull new messages) subscribes instead of opening a second stream.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import useProjectStream from '../../../hooks/useProjectStream';
import { apiClient } from '../../../api/client';
import { projectKeys } from '../../../api/queries/projects';

export type ProjectLiveHandler = (kind: string, event: ProjectLiveEvent) => void;

export interface ProjectLiveEvent {
    kind?: string;
    actorId?: string;
    targetType?: string | null;
    targetId?: string | null;
    conversationId?: string;
    payload?: Record<string, any>;
    [key: string]: unknown;
}

export interface ProjectLiveValue {
    /** User ids seen on the project in the last PRESENCE_TTL_MS, caller excluded. */
    online: string[];
    /** Who is typing, keyed by conversation or team-chat id. */
    typing: Record<string, string[]>;
    /** Raw feed access. Returns the unsubscribe function. */
    subscribe: (handler: ProjectLiveHandler) => () => void;
    /** Tell the others you are typing in `conversationId` (throttled). */
    notifyTyping: (conversationId: string) => void;
}

const PRESENCE_TTL_MS = 75_000;
const PRESENCE_BEAT_MS = 30_000;
const TYPING_TTL_MS = 6_000;
const TYPING_THROTTLE_MS = 3_000;

const NOOP_VALUE: ProjectLiveValue = {
    online: [],
    typing: {},
    subscribe: () => () => {},
    notifyTyping: () => {},
};

const ProjectLiveCtx = createContext<ProjectLiveValue>(NOOP_VALUE);

const CHAT_LIST_KINDS = new Set([
    'thread_shared', 'thread_unshared', 'conversation_assigned', 'conversation_unassigned',
    'run.finished', 'message.created',
]);
const DETAIL_KINDS = new Set(['project_updated', 'instructions_updated']);
const DOC_DURABLE_KINDS = new Set(['doc.edited', 'doc.restored']);

/** Keystroke-rate co-editing frames: never an invalidation, never activity. */
function isDocFrame(kind: string): boolean {
    return kind.startsWith('doc.') && !DOC_DURABLE_KINDS.has(kind);
}

/** Which cached lists an event kind makes stale. First matching rule wins. */
const INVALIDATION_RULES: Array<[(kind: string) => boolean, (id: string) => ReadonlyArray<readonly unknown[]>]> = [
    // The reader was removed while the page was open: re-read the project (it
    // now answers 404, and the page says it is no longer available) and every
    // project list, so the sidebar drops it too.
    [k => k === 'forbidden', id => [projectKeys.detail(id), [...projectKeys.all, 'list']]],
    // The server could not replay the gap (the backlog was too long): every
    // list of this project may be stale, so re-read all of them once.
    [k => k === 'resync', id => [projectKeys.project(id)]],
    // A co-editing session was checkpointed, a version was restored, or an
    // item was created, edited, renamed or moved (the change feed): the
    // content lists show names and who changed what and when.
    [k => DOC_DURABLE_KINDS.has(k) || k.startsWith('content.'), id => [projectKeys.resources(id)]],
    // Classifying a legacy project changes which sections it holds and which
    // list (projects, or Studio Solutions) it appears in.
    [k => k === 'kind_set', id => [projectKeys.detail(id), projectKeys.resources(id), [...projectKeys.all, 'list']]],
    [k => k.startsWith('member_'), id => [projectKeys.members(id), projectKeys.detail(id)]],
    [k => CHAT_LIST_KINDS.has(k), id => [projectKeys.threads(id), projectKeys.myChats(id)]],
    [k => k.startsWith('resource_') || k.startsWith('kb_') || k.startsWith('approval.'), id => [projectKeys.resources(id), projectKeys.detail(id)]],
    [k => k.startsWith('file.'), id => [projectKeys.files(id), projectKeys.resources(id)]],
    [k => k.startsWith('chat.') && !k.startsWith('chat.ai.'), id => [projectKeys.chats(id)]],
    [k => k.startsWith('task.'), id => [projectKeys.tasks(id)]],
    [k => DETAIL_KINDS.has(k), id => [projectKeys.detail(id)]],
];

export function keysForEvent(projectId: string, kind: string): ReadonlyArray<readonly unknown[]> {
    const rule = INVALIDATION_RULES.find(([matches]) => matches(kind));
    return rule ? rule[1](projectId) : [];
}

/**
 * Conversation traffic: team-chat messages, edits and mentions, comment
 * replies, AI turns in shared chats. It is the most frequent kind of event and
 * none of it writes a project_activity row, which is all the Activity tab
 * reads; re-reading it would refetch every page that tab has loaded, for
 * nothing. The few traffic kinds that do log a row are listed. Every other
 * durable event may have logged one, so it still refreshes the tab.
 */
const TRAFFIC_PREFIXES = ['chat.', 'comment.', 'message.', 'run.', 'presence.'];
const LOGGED_TRAFFIC = new Set(['chat.created', 'chat.deleted', 'comment.thread.created']);

/** May this event have added a row to the project's activity? */
export function affectsActivity(kind: string, event: ProjectLiveEvent): boolean {
    if (event.transient || isDocFrame(kind) || kind === 'resync') return false;
    if (TRAFFIC_PREFIXES.some(p => kind.startsWith(p))) return LOGGED_TRAFFIC.has(kind);
    return true;
}

/** The conversation or team chat a typing/message event is about, if any. */
function conversationOf(event: ProjectLiveEvent): string {
    return String(event.conversationId || event.payload?.chatId || event.targetId || '');
}

function stripExpired(map: Map<string, number>, now: number, ttl: number): boolean {
    let changed = false;
    for (const [key, at] of map) {
        if (now - at > ttl) { map.delete(key); changed = true; }
    }
    return changed;
}

/** `conversationId\u0000userId` keys → user ids per conversation, caller excluded. */
function groupTypers(typers: Map<string, number>, currentUserId?: string | null): Record<string, string[]> {
    const next: Record<string, string[]> = {};
    for (const key of typers.keys()) {
        const [conversationId, userId] = key.split('\u0000');
        if (userId === currentUserId) continue;
        (next[conversationId] ||= []).push(userId);
    }
    return next;
}

/** Tell the project we are here, now and every PRESENCE_BEAT_MS while mounted. */
function usePresenceHeartbeat(projectId: string | null | undefined, enabled: boolean) {
    useEffect(() => {
        if (!enabled || !projectId) return undefined;
        const beat = () => {
            apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/presence`, {}, { retry: false }).catch(() => {});
        };
        beat();
        const timer = setInterval(beat, PRESENCE_BEAT_MS);
        return () => clearInterval(timer);
    }, [projectId, enabled]);
}

export function ProjectLiveProvider({ projectId, currentUserId, enabled = true, children }: {
    projectId: string | null | undefined;
    currentUserId?: string | null;
    enabled?: boolean;
    children: React.ReactNode;
}) {
    const qc = useQueryClient();
    const handlers = useRef(new Set<ProjectLiveHandler>());
    const seen = useRef(new Map<string, number>());
    const typers = useRef(new Map<string, number>());
    const lastTypingSent = useRef(0);
    const [online, setOnline] = useState<string[]>([]);
    const [typing, setTyping] = useState<Record<string, string[]>>({});

    const publishPresence = useCallback(() => {
        setOnline([...seen.current.keys()].filter(id => id !== currentUserId));
    }, [currentUserId]);

    const publishTyping = useCallback(() => setTyping(groupTypers(typers.current, currentUserId)), [currentUserId]);

    const trackPeople = useCallback((kind: string, event: ProjectLiveEvent) => {
        const now = Date.now();
        const actor = event.actorId;
        if (!actor) return;
        const fresh = !seen.current.has(actor);
        seen.current.set(actor, now);
        if (fresh) publishPresence();
        const convId = conversationOf(event);
        if (!convId) return;
        const key = `${convId}\u0000${actor}`;
        if (kind === 'presence.typing') {
            typers.current.set(key, now);
            publishTyping();
        } else if ((kind === 'chat.message.created' || kind === 'message.created') && typers.current.delete(key)) {
            publishTyping();
        }
    }, [publishPresence, publishTyping]);

    const onEvent = useCallback((kind: string, raw: unknown) => {
        if (!projectId) return;
        const event = (raw && typeof raw === 'object' ? raw : {}) as ProjectLiveEvent;
        trackPeople(kind, event);
        for (const key of keysForEvent(projectId, kind)) qc.invalidateQueries({ queryKey: key });
        if (affectsActivity(kind, event)) qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
        for (const handler of handlers.current) {
            try { handler(kind, event); } catch { /* one panel's bug must not stop the others */ }
        }
    }, [projectId, qc, trackPeople]);

    useProjectStream({ projectId, enabled: enabled && !!projectId, onEvent });

    usePresenceHeartbeat(projectId, enabled);

    // Reset per project and expire stale presence/typing.
    useEffect(() => {
        seen.current.clear();
        typers.current.clear();
        setOnline([]);
        setTyping({});
        if (!enabled || !projectId) return undefined;
        const sweep = setInterval(() => {
            const now = Date.now();
            if (stripExpired(seen.current, now, PRESENCE_TTL_MS)) publishPresence();
            if (stripExpired(typers.current, now, TYPING_TTL_MS)) publishTyping();
        }, 2_000);
        return () => clearInterval(sweep);
    }, [projectId, enabled, publishPresence, publishTyping]);

    const subscribe = useCallback((handler: ProjectLiveHandler) => {
        handlers.current.add(handler);
        return () => { handlers.current.delete(handler); };
    }, []);

    const notifyTyping = useCallback((conversationId: string) => {
        if (!projectId || !conversationId) return;
        const now = Date.now();
        if (now - lastTypingSent.current < TYPING_THROTTLE_MS) return;
        lastTypingSent.current = now;
        apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/typing`, { conversationId }, { retry: false }).catch(() => {});
    }, [projectId]);

    const value = useMemo<ProjectLiveValue>(() => ({ online, typing, subscribe, notifyTyping }), [online, typing, subscribe, notifyTyping]);
    return <ProjectLiveCtx.Provider value={value}>{children}</ProjectLiveCtx.Provider>;
}

/** The live feed of the project page this component sits in. Outside a
 *  provider it is inert (no presence, no events), never an error. */
export function useProjectLive(): ProjectLiveValue {
    return useContext(ProjectLiveCtx);
}
