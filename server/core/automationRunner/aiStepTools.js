// @typecheck
/**
 * Which tools an ai_step is offered (split out of execAi.execAiStep): the
 * agent's per-action grants on an agent step, the user's integration catalog
 * on a step with `allowTools`, and the skills' `activate_skill` on a step
 * with skills but no agent. Everything a person would have to confirm is
 * withheld, with its reason, because an automation runs unattended.
 */

const log = require('../../telemetry/log');
const { permittedCatalog } = require('./toolIdentity');

/**
 * Agent step: the agent's per-action grants, MINUS `ask`.
 * See core/automationRunner/aiStepAgent.js for why that subtraction is the
 * whole safety of this surface. `step.allowTools` plays no part here any
 * more — the agent's permission capsule is what the author switched on — but
 * an EXPLICIT `step.tools` still narrows.
 */
async function agentStepTools({ step, ctx, agentBinding, agentToolsForStep, skillGround, skillGrants }) {
    const gate = await agentToolsForStep({
        binding: agentBinding,
        ctx,
        // `activate_skill` goes through the same gate too: no second door,
        // and past the switch that governs it.
        extraTools: skillGround.tools,
        extraToolsStartAutomations: skillGround.startsAutomations === true,
        allowList: Array.isArray(step.tools) ? step.tools : null,
        // What the step's skills grant, already under the switches.
        skillApps: skillGrants.apps,
        skillAutomationIds: skillGrants.automationIds,
    });
    const tools = gate.tools.length ? gate.tools : null;
    const toolsWithheld = gate.withheld;
    const toolsWithheldReasons = gate.reasons || {};
    if (toolsWithheld.length) {
        log.warn(`[AutomationRunner] ai_step ${step.id}: withheld ${toolsWithheld.length} tool(s) that need a person's approval — an automation runs unattended (${toolsWithheld.slice(0, 8).join(', ')}). Put an approval step after this one if the automation has to do this anyway.`);
    }
    if (gate.degraded) {
        log.warn(`[AutomationRunner] ai_step ${step.id}: tool attribution is degraded — this step is served NO registry tools (unknown narrows)`);
    }
    return { tools, toolsWithheld, toolsWithheldReasons };
}

/** `step.allowTools` without an agent: the user's permitted integration catalog. */
async function catalogStepTools({ step, ctx, skillCtx }) {
    try {
        const { getIntegrationTools } = require('../integrations/integrationTools');
        const catalog = await permittedCatalog(ctx, getIntegrationTools, {
            // Apps the step's (static) skills enable, as in chat. On this
            // path `allowTools` is the tools switch, so they ride on it.
            extraEnabledApps: skillCtx.grants.apps.length ? skillCtx.grants.apps : null,
        });
        const toolsCatalog = catalog.tools || [];
        // An EXPLICIT array is the allowlist, period: `tools: []` means
        // NO tools — matching what the inspector shows ("No tools"). The
        // old `&& step.tools.length` term made an empty allowlist grant
        // the ENTIRE permitted catalog, the exact opposite of what the
        // user configured (C14). Absent/null `tools` + allowTools:true
        // keeps the legacy "all permitted tools" behaviour.
        const allowList = Array.isArray(step.tools) ? new Set(step.tools) : null;
        const offered = allowList
            ? toolsCatalog.filter(t => allowList.has(t?.function?.name))
            : toolsCatalog;
        // Handoff 5: an automation runs unattended on this path too, so a
        // tool a person would have to confirm is withheld exactly as on
        // the agent path (aiStepAgent.withholdConfirmTools, no agent
        // config: the policy's own floor, e.g. sending always asks).
        // `tools` is only assigned the GATED list: a gate that throws
        // leaves the step without tools, never with the ungated catalog.
        const gate = require('./aiStepAgent').withholdConfirmTools(offered, null);
        return {
            tools: gate.tools.length ? gate.tools : null,
            toolsWithheld: gate.withheld,
            toolsWithheldReasons: gate.reasons || {},
        };
    } catch (e) {
        log.warn(`[AutomationRunner] ai_step tool catalog lookup failed: ${/** @type {Error} */ (e).message}`);
        return null;
    }
}

