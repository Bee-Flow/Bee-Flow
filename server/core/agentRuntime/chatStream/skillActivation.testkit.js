// @typecheck strict
/**
 * The mid-loop skill activation handler of ./skillActivation.js for a fixed agent with external tools off, around
 * the message metadata a test hands in (./skillActivation.test.js and the cowork module's
 * ./skillActivation.cowork.test.js).
 */

const { createSkillActivationHandler } = require('./skillActivation');

/** @param {Record<string, unknown>} messageMetadata */
const handlerFor = (messageMetadata) => createSkillActivationHandler(/** @type {Parameters<typeof createSkillActivationHandler>[0]} */ (/** @type {unknown} */ ({
    agent: { id: 'a1', config: {} }, agentId: 'a1', userId: 'u1', userAuth: {}, messageMetadata, onEvent: () => {},
    conversation: { id: 'c1' }, isEphemeral: true, tools: [], disableExternalTools: true,
    skillApps: { allowedApps: [], dynamicSkillApps: new Map(), mergedIds: [] }, activatedSkillIds: [], baseIntegrationToolNames: new Set(),
})));

module.exports = { handlerFor };
