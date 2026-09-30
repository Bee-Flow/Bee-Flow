import { describe, expect, it } from 'vitest';
import { isOverdue, todayKey } from './taskText';
import { routeOfLink, THREAD_SEP } from './taskLinks';

describe('task dates', () => {
    it('is overdue only when due before today and not done', () => {
        expect(isOverdue('2026-10-01', 'todo', '2026-10-02')).toBe(true);
        expect(isOverdue('2026-10-02', 'todo', '2026-10-02')).toBe(false);
        expect(isOverdue('2026-10-01', 'done', '2026-10-02')).toBe(false);
        expect(isOverdue(null, 'todo', '2026-10-02')).toBe(false);
    });

    it('names today in the reader\'s own calendar', () => {
        expect(todayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    });
});

describe('where a link opens', () => {
    it('opens documents, notebooks and chats inside the project, and a thread with its chat', () => {
        expect(routeOfLink({ kind: 'document', id: 'd1' })).toEqual({ tab: 'documents', sub: 'd1' });
        expect(routeOfLink({ kind: 'notebook', id: 'n1' })).toEqual({ tab: 'notebooks', sub: 'n1' });
        expect(routeOfLink({ kind: 'chat', id: 'c1' })).toEqual({ tab: 'chats', sub: 'c1' });
        expect(routeOfLink({ kind: 'thread', id: 'm1', chatId: 'c1' })).toEqual({ tab: 'chats', sub: `c1${THREAD_SEP}m1` });
    });
});
