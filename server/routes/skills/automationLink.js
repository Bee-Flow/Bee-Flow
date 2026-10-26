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
 * Throws 403 automation_link_forbidden unless `userId` may start `automationId`.
 * @param {string|null|undefined} automationId  the link the request asks for
 * @param {string} userId
 * @param {string|null|undefined} [currentAutomationId]  the link the skill already has
 * @returns {Promise<void>}
 */
async function assertMayLinkAutomation(automationId, userId, currentAutomationId = null) {
    if (!automationId || automationId === (currentAutomationId || null)) return;
    const automation = await require('../../stores/automationStore').getAutomation(automationId);
    if (!automation || !await require('../../automation/access').canAccessAutomation(automation, userId, 'start')) {
        throw new HttpError(403, 'automation_link_forbidden',
            'You can only link an automation you may start: your own, or one shared with you to run or edit.');
    }
}

module.exports = { assertMayLinkAutomation };
