/**
 * Keep `automation_schedules` in step with an automation's ADDITIONAL schedule
 * triggers (`definition.triggers[]`, kind 'schedule').
 *
 * Called beside syncAppEventSubscription from the two places a definition
 * becomes live: PUT /:id on an active automation (only when the schedule
 * fingerprint changed — a node nudge must not re-anchor a slot) and
 * POST /:id/activate (always, re-armed). The primary schedule is NOT handled
 * here: it lives on the automations row (triggerColumns.js) and the activate
 * route computes its next_run_at itself.
 *
 * Dependencies are injectable so the unit test needs no database.
 */

const DEFAULT_TZ = require('./triggerColumns').DEFAULT_SCHEDULE_TZ;

function secondarySchedules(def) {
    return (Array.isArray(def?.triggers) ? def.triggers : [])
        .filter(t => t && typeof t === 'object' && t.kind === 'schedule' && typeof t.id === 'string' && t.id
            && typeof t.schedule?.cron === 'string' && t.schedule.cron.trim())
        .map(t => ({
            id: t.id,
            cron: t.schedule.cron.trim(),
            tz: (typeof t.schedule.tz === 'string' && t.schedule.tz.trim()) ? t.schedule.tz.trim() : DEFAULT_TZ,
            // Handoff 5: part of the firing config, so the fingerprint moves
            // (and the slot is recomputed) when it is switched.
            skipHolidays: t.schedule.skipHolidays === true,
        }));
}

/** Order-insensitive fingerprint of the secondary schedules' firing config. */
function scheduleFingerprint(def) {
    return JSON.stringify(secondarySchedules(def).sort((a, b) => a.id.localeCompare(b.id)));
}

/**
 * @param {string} automationId
 * @param {object} def            the automation definition
 * @param {object} [opts]
 * @param {boolean} [opts.rearm]  recompute every next_run_at (activation)
 * @param {object} [deps]         { automationStore, cron } — injectable for tests
 * @returns {Promise<{ synced: string[], removed: boolean }>}
 */
async function syncSchedules(automationId, def, { rearm = false } = {}, deps = {}) {
    const automationStore = deps.automationStore || require('../stores/automationStore');
    const cron = deps.cron || require('./cron');
    const { isDutchHoliday } = require('./holidays');
    // A store build without the aggregate (older image, stubbed test) keeps
    // the old behaviour rather than throwing on every save.
    if (typeof automationStore.upsertSchedule !== 'function') return { synced: [], removed: false };

    const wanted = secondarySchedules(def);
    const synced = [];
    for (const s of wanted) {
        let next = null;
        try {
            next = s.skipHolidays
                ? cron.nextRunAt(s.cron, s.tz, Date.now(), { skipDate: (y, m, d) => isDutchHoliday(y, m, d) })
                : cron.nextRunAt(s.cron, s.tz, Date.now());
        } catch (_) { next = null; }
        await automationStore.upsertSchedule({ automationId, triggerStepId: s.id, cron: s.cron, tz: s.tz, nextRunAt: next, rearm });
        synced.push(s.id);
    }
    if (typeof automationStore.deleteSchedulesExcept === 'function') {
        await automationStore.deleteSchedulesExcept(automationId, synced);
    }
    return { synced, removed: true };
}

module.exports = { syncSchedules, scheduleFingerprint, secondarySchedules };