/**
 * Resolve the tools an ai_step is offered. Returns
 * `{ tools, toolsWithheld, toolsWithheldReasons }`; `tools` is null when the
 * step runs without tools (a single plain chat call).
 *
 * Optional tool access. When the builder set step.allowTools=true (or
 * step.tools is a non-empty allowlist), expose the user's full integration
 * catalog (filtered by allowlist) so the AI step can fetch data on its own —
 * useful for "answer this question about my Gmail" style steps that the
 * builder couldn't decompose into integration actions ahead of time.
 * Permissions are still enforced by the catalog: only tools the user has
 * rights to use are advertised.
 *
 * `toolsWithheld`: names the agent MAY use but this step does not get,
 * because a person would have to confirm them. They go back with the result
 * — the step editor shows them as "if you want this anyway, put an approval
 * step after it", and the run log shows what did not happen.
 */
async function resolveAiStepTools(opts) {
    const { step, agentBinding, skillGround, stepPermissions } = opts;
    let tools = null;
    let toolsWithheld = [];
    let toolsWithheldReasons = {};
    if (agentBinding) {
        ({ tools, toolsWithheld, toolsWithheldReasons } = await agentStepTools(opts));
    } else if (step.allowTools) {
        const offered = await catalogStepTools(opts);
        // A failed lookup (null) leaves the step without tools.
        if (offered) ({ tools, toolsWithheld, toolsWithheldReasons } = offered);
    }
    // A step WITH skills but WITHOUT an agent (the "Apply skill" case) still
    // gets `activate_skill`: a dynamic skill's manifest points at that tool,
    // and a manifest pointing at a tool that was not offered is an
    // instruction that leads nowhere. Touches no existing step — without
    // `skillIds` this list is empty.
    if (!agentBinding && skillGround.tools.length) {
        const base = Array.isArray(tools) ? tools : [];
        const known = new Set(base.map(t => t?.function?.name).filter(Boolean));
        let extra = skillGround.tools.filter(t => t?.function?.name && !known.has(t.function.name));
        // Handoff 5: a skill that RUNS A AUTOMATION starts it live the moment the
        // model loads it, so without an agent it hangs on the same switch as
        // with one (startAutomations; absent means off).
        if (skillGround.startsAutomations === true && !stepPermissions.startAutomations) {
            for (const t of extra) {
                toolsWithheld.push(t.function.name);
                toolsWithheldReasons[t.function.name] = 'permission';
            }
            extra = [];
        }
        if (extra.length) tools = [...base, ...extra];
    }
    if (toolsWithheld.length && !agentBinding) {
        log.warn(`[AutomationRunner] ai_step ${step.id}: withheld ${toolsWithheld.length} tool(s) this unattended step may not use (${toolsWithheld.slice(0, 8).join(', ')}).`);
    }
    return { tools, toolsWithheld, toolsWithheldReasons };
}

module.exports = { resolveAiStepTools };

/**
 * @typedef {import('./aiStepAgent').AgentTool} AiTool
 * @typedef {{ tools: AiTool[]|null, toolsWithheld: string[], toolsWithheldReasons: Record<string, string> }} AiStepToolsResult
 * @typedef {{ step: { id?: string, tools?: unknown, allowTools?: boolean },
 *             ctx: import('./aiStepAgent').StepAgentCtx,
 *             agentBinding: Parameters<typeof import('./aiStepAgent').agentToolsForStep>[0]['binding'] | null,
 *             agentToolsForStep: typeof import('./aiStepAgent').agentToolsForStep,
 *             skillGround: { tools: AiTool[], startsAutomations?: boolean },
 *             skillGrants: { apps: string[]|null, automationIds: string[]|null },
 *             skillCtx: { grants: { apps: string[] } },
 *             stepPermissions: { startAutomations?: boolean } }} AiStepToolsOpts
 */
