/**
 * The copy of an approved plan that a run executes: the plan's own steps, with the notifications of the run held to
 * its owner.
 *
 * An automation carries notification settings of its own (who hears about a failure, a success, a waiting approval,
 * and through which channel). By default an approval is posted as a card in the organisation's Talk approvals room,
 * and the settings can name other people and rooms. A plan says on its card who it can reach, and "only to you" has
 * to be true of everything the run sends, so a plan run never uses the automation's settings:
 *
 *   - failure and success: off. Cowork tells the owner itself (the item's own notification, once);
 *   - a waiting approval: the owner's bell, nothing else.
 *
 * The approved plan and its fingerprint are not touched: this is what the runner is handed, derived at run time.
 */

import type { Definition } from './planTypes.mts';

const OFF = Object.freeze({ enabled: false, channels: Object.freeze([]), recipients: Object.freeze([]) });

/** What a plan run tells, and whom: its owner, by the bell, when it waits for them. */
export const OWNER_ONLY_NOTIFICATIONS = Object.freeze({
    onError: OFF,
    onSuccess: OFF,
    onApproval: Object.freeze({
        enabled: true,
        channels: Object.freeze(['bell']),
        recipients: Object.freeze([Object.freeze({ type: 'owner' })]),
        urgency: 'normal',
        throttle: Object.freeze({ maxPerHour: null }),
        delivery: 'direct',
    }),
    digest: Object.freeze({ enabled: false }),
});

/** The definition a plan run executes. */
export function runCopyOf(definition: Definition): Definition {
    return { ...definition, notificationSettings: OWNER_ONLY_NOTIFICATIONS };
}
