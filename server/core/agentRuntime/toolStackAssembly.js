/**
 * Streaming agent chat — per-turn tool stack assembly.
 *
 * Builds the tool list the agentic loop offers the model: the agent's own
 * component tools, skill-scoped integration tools (Gmail, Calendar, …), the
 * always-available set_reminder / set_ai_task builtins and the per-tool fixed
 * params map. Moved verbatim out of chatStream.js; the caller wires the
 * returned state back into its own bindings (`tools` stays a live array — the
 * loop re-reads it every iteration and onSkillsActivated pushes into it).
 *
 * Last step: the headless drop. With nobody present to answer a confirmation,
 * a tool the agent's grants say to ask about is left OUT of the stack rather
 * than run unapproved or park forever, so the model never learns it exists.
 * That is a stack-shaping decision and belongs here; the per-call gate (a name
 * outside the stack, a call to hold back) lives in ./toolRoundExecutor, which
 * rebuilds the policy each round because `tools` keeps growing.
 *
 * After it, one narrower drop: `messageMetadata.testSandbox` (a test-set run,
 * routes/agents/tests.js) also removes everything that SENDS and every automation,
 * and it does so for uncurated agents too. The withheld list is returned so the
 * run can say what it took away — a test that expects an automation must read as
 * "a test run never offers this", not as "the agent refused".
 */
const { getAgentTools } = require('./agentTools');
const agentStore = require('../../stores/agentStore');
const { buildToolPolicy, isUnattended, automationConfirmsFor } = require('./toolPolicy');
const log = require('../../telemetry/log');

