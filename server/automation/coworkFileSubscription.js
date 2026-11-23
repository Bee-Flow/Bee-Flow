// @typecheck strict
/**
 * The subscription of a Cowork item that starts when a new file arrives in a Nextcloud folder
 * (core/cowork/fileStart.mts): file.new for the item's owner, polled like an automation's, with the folder as its
 * filter. None while the item is paused or starts another way. ./subscriptionSync.js syncCoworkMailTrigger is the
 * one entry for an item's subscription and hands the removal of the old one in, so the two do not require each other.
 */

'use strict';

const automationStore = require('../stores/automationStore');

/**
 * @param {{ id: string, userId: string, isActive?: boolean | null, triggerKind?: string | null, trigger?: Record<string, unknown> | null }} schedule
 * @param {(scheduleId: string) => Promise<void>} revoke  removes the item's subscription rows
 */
async function syncCoworkFileTrigger(schedule, revoke) {
    await revoke(schedule.id);
    const folder = schedule.trigger?.inFolder;
    if (schedule.isActive === false || schedule.triggerKind !== 'file' || typeof folder !== 'string' || !folder) return null;
    return automationStore.createSubscription({
        coworkScheduleId: schedule.id, userId: schedule.userId, provider: 'nextcloud', eventType: 'file.new',
        mode: 'polling', filter: { inFolder: folder }, lastCursor: null,
    });
}

module.exports = { syncCoworkFileTrigger };
