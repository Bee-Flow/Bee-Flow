// Unread marks for a project: which notebooks, documents and meetings other
// people changed since the reader last saw them, and which team chats hold
// messages they have not read. The rail draws a dot per section; a list (the
// documents table, the notebook cards) asks `isUnread(type, id)` per row and
// calls `markSeen` once the reader has had the item in view.
//
// Dots, not counts: the numbers exist, but a workspace full of badges is a
// workspace nobody enjoys opening. The reader's own changes never mark
// anything.
//
// `useChangeFeedLive` keeps the marks current: it listens to the page's one
// live feed and refreshes the change queries (once per burst) when somebody
// else changes content.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { hasUnread, useProjectChatsQuery } from '../../../api/queries/projectChats';
import {
    changeKeys, useMarkItemSeen, useProjectChangesQuery, type ChangeGroup, type ChangeItemType,
} from '../../../api/queries/projectChanges';
import { useProjectLive } from './ProjectLiveContext';
import type { WorkspaceTabId } from './types';

export interface ProjectUnread {
    /** Somebody else changed this item since the reader last saw it. */
    isUnread: (type: ChangeItemType, id: string) => boolean;
    /** The unread group of an item (who, how much, which version), if any. */
    groupOf: (type: ChangeItemType, id: string) => ChangeGroup | null;
    /** Sections with something unread, for the rail. */
    tabs: Partial<Record<WorkspaceTabId, boolean>>;
    /** The reader has seen this item (optionally: this version of it). */
    markSeen: (type: ChangeItemType, id: string, versionId?: string | null) => void;
    /** The marks could not be read: say nothing rather than guess. */
    failed: boolean;
}

const TAB_OF: Record<ChangeItemType, WorkspaceTabId> = {
    document: 'documents',
    notebook: 'notebooks',
    meeting: 'meetings',
};

export function useProjectUnread(projectId: string | null | undefined): ProjectUnread {
    const changes = useProjectChangesQuery(projectId, 'unread');
    const chats = useProjectChatsQuery(projectId || '');
    const markItem = useMarkItemSeen(projectId || '');
    const { mutate } = markItem;

    const byKey = useMemo(() => {
        const map = new Map<string, ChangeGroup>();
        for (const g of changes.data?.groups || []) if (g.unread && g.item.available) map.set(`${g.item.type}:${g.item.id}`, g);
        return map;
    }, [changes.data]);

    const tabs = useMemo(() => {
        const out: Partial<Record<WorkspaceTabId, boolean>> = {};
        for (const g of byKey.values()) out[TAB_OF[g.item.type]] = true;
        if ((chats.data?.chats || []).some((c) => !c.archived && hasUnread(c))) out.chats = true;
        return out;
    }, [byKey, chats.data]);

    const isUnread = useCallback((type: ChangeItemType, id: string) => byKey.has(`${type}:${id}`), [byKey]);
    const groupOf = useCallback((type: ChangeItemType, id: string) => byKey.get(`${type}:${id}`) || null, [byKey]);
    const markSeen = useCallback((type: ChangeItemType, id: string, versionId?: string | null) => {
        if (!projectId || !id) return;
        mutate({ type, id, versionId: versionId || null });
    }, [projectId, mutate]);

    return { isUnread, groupOf, tabs, markSeen, failed: changes.isError };
}

/** Events that mean "somebody changed content here". */
const CONTENT_EVENT = /^(content\.|doc\.(edited|restored|checkpoint)$|resource_(added|removed)$)/;
const REFRESH_DELAY_MS = 1500;

/**
 * Refresh the change queries when somebody else changes content, once per
 * burst. The reader's own changes are left alone: they are never news.
 */
export function useChangeFeedLive(projectId: string | null | undefined, currentUserId: string | null | undefined) {
    const qc = useQueryClient();
    const { subscribe } = useProjectLive();
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (!projectId) return undefined;
        const off = subscribe((kind, event) => {
            if (!CONTENT_EVENT.test(kind)) return;
            if (event?.actorId && event.actorId === currentUserId) return;
            if (timer.current) return;
            timer.current = setTimeout(() => {
                timer.current = null;
                qc.invalidateQueries({ queryKey: changeKeys.all(projectId) });
            }, REFRESH_DELAY_MS);
        });
        return () => {
            off();
            if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        };
    }, [projectId, currentUserId, subscribe, qc]);
}

/**
 * Mark an item seen once it has been open for a moment (a glance that goes
 * straight back out does not count). Pass null while nothing is open.
 */
export function useMarkSeenWhenOpen(
    unread: Pick<ProjectUnread, 'markSeen'>,
    item: { type: ChangeItemType; id: string } | null,
    delayMs = 3000,
) {
    const { markSeen } = unread;
    const type = item?.type;
    const id = item?.id;
    useEffect(() => {
        if (!type || !id) return undefined;
        const t = setTimeout(() => markSeen(type, id), delayMs);
        return () => clearTimeout(t);
    }, [type, id, delayMs, markSeen]);
}
