// @typecheck
/**
 * The two lookups the caller pre-check and the one-time notice share, so both
 * walk a flow the same way: a published Step's definition (call_block) and the
 * OAuth providers an AI step is granted through its agent and its skills.
 */

'use strict';

/** @param {{ getAutomation: Function, getVersionDefinition: Function }} automationStore */
function blockDefinitionLoader(automationStore) {
    return async (blockId) => {
        const row = await automationStore.getAutomation(blockId);
        if (!row || row.kind !== 'block' || row.publishedVersion == null) return null;
        return (await automationStore.getVersionDefinition(blockId, row.publishedVersion)) || row.definition || null;
    };
}

/** (aiStep, { orgId, userId }) => OAuth provider ids the step can reach. */
function stepProvidersLoader() {
    return async (step, { orgId, userId }) => {
        const { providersForIntegrations } = require('../../auth/automationAuth');
        const enabled = new Set();
        if (step.agentId) {
            const agent = await require('../../stores/agentStore').getAgent(step.agentId);
            for (const id of (Array.isArray(agent?.config?.enabledIntegrations) ? agent.config.enabledIntegrations : [])) enabled.add(id);
        }
        const skillCtx = await require('./aiStepSkills').loadStepSkillContext({ step, ctx: { orgId, userId } });
        for (const id of skillCtx.grants.apps) enabled.add(id);
        return providersForIntegrations([...enabled]);
    };
}

module.exports = { blockDefinitionLoader, stepProvidersLoader };
