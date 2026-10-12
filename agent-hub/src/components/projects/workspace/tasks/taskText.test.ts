import { describe, expect, it } from 'vitest';
import { checklistProgress, dueState, isDueSoon, isOverdue, todayKey } from './taskText';
import { routeOfLink, THREAD_SEP } from './taskLinks';

describe('task dates', () => {
    it('is overdue only when due before today and not done', () => {
        expect(isOverdue('2026-10-01', 'todo', '2026-10-02')).toBe(true);
        expect(isOverdue('2026-10-02', 'todo', '2026-10-02')).toBe(false);
        expect(isOverdue('2026-10-01', 'done', '2026-10-02')).toBe(false);
        expect(isOverdue(null, 'todo', '2026-10-02')).toBe(false);
    });

    it('calls a date due soon from today up to two days ahead, across a month end, and never when done', () => {
        expect(isDueSoon('2026-10-02', 'todo', '2026-10-02')).toBe(true);
        expect(isDueSoon('2026-11-01', 'doing', '2026-10-30')).toBe(true);
        expect(isDueSoon('2026-11-02', 'todo', '2026-10-30')).toBe(false);
        expect(isDueSoon('2026-10-01', 'todo', '2026-10-02')).toBe(false);
        expect(isDueSoon('2026-10-02', 'done', '2026-10-02')).toBe(false);
        expect(isDueSoon(null, 'todo', '2026-10-02')).toBe(false);
    });

    it('reads a due date as overdue, soon or calm', () => {
        expect(dueState('2026-10-01', 'todo', '2026-10-02')).toBe('overdue');
        expect(dueState('2026-10-03', 'todo', '2026-10-02')).toBe('soon');
        expect(dueState('2026-10-20', 'todo', '2026-10-02')).toBeNull();
        expect(dueState('2026-10-01', 'done', '2026-10-02')).toBeNull();
    });

    it('names today in the reader\'s own calendar', () => {
        expect(todayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    });
});

describe('checklist progress', () => {
    it('counts done steps, and has nothing to say without a checklist', () => {
        expect(checklistProgress([{ id: 'a', text: 'a', done: true }, { id: 'b', text: 'b', done: false }])).toEqual({ done: 1, total: 2 });
        expect(checklistProgress([])).toBeNull();
        expect(checklistProgress(undefined)).toBeNull();
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
