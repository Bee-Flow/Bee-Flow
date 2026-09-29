/**
 * Mid-loop tool refresh — what happens when the model activates a skill.
 *
 * `executeActivateSkill` (via toolDispatcher) calls the handler this file
 * builds; it widens the integration-tool allowlist with the skills' apps and
 * pushes the freshly resolved tools onto the LIVE `tools` array the agentic
 * loop re-reads every iteration.
 *
 * Moved verbatim out of chatStream.js. The handler is built AFTER the turn's
 * preflight on purpose: it closes over the final `tools` array (the
 * upload/web-search filter may have replaced it) and over the un-tokenising
 * `onEvent` wrapper. Anything that rebinds either of those after this point
 * would leave the handler holding the older one.
 */
const agentStore = require('../../../stores/agentStore');
const log = require('../../../telemetry/log');

function createSkillActivationHandler({
    agent, agentId, userId, userAuth, messageMetadata, onEvent,
    conversation, isEphemeral, tools, disableExternalTools,
    skillApps, activatedSkillIds, baseIntegrationToolNames,
}) {
    // ── Skill activation → mid-loop tool refresh ─────────────────
    // Invoked by executeActivateSkill (via toolDispatcher) when the model
    // activates dynamic skills: widen the integration-tool allowlist with the
    // skills' apps and push the new tools onto the live `tools` array — the
    // agentic loop re-reads it every iteration, so they're visible on the
    // model's next step. Activation ids persist in conversation meta so
    // subsequent turns rebuild the same allowlist.
    const onSkillsActivated = async (justActivatedIds) => {
        const result = { addedTools: [], unavailableApps: [] };
        if (disableExternalTools) return result;

        const newApps = [];
        let activationChanged = false;
        for (const sid of justActivatedIds || []) {
            const apps = skillApps.dynamicSkillApps.get(sid);
            if (!apps) continue;
            if (!activatedSkillIds.includes(sid)) {
                activatedSkillIds.push(sid);
                activationChanged = true;
            }
            for (const a of apps) {
                if (!skillApps.allowedApps.includes(a) && !newApps.includes(a)) newApps.push(a);
            }
        }
        if (activationChanged && conversation?.id && !isEphemeral) {
            // Fire-and-forget: meta merge preserves conversationSummary etc.
            agentStore.updateConversationMeta(conversation.id, { activatedSkillIds: [...activatedSkillIds] })
                .catch(err => log.warn('[AgentRuntime] Persisting activatedSkillIds failed:', err.message));
        }
        if (newApps.length === 0) return result;

        skillApps.allowedApps.push(...newApps);
        try {
            const { getIntegrationTools } = require('../../integrations/integrationTools');
            const fresh = await getIntegrationTools({
                userId,
                session: userAuth?.session,
                isAdmin: userAuth?.session?.user?.isAdmin || false,
                agentConfig: agent.config,
                extraEnabledApps: skillApps.allowedApps,
                connectionPolicy: { ownerUserId: agent.owner_id || null, resourceType: 'agent', resourceId: agentId },
            });
            // Diff against the first-pass snapshot + current tool list so
            // deliberately-stripped tools can't re-enter via activation.
            const delta = fresh.tools.filter(t => {
                const name = t.function?.name;
                return name && !baseIntegrationToolNames.has(name) && !tools.find(x => x.function?.name === name);
            });
            // …and then narrow the delta by the SAME rules the first pass used.
            // The diff above cannot do this job: it only keeps out names that
            // were already seen, and a tool from an app this activation just
            // released is by definition a name nobody has seen. Without this
            // line a test-set run could pick up a SENDING tool halfway through
            // the turn — the one thing a test run must never do — because the
            // sandbox had been applied once, before this tool existed.
            const { narrowToolsForTurn } = require('../toolStackAssembly');
            const kept = narrowToolsForTurn({ tools: delta, agent, agentId, messageMetadata });
            if (Array.isArray(kept.sandboxWithheld) && kept.sandboxWithheld.length > 0) {
                // Say it on the same wire the first pass uses, or the run would
                // show a sandbox notice that is missing exactly the tools that
                // arrived late.
                try { onEvent?.('test_sandbox', { withheld: kept.sandboxWithheld }); } catch (_) { /* never take the turn down over telemetry */ }
            }
            for (const t of kept.tools) {
                tools.push(t);
                baseIntegrationToolNames.add(t.function.name);
                result.addedTools.push(t.function.name);
            }
            if (result.addedTools.length > 0) {
                log.info(`[AgentRuntime] Skill activation added ${result.addedTools.length} integration tool(s): ${result.addedTools.join(', ')}`);
            } else {
                // Entitlement/credential gates blocked the apps (or their tools
                // were already present) — tell the model not to chase them.
                result.unavailableApps = newApps;
            }
        } catch (err) {
            log.warn('[AgentRuntime] Skill-app tool refresh failed:', err.message);
            result.unavailableApps = newApps;
        }
        return result;
    };

    return onSkillsActivated;
}

module.exports = { createSkillActivationHandler };
