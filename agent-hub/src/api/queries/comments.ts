// Comment threads on the notebooks, pages and documents filed in a project:
// the ONLY place that knows the /api/projects/:id/comments wire contract.
//
// One cache entry per item (project, target type, target id) holds every
// thread on it, open and resolved, each with its comments. Mutations write
// what the server answered straight into that entry, so the panel never waits
// for a refetch to show the reader's own action; live feed events (or the
// polling fallback outside the workspace) invalidate it for everyone else's.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { projectRequest as write } from './projectErrors';
import { projectKeys, type ProjectRole } from './projects';

export type CommentTargetType = 'notebook' | 'document';
export type CommentThreadStatus = 'open' | 'resolved';
export type CommentAiMode = 'off' | 'mention' | 'auto';
export type CommentAuthorKind = 'user' | 'assistant';

/**
 * Where a thread points: the selected words, a little text on either side, the
 * block they start in and — while co-editing — Y relative positions. A
 * designed document adds its section id. The editor produces it
 * (`getSelectionAnchor`) and finds it again (`highlightAnchors`,
 * `scrollToAnchor`); the server only stores it, sealed.
 */
export interface CommentAnchor {
    quote: string;
    prefix: string;
    suffix: string;
    blockIndex: number;
    relStart?: string;
    relEnd?: string;
    sectionId?: string;
}

export interface ProjectComment {
    id: string;
    seq: number;
    authorKind: CommentAuthorKind;
    authorUserId: string | null;
    agentId: string | null;
    content: string;
    mentions: string[];
    mentionsAi: boolean;
    replyTo: string | null;
    clientMsgId?: string | null;
    /** Why the AI wrote this: 'ask', 'mention', or an automatic reason ('auto_…'). */
    aiTrigger: string | null;
    createdAt: string;
    editedAt: string | null;
    deleted: boolean;
    /** The text could not be decrypted; the server sent none. */
    unreadable?: boolean;
    /** On an answer the AI gave on its own: the caller's own feedback (false = "not helpful"), null for none yet. */
    feedback?: boolean | null;
}

export interface CommentThread {
    id: string;
    targetType: CommentTargetType;
    targetId: string;
    /** null: a comment on the whole item. */
    anchor: CommentAnchor | null;
    anchorUnreadable?: boolean;
    status: CommentThreadStatus;
    aiMode: CommentAiMode;
    createdBy: string;
    clientThreadId?: string | null;
    resolvedBy: string | null;
    resolvedAt: string | null;
    commentCount: number;
    /**
     * How many of its comments this copy leaves out. In the item's list a long
     * thread carries its first and latest comments, and these are in between;
     * a page of the whole thread (useFullCommentThread, and the thread a change
     * answers with) carries its latest ones, and these are older.
     */
    omittedComments?: number;
    /** After "not helpful" feedback the AI does not join by itself until then. */
    autoPausedUntil?: string | null;
    createdAt: string;
    updatedAt: string;
    comments: ProjectComment[];
}

/** What the organisation lets a thread choose: "AI decides" or not. */
export interface CommentAiPolicy { autoAllowed: boolean }

export interface CommentThreadsData {
    threads: CommentThread[];
    role: ProjectRole | null;
    /** null while unknown (an older server); the server checks either way. */
    aiPolicy?: CommentAiPolicy | null;
}

export type CommentAiStatus = 'queued' | 'skipped' | 'busy';
export interface CommentAiResult { status: CommentAiStatus; reason?: string }

export interface CommentTarget { projectId: string; targetType: CommentTargetType; targetId: string }

export interface NewThread {
    clientThreadId: string;
    anchor: CommentAnchor | null;
    content: string;
    mentions: string[];
    askAi: boolean;
}

export interface NewReply { threadId: string; clientMsgId: string; content: string; mentions: string[]; askAi: boolean }

const enc = encodeURIComponent;
/** Enough to notice another person's comment when no live feed is there. */
export const COMMENTS_POLL_MS = 20_000;

export const commentKeys = {
    all: (projectId: string) => [...projectKeys.project(projectId), 'comments'] as const,
    target: (t: CommentTarget) => [...projectKeys.project(t.projectId), 'comments', t.targetType, t.targetId] as const,
    /** One whole thread, under its item's key, so refreshing the item refreshes it too. */
    thread: (t: CommentTarget, threadId: string) => [...projectKeys.project(t.projectId), 'comments', t.targetType, t.targetId, 'thread', threadId] as const,
};

