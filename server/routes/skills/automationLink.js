// @typecheck strict
/**
 * Who may link an automation to a skill (POST/PUT /api/skills).
 *
 * A skill linked to an automation STARTS that automation, as its owner, each
 * time the skill is used (core/tools/skillInjection.js). Linking one is
 * therefore starting it: only somebody who may start it may link it (its
 * owner, an org admin, a `run` or `edit` share; never a `view` share, never an
 * automation of another organisation). An unchanged link is not checked again,
 * so a colleague's autosave of a shared skill keeps working.
 */

'use strict';

const { HttpError } = require('../../core/http/errors');

/**
 * The stores this check asks, required on first use (the store and the access
 * module both sit above this one in the import graph). A caller passes its own
 * in the fourth argument only to test the decision without them.
 */
const defaultDeps = {
    getAutomation: (/** @type {string} */ id) => require('../../stores/automationStore').getAutomation(id),
    canAccessAutomation: (/** @type {any} */ automation, /** @type {string} */ userId, /** @type {string} */ need) =>
        require('../../automation/access').canAccessAutomation(automation, userId, need),
};

/**
 * Throws 403 automation_link_forbidden unless `userId` may start `automationId`.
 * @param {string|null|undefined} automationId  the link the request asks for
 * @param {string} userId
 * @param {string|null|undefined} [currentAutomationId]  the link the skill already has
 * @param {{ getAutomation: (id: string) => Promise<any>, canAccessAutomation: (automation: any, userId: string, need: string) => Promise<boolean> }} [deps]
 * @returns {Promise<void>}
 */
async function assertMayLinkAutomation(automationId, userId, currentAutomationId = null, deps = defaultDeps) {
    if (!automationId || automationId === (currentAutomationId || null)) return;
    const automation = await deps.getAutomation(automationId);
    if (!automation || !await deps.canAccessAutomation(automation, userId, 'start')) {
        throw new HttpError(403, 'automation_link_forbidden',
            'You can only link an automation you may start: your own, or one shared with you to run or edit.');
    }
}

module.exports = { assertMayLinkAutomation };
