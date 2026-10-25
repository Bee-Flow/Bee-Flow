// @typecheck noImplicitAny
/**
 * System-agent seeding at boot.
 *
 * One phase of boot/startupTasks.js runStartupTasks(), which calls the phases
 * in the order they always ran; see that file for the whole sequence.
 */

const log = require('../telemetry/log');

/** Seed the system agents, then point and check the support agent. */
function seedSystemAgentsAtBoot() {
    // Seed system agents into the database (explicit lifecycle call, not a require() side-effect)
    const { seedSystemAgents, SYSTEM_AGENT_IDS } = require('../stores/agent/systemAgents');
    seedSystemAgents()
        .then(async () => {
            log.info('[Server] System agents seeded');
            // Point the support AI responder at the seeded Bee Flow Support
            // singleton — keeps the existing `configStore.support_ai_agent_id`
            // contract working without admins having to paste a UUID.
            try {
                /** @type {typeof import('../stores/configStore')} */
                const configStore = require('../stores/configStore');
                const current = await configStore.getConfig('support_ai_agent_id');
                if (current !== SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT) {
                    await configStore.setConfig('support_ai_agent_id', SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT);
                    log.info('[Server] support_ai_agent_id pointed at Bee Flow Support singleton');
                }
            } catch (e) {
                log.warn('[Server] Could not sync support_ai_agent_id:', /** @type {Error} */ (e).message);
            }
            // Sanity check — if the seed failed silently or someone DELETE'd
            // the row, every support thread will escalate. Surface this as a
            // warning so operators see it without having to inspect the DB.
            try {
                const agentStore = require('../stores/agentStore');
                const cfgStore = require('../stores/configStore');
                const { pool } = require('../db');
                const agent = await agentStore.getAgent(SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT);
                if (!agent) {
                    log.warn('[Support] WARN: Bee Flow Support agent missing after seed; AI auto-responder will escalate every thread until reseeded.');
                } else if (agent.model && agent.model.startsWith('tier:')) {
                    // Self-healing: if the configured tier has no modelId in this
                    // environment, every support thread would escalate with an
                    // unhelpful "model not found" error. Auto-fallback to a tier
                    // that IS configured. Picks the first tier with a non-empty
                    // modelId in the order: fast → standard → thinking → writer → pro.
                    const tierName = agent.model.slice(5);
                    const tiers = (await cfgStore.getConfig('chat_model_tiers')) || {};
                    /**
                     * @param {string} t
                     */
                    const configured = (t) => tiers[t]?.modelId && String(tiers[t].modelId).trim().length > 0;
                    if (tierName !== 'auto' && !configured(tierName)) {
                        const fallback = ['fast', 'standard', 'thinking', 'writer', 'pro'].find(configured);
                        if (fallback) {
                            await pool.query(
                                `UPDATE agents SET model = $1, updated_at = now() WHERE id = $2`,
                                [`tier:${fallback}`, SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT]
                            );
                            log.warn(`[Support] Re-pointed Bee Flow Support from tier:${tierName} (no modelId configured) to tier:${fallback}.`);
                        } else {
                            log.warn(`[Support] WARN: tier:${tierName} has no modelId AND no other tier is configured. Configure at least one tier in Admin → AI Config → Model tiers, then update the support agent.`);
                        }
                    }
                }
            } catch (e) {
                log.warn('[Support] WARN: Bee Flow Support agent check failed:', /** @type {Error} */ (e).message);
            }
        })
        .catch(err => log.error('[Server] System agents seed failed:', err.message));
}

module.exports = { seedSystemAgentsAtBoot };