const basePath = (projectId: string) => `/api/projects/${enc(projectId)}/comments`;
const threadPath = (projectId: string, threadId: string) => `${basePath(projectId)}/${enc(threadId)}`;

/** 10 random bytes as hex, from the CSPRNG (randomUUID needs a secure context, this does not). */
function randomHex(c: Crypto): string {
    return Array.from(c.getRandomValues(new Uint8Array(10)), b => b.toString(16).padStart(2, '0')).join('');
}

/** A 64-character-or-shorter id that makes a resend idempotent. */
export function newCommentClientId(): string {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `c-${Date.now().toString(36)}-${randomHex(c)}`;
}

// ── Pure cache helpers (exported for tests) ─────────────────────────────────

/** Put a thread into the list (replacing the one with its id), oldest first. */
export function upsertThread(data: CommentThreadsData | undefined, thread: CommentThread): CommentThreadsData {
    const base = data || { threads: [], role: null };
    const others = base.threads.filter(t => t.id !== thread.id);
    const threads = [...others, thread].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { ...base, threads };
}

/** Change one thread in the list; unknown ids leave the list as it is. */
export function patchThread(data: CommentThreadsData | undefined, threadId: string,
    change: (t: CommentThread) => CommentThread): CommentThreadsData | undefined {
    if (!data) return data;
    return { ...data, threads: data.threads.map(t => (t.id === threadId ? change(t) : t)) };
}

/**
 * A thread's comments from the item's list and from the whole thread, as one
 * list in seq order. The list's copy wins: the reader's own changes land there.
 */
