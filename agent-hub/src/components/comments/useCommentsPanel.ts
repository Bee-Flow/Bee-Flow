// What the comments panel knows about its item: the threads (kept current by
// the live feed or by polling), who may comment, which passages are still in
// the text, and the highlights it asks the host editor to paint.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
    useCommentThreads, type CommentAnchor, type CommentTarget, type CommentTargetType, type CommentThread,
} from '../../api/queries/comments';
import type { ProjectRole } from '../../api/queries/projects';
import type { WorkspaceUser } from '../projects/workspace/types';
import { anchorState, inReadingOrder, type AnchorState } from './commentAnchors';
import { useCommentPeople } from './useCommentPeople';
import { useCommentsLive } from './useCommentsLive';

export type HighlightAnchors = (list: Array<{ id: string; anchor: CommentAnchor }>, activeId?: string | null) => void;

export interface CommentsPanelSource {
    projectId: string;
    targetType: CommentTargetType;
    targetId: string;
    role: ProjectRole | null;
    currentUser: WorkspaceUser | null;
    highlightAnchors?: HighlightAnchors;
    scrollToAnchor?: (anchor: CommentAnchor) => boolean;
    getDocumentText?: () => string;
}

const TEXT_REFRESH_MS = 10_000;

/** The item's text, re-read now and then and whenever the set of threads changes. */
function useDocumentText(get: (() => string) | undefined, threadsKey: string): string | null {
    const latest = useRef(get);
    useEffect(() => { latest.current = get; });
    const [text, setText] = useState<string | null>(null);
    const available = !!get;
    useEffect(() => {
        if (!available) { setText(null); return undefined; }
        const read = () => {
            try { setText(latest.current ? latest.current() : null); } catch { setText(null); }
        };
        read();
        const timer = setInterval(read, TEXT_REFRESH_MS);
        return () => clearInterval(timer);
    }, [available, threadsKey]);
    return text;
}

/**
 * Paint the open threads' passages (the active one stronger) and clear them
 * when the panel goes. The host's function is read through a ref, so a new
 * function identity on every host render does not repaint while someone types.
 */
function useAnchorHighlights(open: CommentThread[], states: Map<string, AnchorState>, activeId: string | null, paint?: HighlightAnchors) {
    const painter = useRef(paint);
    useEffect(() => { painter.current = paint; });
    const list = useMemo(() => open
        .filter(th => th.anchor && states.get(th.id) !== 'outdated')
        .map(th => ({ id: th.id, anchor: th.anchor as CommentAnchor })), [open, states]);
    const key = list.map(h => `${h.id}:${h.anchor.quote}`).join('\u0000');
    const current = useRef(list);
    useEffect(() => { current.current = list; }, [list]);
    useEffect(() => {
        try { painter.current?.(current.current, activeId); } catch { /* highlighting is a courtesy */ }
    }, [key, activeId]);
    useEffect(() => () => {
        try { painter.current?.([], null); } catch { /* nothing to clear */ }
    }, []);
}

export function useCommentsPanel(src: CommentsPanelSource) {
    const { projectId, targetType, targetId } = src;
    const target = useMemo<CommentTarget>(() => ({ projectId, targetType, targetId }), [projectId, targetType, targetId]);
    const live = useCommentsLive(target);
    const query = useCommentThreads(target, { poll: !live.live });
    const people = useCommentPeople(projectId, src.currentUser);
    const role = query.data?.role || src.role;
    const [activeId, setActiveId] = useState<string | null>(null);
    const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());

    const threads = useMemo(() => query.data?.threads || [], [query.data]);
    const openThreads = useMemo(() => inReadingOrder(threads.filter(th => th.status === 'open')), [threads]);
    const resolvedThreads = useMemo(() => threads.filter(th => th.status === 'resolved')
        .sort((a, b) => String(b.resolvedAt || b.updatedAt).localeCompare(String(a.resolvedAt || a.updatedAt))), [threads]);
    const docText = useDocumentText(src.getDocumentText, threads.map(th => th.id).join(','));
    const states = useMemo(() => {
        const out = new Map<string, AnchorState>();
        for (const thread of threads) {
            const state = anchorState(thread, docText);
            out.set(thread.id, state === 'unknown' && missing.has(thread.id) ? 'outdated' : state);
        }
        return out;
    }, [threads, docText, missing]);
    useAnchorHighlights(openThreads, states, activeId, src.highlightAnchors);

    /** Scroll the item to a thread's passage; one that cannot be found is marked as changed. */
    const jump = (thread: CommentThread) => {
        setActiveId(thread.id);
        if (!thread.anchor || !src.scrollToAnchor) return;
        let found = false;
        try { found = src.scrollToAnchor(thread.anchor); } catch { found = false; }
        if (!found) setMissing(prev => new Set(prev).add(thread.id));
    };

    return {
        target, live, query, people, role, canComment: role === 'owner' || role === 'editor',
        openThreads, resolvedThreads, states, activeId, setActiveId, jump,
    };
}

export type CommentsPanelModel = ReturnType<typeof useCommentsPanel>;
