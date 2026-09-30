import { describe, expect, it } from 'vitest';
import { commentKeys, mergeThreadComments, patchThread, shownThread, upsertThread, withComment, type CommentThread, type ProjectComment } from './comments';

const comment = (seq: number, over: Partial<ProjectComment> = {}): ProjectComment => ({
    id: `c${seq}`, seq, authorKind: 'user', authorUserId: 'u1', agentId: null, content: `Comment ${seq}`, mentions: [],
    mentionsAi: false, replyTo: null, aiTrigger: null, createdAt: '2026-09-29T10:00:00Z', editedAt: null, deleted: false, ...over,
});

const thread = (id: string, createdAt: string, over: Partial<CommentThread> = {}): CommentThread => ({
    id, targetType: 'notebook', targetId: 'nb1', anchor: null, status: 'open', aiMode: 'mention', createdBy: 'u1',
    resolvedBy: null, resolvedAt: null, commentCount: 1, createdAt, updatedAt: createdAt, comments: [comment(1)], ...over,
});

describe('comment cache helpers', () => {
    it('keys one entry per item inside the project', () => {
        expect(commentKeys.target({ projectId: 'p1', targetType: 'document', targetId: 'd1' }))
            .toEqual(['projects', 'p1', 'comments', 'document', 'd1']);
        expect(commentKeys.all('p1')).toEqual(['projects', 'p1', 'comments']);
        // A whole thread sits under its item, so refreshing the item refreshes it.
        expect(commentKeys.thread({ projectId: 'p1', targetType: 'document', targetId: 'd1' }, 't1'))
            .toEqual(['projects', 'p1', 'comments', 'document', 'd1', 'thread', 't1']);
    });

    it('merges the listed and the whole thread in seq order, the listed copy winning', () => {
        const listed = [comment(1), comment(9, { content: 'Edited just now' }), comment(10)];
        const whole = [comment(1), ...[2, 3, 4, 5, 6, 7, 8].map(n => comment(n)), comment(9, { content: 'Before the edit' })];
        const merged = mergeThreadComments(listed, whole);
        expect(merged.map(c => c.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(merged[8].content).toBe('Edited just now');
        expect(mergeThreadComments(listed, undefined)).toBe(listed);
    });

    it('upserts a thread in creation order and replaces one with the same id', () => {
        const first = upsertThread(undefined, thread('t2', '2026-09-02T00:00:00Z'));
        const both = upsertThread(first, thread('t1', '2026-09-01T00:00:00Z'));
        expect(both.threads.map(t => t.id)).toEqual(['t1', 't2']);
        const replaced = upsertThread(both, thread('t2', '2026-09-02T00:00:00Z', { status: 'resolved' }));
        expect(replaced.threads.map(t => [t.id, t.status])).toEqual([['t1', 'open'], ['t2', 'resolved']]);
        expect(replaced.role).toBeNull();
    });

    it('patches only the named thread, and leaves an empty cache alone', () => {
        const data = { threads: [thread('t1', 'a'), thread('t2', 'b')], role: 'editor' as const };
        const out = patchThread(data, 't2', t => ({ ...t, aiMode: 'auto' }));
        expect(out?.threads.map(t => t.aiMode)).toEqual(['mention', 'auto']);
        expect(patchThread(undefined, 't2', t => t)).toBeUndefined();
    });

    it('adds a comment once, in seq order, and replaces an edited one', () => {
        const t = thread('t1', 'a', { comments: [comment(1), comment(3)], commentCount: 2 });
        const added = withComment(t, comment(2));
        expect(added.comments.map(c => c.seq)).toEqual([1, 2, 3]);
        expect(added.commentCount).toBe(3);
        const again = withComment(added, comment(2, { content: 'Edited' }));
        expect(again.commentCount).toBe(3);
        expect(again.comments[1].content).toBe('Edited');
    });
});

describe('what a long thread card shows', () => {
    const seqs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => comment(from + i));
    // 800 comments; the list holds the first and the latest 499.
    const listed = thread('t1', 'a', { commentCount: 800, omittedComments: 300, comments: [comment(1), ...seqs(302, 800)] });

    it('the list alone: the left-out comments sit after the first one', () => {
        expect(shownThread(listed, undefined)).toMatchObject({ omitted: 300, gapAt: 1 });
    });

    it('one page of the latest 500 still leaves the middle out, and says so', () => {
        // It used to read "nothing left" once the page had loaded: seq 2..300 were silently missing.
        const page = thread('t1', 'a', { omittedComments: 300, comments: seqs(301, 800) });
        const shown = shownThread(listed, [page]);
        expect(shown.comments.map(c => c.seq).slice(0, 3)).toEqual([1, 301, 302]);
        expect(shown).toMatchObject({ omitted: 299, gapAt: 1 });
    });

    it('once the pages reach the first comment nothing is left out', () => {
        const pages = [
            thread('t1', 'a', { omittedComments: 300, comments: seqs(301, 800) }),
            thread('t1', 'a', { comments: seqs(1, 300) }),
        ];
        const shown = shownThread(listed, pages);
        expect(shown.comments.map(c => c.seq)).toEqual(seqs(1, 800).map(c => c.seq));
        expect(shown.omitted).toBe(0);
    });

    it('a thread a change answered with (its latest page) shows the gap before everything', () => {
        const answered = thread('t1', 'a', { omittedComments: 300, comments: seqs(301, 800) });
        expect(shownThread(answered, undefined)).toMatchObject({ omitted: 300, gapAt: 0 });
    });
});