export function mergeThreadComments(listed: ProjectComment[], whole: ProjectComment[] | undefined): ProjectComment[] {
    if (!whole || whole.length === 0) return listed;
    const byId = new Map(whole.map(c => [c.id, c]));
    for (const c of listed) byId.set(c.id, c);
    return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** What a thread card shows: its comments, how many are still left out, and where they are missing. */
export interface ShownThread { comments: ProjectComment[]; omitted: number; gapAt: number }

/**
 * The list's copy of a thread merged with the pages of the whole thread read
 * so far (newest page first). Still left out: what the oldest page says is
 * older than itself, less what the list already shows of that. The gap sits
 * where the seq (gapless per thread) jumps: after the first comment for the
 * list's copy, before everything for a page of the latest ones.
 */
export function shownThread(listed: CommentThread, pages: CommentThread[] | undefined): ShownThread {
    let comments = listed.comments;
    for (const page of pages || []) comments = mergeThreadComments(comments, page.comments);
    const oldest = pages && pages.length > 0 ? pages[pages.length - 1] : null;
    let omitted = listed.omittedComments || 0;
    if (oldest) {
        const from = oldest.comments[0]?.seq;
        const alreadyShown = from == null ? 0 : comments.filter(c => c.seq < from).length;
        omitted = Math.max(0, (oldest.omittedComments || 0) - alreadyShown);
    }
    let gapAt = comments.length > 0 && comments[0].seq > 1 ? 0 : Math.min(1, comments.length);
    for (let i = 1; i < comments.length && gapAt > 0; i++) if (comments[i].seq > comments[i - 1].seq + 1) { gapAt = i; break; }
    return { comments, omitted, gapAt };
}

/** Add or replace one comment in a thread, keeping seq order. */
export function withComment(thread: CommentThread, comment: ProjectComment): CommentThread {
    const comments = [...thread.comments.filter(c => c.id !== comment.id), comment].sort((a, b) => a.seq - b.seq);
    const added = thread.comments.some(c => c.id === comment.id) ? 0 : 1;
    return { ...thread, comments, commentCount: thread.commentCount + (comment.deleted ? 0 : added) };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export function useCommentThreads(target: CommentTarget, { enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {}) {
    return useQuery<CommentThreadsData, Error>({
        queryKey: commentKeys.target(target),
        enabled: enabled && !!target.projectId && !!target.targetId,
        refetchInterval: poll ? COMMENTS_POLL_MS : false,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ threads?: CommentThread[]; role?: ProjectRole; aiPolicy?: CommentAiPolicy }>(basePath(target.projectId), {
                signal, query: { targetType: target.targetType, targetId: target.targetId, status: 'all' },
            });
            return { threads: Array.isArray(body?.threads) ? body!.threads! : [], role: body?.role || null, aiPolicy: body?.aiPolicy || null };
        },
    });
}

/**
 * The whole of one thread (the list leaves the middle of a long one out),
 * while `enabled`: page by page backwards from its latest comments, each page
 * asked before the oldest comment of the one before, until none is left.
 */
export function useFullCommentThread(target: CommentTarget, threadId: string, enabled: boolean) {
    return useInfiniteQuery<CommentThread, Error>({
        queryKey: commentKeys.thread(target, threadId),
        enabled: enabled && !!target.projectId && !!threadId,
        initialPageParam: null,
        getNextPageParam: (last) => ((last.omittedComments || 0) > 0 && last.comments.length > 0 ? last.comments[0].seq : undefined),
        queryFn: async ({ signal, pageParam }) => {
            const before = typeof pageParam === 'number' ? pageParam : null;
            const body = await apiClient.get<{ thread?: CommentThread }>(threadPath(target.projectId, threadId), {
                signal, ...(before != null ? { query: { before } } : {}),
            });
            if (!body?.thread) throw new Error('Could not load the thread');
            return body.thread;
        },
    });
}

// ── Writing ─────────────────────────────────────────────────────────────────

function useTargetCache(target: CommentTarget) {
    const qc = useQueryClient();
    const key = commentKeys.target(target);
    return {
        qc,
        key,
        set: (update: (data: CommentThreadsData | undefined) => CommentThreadsData | undefined) => qc.setQueryData<CommentThreadsData>(key, update),
    };
}

export function useCreateCommentThread(target: CommentTarget) {
    const cache = useTargetCache(target);
    return useMutation<{ thread: CommentThread; ai: CommentAiResult }, Error, NewThread>({
        mutationFn: async (vars) => {
            // One automatic retry is safe: the server stores a clientThreadId once.
            const body = await write('Could not add the comment', () => apiClient.post<{ thread?: CommentThread; ai?: CommentAiResult }>(
                basePath(target.projectId),
                { targetType: target.targetType, targetId: target.targetId, ...vars },
                { retry: { attempts: 1 } },
            ));
            if (!body?.thread?.id) throw new Error('Could not add the comment');
            return { thread: body.thread, ai: body.ai || { status: 'skipped' } };
        },
        onSuccess: ({ thread }) => { cache.set(data => upsertThread(data, thread)); },
    });
}

export function useReplyToThread(target: CommentTarget) {
    const cache = useTargetCache(target);
    return useMutation<{ comment: ProjectComment; ai: CommentAiResult; status: CommentThreadStatus | null }, Error, NewReply>({
        mutationFn: async ({ threadId, ...vars }) => {
            const body = await write('Could not send the reply', () => apiClient.post<{
                comment?: ProjectComment; ai?: CommentAiResult; thread?: { status?: CommentThreadStatus };
            }>(`${threadPath(target.projectId, threadId)}/replies`, vars, { retry: { attempts: 1 } }));
            if (!body?.comment?.id) throw new Error('Could not send the reply');
            return { comment: body.comment, ai: body.ai || { status: 'skipped' }, status: body.thread?.status || null };
        },
        onSuccess: ({ comment, status }, vars) => {
            cache.set(data => patchThread(data, vars.threadId, t => ({ ...withComment(t, comment), status: status || t.status })));
        },
    });
}

export function useEditComment(target: CommentTarget) {
    const cache = useTargetCache(target);
    return useMutation<ProjectComment, Error, { threadId: string; commentId: string; content: string; mentions: string[] }>({
        mutationFn: async ({ threadId, commentId, content, mentions }) => {
            const body = await write('Could not save the comment', () => apiClient.patch<{ comment?: ProjectComment }>(
                `${threadPath(target.projectId, threadId)}/replies/${enc(commentId)}`, { content, mentions }, { retry: false }));
            if (!body?.comment) throw new Error('Could not save the comment');
            return body.comment;
        },
        onSuccess: (comment, vars) => { cache.set(data => patchThread(data, vars.threadId, t => withComment(t, comment))); },
    });
}

export function useDeleteComment(target: CommentTarget) {
    const cache = useTargetCache(target);
    return useMutation<void, Error, { threadId: string; commentId: string }>({
        mutationFn: async ({ threadId, commentId }) => {
            await write('Could not delete the comment', () => apiClient.delete(
                `${threadPath(target.projectId, threadId)}/replies/${enc(commentId)}`, { retry: false }));
        },
        onSuccess: (_r, { threadId, commentId }) => {
            cache.set(data => patchThread(data, threadId, t => ({
                ...t,
                commentCount: Math.max(0, t.commentCount - 1),
                comments: t.comments.map(c => (c.id === commentId ? { ...c, content: '', mentions: [], deleted: true } : c)),
            })));
        },
    });
}

/** Resolve or reopen. The thread moves at once and moves back if refused. */
export function useSetThreadStatus(target: CommentTarget) {
    const cache = useTargetCache(target);
    return useMutation<CommentThread, Error, { threadId: string; status: CommentThreadStatus }, { previous?: CommentThreadsData }>({
        mutationFn: async ({ threadId, status }) => {
            const action = status === 'resolved' ? 'resolve' : 'reopen';
            const body = await write(status === 'resolved' ? 'Could not resolve the thread' : 'Could not reopen the thread',
                () => apiClient.post<{ thread?: CommentThread }>(`${threadPath(target.projectId, threadId)}/${action}`, {}, { retry: false }));
            if (!body?.thread) throw new Error('Could not update the thread');
            return body.thread;
        },
        onMutate: async ({ threadId, status }) => {
            await cache.qc.cancelQueries({ queryKey: cache.key, exact: true });
            const previous = cache.qc.getQueryData<CommentThreadsData>(cache.key);
            cache.set(data => patchThread(data, threadId, t => ({ ...t, status })));
            return { previous };
        },
        onError: (_e, _vars, ctx) => { if (ctx?.previous) cache.qc.setQueryData(cache.key, ctx.previous); },
        onSuccess: (thread) => { cache.set(data => upsertThread(data, thread)); },
    });
}

export function useSetThreadAiMode(target: CommentTarget) {
    const cache = useTargetCache(target);
    return useMutation<CommentThread, Error, { threadId: string; aiMode: CommentAiMode }, { previous?: CommentThreadsData }>({
        mutationFn: async ({ threadId, aiMode }) => {
            const body = await write('Could not change when the AI answers',
                () => apiClient.patch<{ thread?: CommentThread }>(threadPath(target.projectId, threadId), { aiMode }, { retry: false }));
            if (!body?.thread) throw new Error('Could not change when the AI answers');
            return body.thread;
        },
        onMutate: async ({ threadId, aiMode }) => {
            await cache.qc.cancelQueries({ queryKey: cache.key, exact: true });
            const previous = cache.qc.getQueryData<CommentThreadsData>(cache.key);
            cache.set(data => patchThread(data, threadId, t => ({ ...t, aiMode })));
            return { previous };
        },
        onError: (_e, _vars, ctx) => { if (ctx?.previous) cache.qc.setQueryData(cache.key, ctx.previous); },
        onSuccess: (thread) => { cache.set(data => upsertThread(data, thread)); },
    });
}

/** "Not helpful" (or taking it back) on an answer the AI gave on its own. */
export function useCommentFeedback(target: CommentTarget) {
    const cache = useTargetCache(target);
    return useMutation<{ helpful: boolean; autoPausedUntil: string | null }, Error, { threadId: string; commentId: string; helpful: boolean }>({
        mutationFn: async ({ threadId, commentId, helpful }) => {
            const body = await write('Could not save the feedback', () => apiClient.post<{ helpful?: boolean; autoPausedUntil?: string | null }>(
                `${threadPath(target.projectId, threadId)}/replies/${enc(commentId)}/feedback`, { helpful }, { retry: false }));
            return { helpful: body?.helpful === true, autoPausedUntil: body?.autoPausedUntil ?? null };
        },
        onSuccess: ({ helpful, autoPausedUntil }, { threadId, commentId }) => {
            cache.set(data => patchThread(data, threadId, t => ({
                ...t,
                autoPausedUntil,
                comments: t.comments.map(c => (c.id === commentId ? { ...c, feedback: helpful } : c)),
            })));
        },
    });
}

export function useDeleteCommentThread(target: CommentTarget) {
    const cache = useTargetCache(target);
    return useMutation<void, Error, string>({
        mutationFn: async (threadId) => {
            await write('Could not delete the thread', () => apiClient.delete(threadPath(target.projectId, threadId), { retry: false }));
        },
        onSuccess: (_r, threadId) => {
            cache.set(data => (data ? { ...data, threads: data.threads.filter(t => t.id !== threadId) } : data));
        },
    });
}

/** Mark the item's comments stale (a live event said something changed), whole threads included. */
export function invalidateCommentThreads(qc: QueryClient, target: CommentTarget) {
    return qc.invalidateQueries({ queryKey: commentKeys.target(target) });
}
