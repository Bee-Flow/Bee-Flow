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
const { optionalFeatureModule } = require('../../core/featureModules');

/**
 * The stores this check asks, required on first use (the store and the access
 * module both sit above this one in the import graph). A caller passes its own
 * in the fourth argument only to test the decision without them.
 */
/**
 * @typedef {{
 *   getAutomation: (id: string) => Promise<Record<string, unknown> | null | undefined>,
 *   canAccessAutomation: (automation: Record<string, unknown>, userId: string, need: string) => Promise<boolean>,
 * }} LinkDeps
 */

/**
 * A module of the automation feature, by name. Without it no automation can be linked: a NEW link is refused
 * (409 module_absent); an unchanged link never gets here, so a skill keeps the link it has.
 * @template {'stores/automationStore' | 'automation/access'} K
 * @param {K} name
 */
function automationModule(name) {
    const mod = optionalFeatureModule(name);
    if (!mod) throw new HttpError(409, 'module_absent', 'Automations are not available on this installation, so none can be linked to a skill.');
    return mod;
}

/** @type {LinkDeps} */
const defaultDeps = {
    getAutomation: (/** @type {string} */ id) => automationModule('stores/automationStore').getAutomation(id),
    canAccessAutomation: (/** @type {Record<string, unknown>} */ automation, /** @type {string} */ userId, /** @type {string} */ need) =>
        automationModule('automation/access').canAccessAutomation(automation, userId, need),
};

/**
 * Throws 403 automation_link_forbidden unless `userId` may start `automationId`.
 * @param {string|null|undefined} automationId  the link the request asks for
 * @param {string} userId
 * @param {string|null|undefined} [currentAutomationId]  the link the skill already has
 * @param {LinkDeps} [deps]
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