async function assembleToolStack({ agent, agentId, userId, userAuth, messageMetadata }) {
    let tools = await getAgentTools(agentId);

    // ── Check per-agent external tools disable flag ──────
    const disableExternalTools = agent.config?.disableExternalTools === true;

    // Effective tier for this request — direct override from the message wins,
    // otherwise the agent's configured `tier:<name>` (or no tier at all).
    // Hoisted above tool assembly so the skill-app allowlist partitions
    // static vs dynamic skills exactly like the prompt-side skill injection
    // (the Flow tier, key 'standard', forces every skill dynamic).
    const effectiveTier = (messageMetadata?.modelTier && String(messageMetadata.modelTier))
        || (typeof agent.model === 'string' && agent.model.startsWith('tier:') ? agent.model.slice(5) : null);
    const isStandardTier = effectiveTier === 'standard';

    // ── Skill-scoped app enablement ──────────────────────────────
    // Skills can carry their own enabledIntegrations. Static skills contribute
    // their apps for the whole conversation; dynamic skills only after the
    // model calls activate_skill (activations persist in conversation meta so
    // later turns keep the tools). Entitlement + credential gates still apply
    // inside getIntegrationTools — this only bypasses the per-user app toggle.
    let activatedSkillIds = [];
    let skillApps = { allowedApps: [], dynamicSkillApps: new Map(), mergedIds: [] };
    if (!disableExternalTools) {
        if (messageMetadata.conversationId && messageMetadata.ephemeral !== true) {
            try {
                const meta = await agentStore.getConversationMeta(messageMetadata.conversationId, { userId, encryptionKey: userAuth?.encryptionKey });
                if (Array.isArray(meta?.activatedSkillIds)) activatedSkillIds = [...meta.activatedSkillIds];
            } catch (metaErr) {
                log.warn('[AgentRuntime] Conversation meta read failed (skill apps):', metaErr.message);
            }
        }
        try {
            const { resolveSkillAppAllowlist } = require('../tools/skillInjection');
            skillApps = await resolveSkillAppAllowlist({
                attachedSkillIds: agent.config?.attachedSkillIds || [],
                sessionSkillIds: messageMetadata?.activeSkillIds || [],
                activatedSkillIds,
                orgId: messageMetadata?.orgId,
                userId,
                forceDynamicSkills: isStandardTier,
            });
        } catch (skillErr) {
            log.warn('[AgentRuntime] Skill app allowlist resolution failed:', skillErr.message);
        }
    }

    // ── Inject integration tools (Gmail, Calendar, etc.) ──────
    // These require OAuth tokens from the user session
    let n8nOrgId = null;
    // Names of the integration tools offered on the FIRST pass. The mid-loop
    // skill-activation refresh diffs against this so tools that were
    // deliberately stripped after assembly (agent_search, notebook tools, …)
    // can never re-enter through a skill activation.
    let baseIntegrationToolNames = new Set();
    if (!disableExternalTools) {
        try {
            const { getIntegrationTools } = require('../integrations/integrationTools');
            const session = userAuth?.session;
            const integrationResult = await getIntegrationTools({
                userId,
                session,
                isAdmin: session?.user?.isAdmin || false,
                agentConfig: agent.config,
                // The agent whose bound automations are offered as tools; with no
                // agent there are none (automation/agentBinding.js).
                agentId,
                // Skill-scoped apps: active skills widen the per-user app
                // toggle (entitlements/credentials still gate inside).
                extraEnabledApps: skillApps.allowedApps,
                // Connection lending (gated): offer a provider's tools when the
                // agent owner has LENT a connection for it, even if the running
                // user hasn't connected it. The per-tool dispatch override below
                // then runs those tools as the owner. Inert unless the flag is on.
                connectionPolicy: { ownerUserId: agent.owner_id || null, resourceType: 'agent', resourceId: agentId },
            });
            baseIntegrationToolNames = new Set(integrationResult.tools.map(t => t.function?.name).filter(Boolean));
            if (integrationResult.tools.length > 0) {
                // Deduplicate — don't add integration tools that overlap with component tools
                for (const intTool of integrationResult.tools) {
                    if (!tools.find(t => t.function?.name === intTool.function?.name)) {
                        tools.push(intTool);
                    }
                }
                log.info(`[AgentRuntime] Injected ${integrationResult.tools.length} integration tools for agent ${agentId}`);
            }
            n8nOrgId = integrationResult.n8nOrgId;
        } catch (intErr) {
            log.warn('[AgentRuntime] Integration tools injection failed:', intErr.message);
        }
    } else {
        // Also strip web search when external tools are disabled
        tools = tools.filter(t => t.function?.name !== 'agent_search');
        log.info(`[AgentRuntime] External tools disabled for agent ${agentId} — skipping integrations and web search`);
    }

    // Per-turn user toggle: strip agent_search when the composer's web-search switch is off
    if (messageMetadata?.webSearchEnabled === false) {
        tools = tools.filter(t => t.function?.name !== 'agent_search');
        log.info(`[AgentRuntime] Web search disabled by user for agent ${agentId} — stripped agent_search`);
    }

    // ── Built-in: set_reminder tool (always available) ────────────
    if (!tools.find(t => t.function?.name === 'set_reminder')) {
        tools.push({
            type: 'function',
            function: {
                name: 'set_reminder',
                description: 'Set a reminder for the user. Use when the user asks to be reminded about something at a specific time. IMPORTANT: Use the timezone from the "Now:" line in the system prompt — do NOT use UTC/Z unless the user is in UTC.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Short title for the reminder' },
                        message: { type: 'string', description: 'Optional detailed message' },
                        remind_at: { type: 'string', description: 'ISO 8601 datetime for when to remind. MUST include the user\'s timezone offset from the system prompt (e.g. "2026-03-09T15:00:00+01:00" for CET). Do NOT use "Z" unless the user is in UTC.' },
                        repeat_interval: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Optional repeat interval' },
                    },
                    required: ['title', 'remind_at'],
                },
            },
        });
    }

    // ── Built-in: set_ai_task tool (always available) ────────────
    if (!tools.find(t => t.function?.name === 'set_ai_task')) {
        tools.push({
            type: 'function',
            function: {
                name: 'set_ai_task',
                description: 'Create a scheduled AI task that runs automatically at specified times. Use this when the user wants recurring AI-generated content like news summaries, reports, digests, or any automated information gathering. The task runs in the background using web search and delivers results as notifications. IMPORTANT: Write a detailed, specific prompt for the AI to execute. Use the timezone from the "Now:" line.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Short descriptive title (e.g., "Weekly AI News Digest")' },
                        prompt: { type: 'string', description: 'Detailed instruction for the AI to execute each time. Be specific about what to search, summarize, or analyze.' },
                        repeat_interval: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'How often to run the task' },
                        first_run_at: { type: 'string', description: 'ISO 8601 datetime for the first execution. MUST include timezone offset from system prompt.' },
                        model_tier: { type: 'string', enum: ['fast', 'thinking'], description: 'AI model quality tier. Default: fast.' },
                    },
                    required: ['title', 'prompt', 'repeat_interval', 'first_run_at'],
                },
            },
        });
    }

    // Load tool configs with fixed params
    const toolConfigs = await agentStore.getAgentToolsWithParams(agentId);
    const toolParamsMap = {};
    for (const tc of toolConfigs) {
        const toolName = tc.componentId.replace(/-/g, '_');
        toolParamsMap[toolName] = tc.params;
    }
    log.info('[AgentRuntime] Tool params map:', JSON.stringify(toolParamsMap, null, 2));

    const unattended = isUnattended(messageMetadata);
    const narrowed = narrowToolsForTurn({ tools, agent, agentId, messageMetadata });
    tools = narrowed.tools;
    const sandboxWithheld = narrowed.sandboxWithheld;

    return { tools, disableExternalTools, effectiveTier, isStandardTier, activatedSkillIds, skillApps, n8nOrgId, baseIntegrationToolNames, toolParamsMap, unattended, sandboxWithheld };
}

