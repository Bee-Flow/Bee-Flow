/**
 * What the two run modes of a Cowork run share that needs nothing else: how a run announces itself, and whether a
 * schedule repeats (core/aiTaskRunner.js reads both and hands them to ./agentScheduleRun.js).
 */

/**
 * How a finished (or failed) run announces itself.
 *
 * Its own notification category so the bell can label it "Cowork" and link back to /app/cowork/<id>: the run
 * notification is where a person sees their cowork, so it has to be a way to reach it.
 */
export const NOTIFICATION = Object.freeze({
    category: 'cowork',
    // No link: the notification IS the result, and the one thing you want next is to talk about it. The client
    // offers "Open result in chat" instead of bouncing you to the schedule you already know about. A failure is
    // the exception: its notification links to the item.
    link: null,
    failureTitle: 'Cowork failed',
    noun: 'cowork item',
    // Titles carry no robot emoji: it said "a robot did this" on every result, the one thing the reader knows.
    prefix: '',
});

/**
 * A schedule repeats either via repeatInterval or via a daysOfWeek list. Cowork composes "every Monday at 09:00" as
 * daysOfWeek with a null interval, so keying repeat-vs-one-off on repeatInterval alone silently turns those into
 * one-shots.
 */
export function isRepeating(task: { repeatInterval?: string | null; daysOfWeek?: readonly string[] | null }): boolean {
    return !!(task.repeatInterval || (Array.isArray(task.daysOfWeek) && task.daysOfWeek.length > 0));
}
