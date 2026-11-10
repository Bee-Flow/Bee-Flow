// @typecheck strict
/**
 * The reaper gives up on an automation: switch it off, then tell the owner.
 *
 * 'error' alone does not stop anything — claimDueAutomations takes every due
 * row that is not 'running', so a schedule whose run takes the worker down was
 * claimed again on the next tick, reaped again, and its owner notified again,
 * without end. Switched off, it waits for someone to look at it, which is what
 * the notification has always said. When the pause cannot be written the
 * message does not claim it.
 *
 * A factory over the two stores it writes to (./reapers.js hands in the real
 * ones), so the rule is tested without a database.
 */

'use strict';

const { REAPER_MAX_ATTEMPTS } = require('../shared');
const log = require('../../../telemetry/log');
const { bestEffort } = require('../../../utils/bestEffort');

/**
 * @typedef {{
 *   updateAutomation: (id: string, patch: { isActive: boolean }, userId: string) => Promise<unknown>,
 *   resetAttempts: (id: string) => Promise<unknown>,
 * }} GiveUpAutomationStore
 * @typedef {{ createNotification: (n: { userId: string, category: string, title: string, message: string }) => Promise<unknown> }} GiveUpNotificationStore
 */

/**
 * @param {{ automationStore: GiveUpAutomationStore, notificationStore: GiveUpNotificationStore }} stores
 * @returns {(a: { id: string, userId: string, title?: string | null }) => Promise<void>}
 */
function makeGiveUp({ automationStore, notificationStore }) {
    return async function giveUpOn(a) {
        let paused = true;
        try {
            await automationStore.updateAutomation(a.id, { isActive: false }, a.userId);
            // A fresh budget for when the owner switches it back on: left at
            // the ceiling, the first hiccup after that would give up on the spot.
            await automationStore.resetAttempts(a.id).catch((e) => bestEffort('core/automationRunner/scheduler/giveUp:resetAttempts', e));
        } catch (e) {
            paused = false;
            log.error(`[AutomationRunner] could not pause ${a.id} after ${REAPER_MAX_ATTEMPTS} attempts: ${/** @type {Error} */ (e).message}`);
        }
        try {
            await notificationStore.createNotification({
                userId: a.userId,
                category: 'urgent',
                title: `⚠️ Automation failed: ${a.title}`,
                message: paused
                    ? `The automation could not complete after ${REAPER_MAX_ATTEMPTS} attempts and was paused. Open it to inspect the last run.`
                    : `The automation could not complete after ${REAPER_MAX_ATTEMPTS} attempts. Open it to inspect the last run.`,
            });
        } catch (err) { bestEffort('core/automationRunner/scheduler/giveUp:notify', err); /* non-fatal */ }
    };
}

module.exports = { makeGiveUp };
