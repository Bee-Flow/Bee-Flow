/**
 * useCollab — join the co-editing session of one notebook or page.
 *
 *   const collab = useCollab({ projectId, kind: 'notebook', resourceId, enabled, user });
 *   <RichTextEditor collab={collab} … />
 *   <CollabPresence handle={collab} />
 *
 * Returns null when co-editing does not apply (disabled, no project, no user).
 * Otherwise a handle whose `status` walks connecting → synced (or readonly for
 * a viewer); `connecting` also while a join that failed in a way that may pass
 * is retried; `offline` while the connection is down (typing keeps working and
 * is sent when it is back); `disabled` when the server says this item is not
 * co-edited (the caller falls back to its own save path); `error` when the
 * session ended (item deleted, access revoked). `retry()` starts a fresh
 * session (a page that learns the item is co-edited after all).
 *
 * The session has its own stream subscription (useProjectStream with `doc`),
 * so it works on any page, inside a project workspace or not. Edits the server
 * has not confirmed are sent right away when the tab is hidden, with requests
 * that outlive the page when it closes, and closing the page asks first while
 * any are left.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { useProjectMembersQuery } from '../../api/queries/projects';
import useProjectStream, { type ProjectStreamStatus } from '../../hooks/useProjectStream';
import { readPeers, type CursorState } from './awareness';
import { peerColor, peerColorIndex } from './colors';
import { defaultHttp } from './http';
import { CollabProvider, type CollabHttp, type CollabKind, type CollabStatus } from './provider';

export type { CollabStatus, CollabKind } from './provider';

export interface CollabPeer {
    clientId: number;
    userId: string;
    name?: string;
    color: string;
    colorIndex: number;
    editing: boolean;
    cursor: CursorState | null;
}

export interface CollabHandle {
    status: CollabStatus;
    canEdit: boolean;
    /** True once the first sync landed (sticky): the editor binds from then on. */
    ready: boolean;
    /**
     * The session ended (`error`/`disabled`) before the server confirmed
     * edits made here: they are only in this editor now, and the page keeps
     * them before anything replaces it.
     */
    unsent?: boolean;
    ydoc: Y.Doc;
    fragment: Y.XmlFragment;
    awareness: Awareness;
    peers: CollabPeer[];
    lastError?: string;
    /** The signed-in user this session runs as. */
    userId: string;
    /** End this session and join again with a fresh one. */
    retry(): void;
    destroy(): void;
}

export interface UseCollabOptions {
    projectId: string | null | undefined;
    kind: CollabKind;
    resourceId: string | null | undefined;
    enabled: boolean;
    user: { id: string; name?: string } | null;
    /** Test seam: the HTTP transport. */
    http?: CollabHttp;
}

/** Wire a session to the page's lifecycle; returns the function that unwires it. */
function watchPage(p: CollabProvider): () => void {
    // Hidden may be for good (a closed laptop, a killed tab): send now, not after the batch window.
    const onVisibility = () => { if (document.hidden) p.flush(); };
    const onPageHide = () => p.flushOnExit();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (!p.hasPending()) return;
        e.preventDefault();
        e.returnValue = '';
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('beforeunload', onBeforeUnload);
    };
}

const noopSubscribe = () => () => {};

/**
 * The session's document stream: opened after the first sync, so it resumes
 * from that sync's sequence instead of replaying the document's whole
 * history; `epoch` changes when the provider needs it opened again.
 */
function docStream(provider: CollabProvider | null) {
    const docId = provider?.docId || null;
    const open = !!(provider && docId && provider.ready && provider.status !== 'error' && provider.status !== 'disabled');
    return { docId, open, epoch: provider?.streamEpoch ?? 0 };
}

export default function useCollab({
    projectId, kind, resourceId, enabled, user, http,
}: UseCollabOptions): CollabHandle | null {
    const userId = user?.id || '';
    const active = !!(enabled && projectId && resourceId && userId);
    const [provider, setProvider] = useState<CollabProvider | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!active) { setProvider(null); return undefined; }
        const p = new CollabProvider({
            projectId: projectId!,
            kind,
            resourceId: resourceId!,
            userId,
            http: http || defaultHttp,
            // A console line with codes only: never document content.
            onWarn: (message) => console.warn(message),
        });
        setProvider(p);
        p.start();
        const unwatch = watchPage(p);
        return () => {
            unwatch();
            p.destroy();
        };
    }, [active, projectId, kind, resourceId, userId, http, attempt]);

    const version = useSyncExternalStore(
        provider ? provider.subscribe : noopSubscribe,
        () => (provider ? provider.version : -1),
        () => -1,
    );

    const onEvent = useCallback((k: string, ev: unknown) => provider?.handleEvent(k, ev), [provider]);
    const onReady = useCallback((r: { reconnect: boolean }) => provider?.handleReady(r), [provider]);
    const onStatus = useCallback((s: ProjectStreamStatus) => provider?.handleStreamStatus(s), [provider]);
    const docSince = useCallback(() => provider?.seq ?? 0, [provider]);
    const stream = docStream(provider);

    useProjectStream({
        projectId,
        enabled: stream.open,
        doc: stream.docId,
        docSince,
        onEvent,
        onReady,
        onStatus,
        pollActivity: false,
        reconnectKey: stream.epoch,
    });

    const members = useProjectMembersQuery(active ? projectId : null);
    const people = members.data?.people;

    return useMemo<CollabHandle | null>(() => {
        if (!provider) return null;
        const peers: CollabPeer[] = readPeers(provider.awareness).map((p) => ({
            clientId: p.clientId,
            userId: p.userId,
            name: people?.[p.userId]?.name || undefined,
            color: peerColor(p.userId),
            colorIndex: peerColorIndex(p.userId),
            editing: p.editing,
            cursor: p.cursor,
        }));
        return {
            status: provider.status,
            canEdit: provider.canEdit,
            ready: provider.ready,
            unsent: provider.unsent,
            ydoc: provider.ydoc,
            fragment: provider.fragment,
            awareness: provider.awareness,
            peers,
            lastError: provider.lastError,
            userId,
            retry: () => setAttempt((n) => n + 1),
            destroy: () => provider.destroy(),
        };
        // `version` is the change signal of the provider's mutable fields.
    }, [provider, version, people, userId]);
}
