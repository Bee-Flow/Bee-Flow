import { describe, expect, it } from 'vitest';
import { addDays, monday, moveDates, rangePlacement, taskRange } from './taskPlanning';

describe('Gantt calendar math', () => {
    it('keeps calendar days across DST, leap days and year boundaries', () => {
        expect(addDays('2026-10-24', 3)).toBe('2026-10-27');
        expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
        expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
        expect(monday('2026-10-04')).toBe('2026-09-28');
    });
    it('moves both endpoints together and clamps resizing at a single day', () => {
        const task = { startDate: '2026-10-02', dueDate: '2026-10-06' };
        expect(moveDates(task, 'move', -3)).toEqual({ startDate: '2026-09-29', dueDate: '2026-10-03' });
        expect(moveDates(task, 'start', 8)).toEqual({ startDate: '2026-10-06', dueDate: '2026-10-06' });
        expect(moveDates(task, 'end', -8)).toEqual({ startDate: '2026-10-02', dueDate: '2026-10-02' });
    });
    it('handles legacy deadline-only tasks and unscheduled tasks', () => {
        expect(taskRange({ dueDate: '2026-10-02' })).toEqual({ start: '2026-10-02', end: '2026-10-02' });
        expect(taskRange({ startDate: '2026-10-02', dueDate: null })).toEqual({ start: '2026-10-02', end: '2026-10-02' });
        expect(moveDates({ dueDate: null }, 'move', 1)).toBeNull();
    });
    it('clips spanning tasks without inventing resize endpoints and excludes out-of-view ranges', () => {
        expect(rangePlacement('2026-09-20', '2026-11-01', '2026-10-01', 14)).toEqual({ left: 0, width: 14, clippedStart: true, clippedEnd: true });
        expect(rangePlacement('2026-10-14', '2026-10-14', '2026-10-01', 14)?.width).toBe(1);
        expect(rangePlacement('2026-10-15', '2026-10-16', '2026-10-01', 14)).toBeNull();
    });
});
