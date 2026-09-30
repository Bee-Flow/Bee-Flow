// Keeping a comment panel current while other people comment.
//
// Inside the project workspace one live feed already runs for the whole page
// (ProjectLiveProvider); the panel listens to it and refetches its item's
// threads when a `comment.*` event is about that item. Outside the workspace
// (a notebook or document opened on its own page) there is no feed, so the
// panel polls instead. Which of the two applies is learned, not configured: a
// panel that heard any event in the last LIVE_WINDOW_MS relies on the feed
// (the provider's own presence heartbeat arrives every half minute), one that
// did not keeps polling.
//
// The transient `comment.ai.started` / `comment.ai.finished` pair tells which
// threads have an AI answer being written, for a quiet "AI is answering…".
// The reader's own post says so too (`reportAi`, with what the server
// answered), so the line shows at once — and outside the workspace, where no
// feed runs, at all. A post the AI will not answer, and an answer that was
// blocked or failed, leave a note on the thread (commentAi.ts).

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invalidateCommentThreads, type CommentAiResult, type CommentTarget, type CommentThread } from '../../api/queries/comments';
import { useProjectLive, type ProjectLiveEvent } from '../projects/workspace/ProjectLiveContext';
import { aiFinishedNote, aiOutcomeOf, type CommentAiNote } from './commentAi';

export const LIVE_WINDOW_MS = 90_000;
/** Longer than any answer may take: a lost "finished" never leaves the indicator on. */
const AI_RUNNING_MAX_MS = 150_000;

/** An answer being written: since when, and after which comment (null when only the feed said so). */
export interface AiRun { at: number; afterSeq: number | null }

export interface CommentsLive {
    /** True while a live feed is delivering events; false means "poll". */
    live: boolean;
    /** Thread ids with an AI answer being written. */
    aiRunning: ReadonlyMap<string, AiRun>;
    /** What the AI did about the reader's last ask in a thread, when it is worth saying. */
    aiNotes: ReadonlyMap<string, CommentAiNote>;
    /** The server's `ai` answer to the reader's own post in `threadId`; `afterSeq` is that comment's seq. */
    reportAi: (threadId: string, ai: CommentAiResult | null | undefined, opts: { askedAi: boolean; afterSeq: number | null }) => void;
}

const withKey = <V,>(map: Map<string, V>, key: string, value: V | null): Map<string, V> => {
    if (value === null ? !map.has(key) : map.get(key) === value) return map;
    const next = new Map(map);
    if (value === null) next.delete(key); else next.set(key, value);
    return next;
};

/**
 * Is an answer still being written in this thread? One the reader asked for
 * ends when an AI comment after theirs shows up (polling brings it too); one
 * only the feed announced ends with the feed's "finished".
 */
export function aiRunningIn(thread: Pick<CommentThread, 'id' | 'comments'>, running: ReadonlyMap<string, AiRun>): boolean {
    const run = running.get(thread.id);
    if (!run) return false;
    if (run.afterSeq === null) return true;
    const after = run.afterSeq;
    return !thread.comments.some(c => c.authorKind === 'assistant' && c.seq > after);
}

function aboutTarget(event: ProjectLiveEvent, target: CommentTarget): boolean {
    const p = event.payload || {};
    return p.targetType === target.targetType && p.targetId === target.targetId;
}

export function useCommentsLive(target: CommentTarget): CommentsLive {
    const qc = useQueryClient();
    const { subscribe } = useProjectLive();
    const lastEventAt = useRef(0);
    const [live, setLive] = useState(false);
    const [aiRunning, setAiRunning] = useState<Map<string, AiRun>>(() => new Map());
    const [aiNotes, setAiNotes] = useState<Map<string, CommentAiNote>>(() => new Map());
    const { projectId, targetType, targetId } = target;

    useEffect(() => subscribe((kind, event) => {
        lastEventAt.current = Date.now();
        setLive(true);
        if (!kind.startsWith('comment.')) return;
        const scope = { projectId, targetType, targetId };
        if (!aboutTarget(event, scope)) return;
        const threadId = String(event.payload?.threadId || '');
        if (kind === 'comment.ai.started' && threadId) {
            setAiRunning(prev => withKey(prev, threadId, { at: Date.now(), afterSeq: prev.get(threadId)?.afterSeq ?? null }));
            setAiNotes(prev => withKey(prev, threadId, null));
            return;
        }
        if (kind === 'comment.ai.finished' && threadId) {
            setAiRunning(prev => withKey(prev, threadId, null));
            setAiNotes(prev => withKey(prev, threadId, aiFinishedNote(event.payload?.status)));
        }
        void invalidateCommentThreads(qc, scope);
    }), [subscribe, qc, projectId, targetType, targetId]);

    // Fall back to polling when the feed goes quiet, and drop stale indicators.
    useEffect(() => {
        const timer = setInterval(() => {
            const now = Date.now();
            if (lastEventAt.current && now - lastEventAt.current > LIVE_WINDOW_MS) setLive(false);
            setAiRunning(prev => {
                const stale = [...prev].filter(([, run]) => now - run.at > AI_RUNNING_MAX_MS);
                if (!stale.length) return prev;
                const next = new Map(prev);
                for (const [id] of stale) next.delete(id);
                return next;
            });
        }, 15_000);
        return () => clearInterval(timer);
    }, []);

    const reportAi = useCallback<CommentsLive['reportAi']>((threadId, ai, { askedAi, afterSeq }) => {
        const outcome = aiOutcomeOf(ai, askedAi);
        if (outcome === 'queued') setAiRunning(prev => withKey(prev, threadId, { at: Date.now(), afterSeq }));
        setAiNotes(prev => withKey(prev, threadId, outcome === 'queued' ? null : outcome));
    }, []);

    return { live, aiRunning, aiNotes, reportAi };
}