/**
 * The two drops this turn is entitled to, over ANY list of tools.
 *
 * Extracted because the stack is not assembled once. `onSkillsActivated`
 * (chatStream.js) pushes freshly resolved integration tools into the SAME live
 * array mid-turn, when the model activates a skill whose apps were not enabled
 * at assembly time. Those tools were never narrowed, and the delta filter that
 * guards that path cannot help: it drops names already seen, and a tool from a
 * newly released app is by definition not one of them.
 *
 * Left as it was, a test-set run could therefore GAIN a sending tool halfway
 * through the turn — the one thing a test run must never do, and precisely
 * what the sandbox below exists to prevent. So both application points call
 * this, and neither owns a copy of the rules.
 *
 * @returns {{tools: Array, sandboxWithheld: Array, unattendedWithheld: string[]}}
 */
function narrowToolsForTurn({ tools, agent, agentId, messageMetadata }) {
    let out = Array.isArray(tools) ? tools : [];
    let unattendedWithheld = [];

    // ── Headless: withhold the tools that would need approval ────
    // Inert for an agent without a stored `config.tools` map — buildToolPolicy
    // gates nothing there, so an automation that has always mailed keeps its mail
    // tool and its autoSend.
    if (isUnattended(messageMetadata)) {
        try {
            // A granted automation's own `confirm` is part of the question: a
            // automation its owner put on "ask" has nobody to ask here either, so
            // it is withheld like any other confirming tool. Empty — and
            // therefore free — for an agent that grants no automations.
            const { droppedForUnattended } = buildToolPolicy({
                agentConfig: agent.config, tools: out, unattended: true,
                automationConfirms: automationConfirmsFor(out, agent.config),
            });
            if (droppedForUnattended.length > 0) {
                const drop = new Set(droppedForUnattended);
                out = out.filter(t => !drop.has(t.function?.name));
                unattendedWithheld = droppedForUnattended;
                log.info(`[AgentRuntime] Unattended run for agent ${agentId} — withheld ${droppedForUnattended.length} tool(s) needing confirmation: ${droppedForUnattended.join(', ')}`);
            }
        } catch (e) {
            // Never take a headless run down over the policy. The per-round
            // gate still refuses anything outside the stack.
            log.warn('[AgentRuntime] Unattended tool policy failed:', e.message);
        }
    }

    // ── Test run: the narrower drop ──────────────────────────────────
    // A test set replays somebody's questions through the REAL runtime, so it
    // gets the real stack minus the things that must not happen when nobody is
    // watching: anything that SENDS, any automation (whose behaviour lives in a
    // definition, so nothing here can prove it does not send), and anything
    // that would ask for confirmation. Unlike the headless drop above this
    // does NOT wait for the agent to have a curated `tools` map — that opt-in
    // exists so a mailing automation keeps working unattended, and a test run is
    // the opposite case: it may lose capability, never gain permission.
    // Rules and reasons live in ./testSandbox; this is only where they land.
    let sandboxWithheld = [];
    if (messageMetadata?.testSandbox === true) {
        try {
            const { sandboxToolStack } = require('./testSandbox');
            const sandboxed = sandboxToolStack(out, agent.config);
            sandboxWithheld = sandboxed.withheld;
            out = sandboxed.tools;
            if (sandboxWithheld.length > 0) {
                log.info(`[AgentRuntime] Test run for agent ${agentId} — withheld ${sandboxWithheld.length} tool(s): ${sandboxWithheld.map(w => `${w.name || '?'}(${w.reason})`).join(', ')}`);
            }
        } catch (e) {
            // The sandbox is the reason this turn is allowed to run at all, so
            // a failure here empties the stack rather than serving the whole
            // of it. A test with no tools grades badly; a test that mails a
            // customer is not recoverable.
            log.error('[AgentRuntime] Test sandbox failed — withholding every tool:', e.message);
            sandboxWithheld = (out || []).map(t => ({ name: (t && t.function && t.function.name) || null, reason: 'confirm' }));
            out = [];
        }
    }

    return { tools: out, sandboxWithheld, unattendedWithheld };
}

module.exports = { assembleToolStack, narrowToolsForTurn };
