/**
 * The schedule tick's holiday check: should this claimed schedule stay quiet
 * because its slot falls on a public holiday?
 *
 * `schedule.skipHolidays` (handoff 5) is honoured in two places. Every
 * next_run_at the runner computes already steps over holidays
 * (automation/holidays.nextScheduledRunAt), so normally a holiday slot is
 * never stored. This check is the safety net for the slots that were stored
 * without it: a next_run_at armed before the flag was published, or by a path
 * that computed it plainly. A claimed slot on a holiday is not run; the
 * schedule moves on to its next non-holiday slot.
 *
 * The flag is read from the LIVE definition (definitionForRun), the copy a
 * scheduled run executes. The date is the scheduled slot's own date in the
 * schedule's time zone, so a run that is picked up late is judged by when it
 * was due, not by when a pod got to it.
 *
 * Pure: no store access, no clock unless `now` is left out.
 */

'use strict';

const { definitionForRun } = require('../definitionForRun');
const holidays = require('../../../automation/holidays');

/**
 * @param {object} automation  the claimed automation row
 * @param {{ triggerStepId?: string|null, cron: string, tz?: string|null, scheduledFor?: string|null, now?: number }} slot
 * @returns {null | { holiday: { date: string, key: string, name: string }, nextRunAt: string|null }}
 *          null = run it; otherwise skip it and store `nextRunAt`.
 */
function holidaySkipFor(automation, { triggerStepId = null, cron, tz = null, scheduledFor = null, now = Date.now() } = {}) {
    if (!automation || typeof cron !== 'string' || !cron.trim()) return null;
    const { definition } = definitionForRun(automation, { mode: 'live', triggerKind: 'schedule' });
    if (!holidays.scheduleSkipsHolidays(definition, triggerStepId)) return null;
    const zone = tz || 'Europe/Amsterdam';
    const due = scheduledFor ? Date.parse(scheduledFor) : NaN;
    let holiday = null;
    try { holiday = holidays.holidayAt(Number.isFinite(due) ? due : now, zone); } catch { return null; }
    if (!holiday) return null;
    let nextRunAt = null;
    try { nextRunAt = holidays.nextScheduledRunAt(cron, zone, now, { skipHolidays: true }); } catch { nextRunAt = null; }
    return { holiday, nextRunAt };
}

module.exports = { holidaySkipFor };
