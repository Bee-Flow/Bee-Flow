import type { ProjectTask } from '../../../../api/queries/projectTasks';

// Calendar days in UTC avoid DST changing the width or duration of a task.
const DAY = 86_400_000;
export const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
export const dayKey = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => dayKey(dayNumber(day) + n);
export const monday = (day: string): string => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
export function taskRange(task: Pick<ProjectTask, 'startDate' | 'dueDate'>): { start: string; end: string } | null {
    const start = task.startDate || task.dueDate;
    const end = task.dueDate || task.startDate;
    return start && end ? { start, end } : null;
}
export type DateMove = 'move' | 'start' | 'end';
export function moveDates(task: Pick<ProjectTask, 'startDate' | 'dueDate'>, mode: DateMove, days: number) {
    const range = taskRange(task);
    if (!range) return null;
    if (mode === 'move') return { startDate: addDays(range.start, days), dueDate: addDays(range.end, days) };
    if (mode === 'start') return { startDate: dayKey(Math.min(dayNumber(range.end), dayNumber(range.start) + days)), dueDate: range.end };
    return { startDate: range.start, dueDate: dayKey(Math.max(dayNumber(range.start), dayNumber(range.end) + days)) };
}
export function rangePlacement(start: string, end: string, first: string, count: number) {
    const a = dayNumber(start) - dayNumber(first);
    const b = dayNumber(end) - dayNumber(first);
    if (b < 0 || a >= count) return null;
    return { left: Math.max(0, a), width: Math.min(count - 1, b) - Math.max(0, a) + 1, clippedStart: a < 0, clippedEnd: b >= count };
}
