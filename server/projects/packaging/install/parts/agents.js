// @typecheck
/**
 * Install the AGENTS, under the installer and acting as their user.
 */

'use strict';

const { fromRefs } = require('../../../../core/packaging/pointers');
const { clone } = require('../refs');

/**
 * Install the AGENTS.
 *
 * Nothing here re-applies the rights rule: `config.tools[*].actAs` is already
 * `'viewer'` in the file, because capture wrote it down that way and
 * sanitizeManifest hands install a checked copy. What install adds is the two
 * halves it owns —
 *
 *   - the agent is created under the INSTALLER, like every other entity;
 *   - `embed_enabled` is never set, and createAgent has no parameter for it, so
 *     the column's own `DEFAULT FALSE` is what an installed agent gets. An
 *     installed agent is not embeddable until somebody decides it should be.
 *
 * `is_published` and `shared_groups` are left at their defaults for the same
 * reason: an installed agent belongs to whoever installed it and is shared with
 * nobody until they say so.
 */
async function installAgents(entities, ctx, report) {
    if (!entities.length) return;
    const agentStore = require('../../../../stores/agentStore');
    for (const entity of entities) {
        try {
            const config = (entity.config && typeof entity.config === 'object') ? clone(entity.config) : {};
            // A pipeline release carries the agent's knowledge bases and skills
            // as `$ref` (gallery files drop them). Bases are installed before
            // any agent; a ref with nothing behind it leaves the list, named.
            const { unresolved } = fromRefs('agent', { config }, ctx.refMap);
            for (const u of unresolved) {
                report.warnings.push(`A reference to "${u.ref}" in "${entity.name}" could not be connected — whatever it pointed at was not installed.`);
            }
            // Belt and braces on the one thing that must never arrive wider
            // than it left: whatever the file says, an installed grant acts as
            // whoever uses the agent.
            if (config.tools && typeof config.tools === 'object') {
                for (const key of Object.keys(config.tools)) {
                    if (config.tools[key] && typeof config.tools[key] === 'object') config.tools[key].actAs = 'viewer';
                }
            }
            const created = await agentStore.createAgent(
                entity.name || 'Untitled agent',
                entity.description || '',
                entity.systemPrompt || '',
                ctx.ownerId,
                entity.model || null,
                Array.isArray(entity.starterPrompts) ? entity.starterPrompts : [],
                entity.threadsEnabled !== false,
                entity.copyEnabled !== false,
                entity.workspaceEnabled === true,
                config,
                ctx.organizationId,
                [],                 // shared with nobody
                null,               // and filed under no category
            );
            await agentStore.setAgentProject(created.id, ctx.ownerId, ctx.projectId);
            ctx.refMap.set(entity.ref, created.id);
            await ctx.stamp({ ref: entity.ref, kind: 'agent', entityId: created.id, payload: config });
            report.installed.agents.push({ ref: entity.ref, id: created.id, name: entity.name });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'agent', why: err.message });
        }
    }
}

module.exports = { installAgents };
