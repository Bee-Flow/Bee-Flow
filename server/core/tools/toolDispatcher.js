// @typecheck
/**
 * Tool Dispatcher — the one place a tool call is executed.
 *
 * Both directChat and agentRuntime use `executeTool()` instead of maintaining
 * separate if/else chains. The dispatcher knows no integration: every tool
 * family (core's own in builtinToolFamilies.js, the integrations' in
 * integrations/toolFamilies.js, which the server loads at boot) registers with
 * toolFamilyRegistry.js, and dispatchTool walks that registry before the
 * dynamic fallbacks (agent-callable automations, reusable steps, the
 * progressive-disclosure hint, component tools).
 */

const { featureModule } = require('../featureModules');
const { executeComponentTool } = require('./toolExecution');
const { dispatchToToolFamily, getToolFamily } = require('./toolFamilyRegistry');
const { registerBuiltinToolFamilies } = require('./builtinToolFamilies');
const log = require('../../telemetry/log');
const { createEgressChokepoint } = require('./toolEgress');
const { bestEffort } = require('../../utils/bestEffort');

registerBuiltinToolFamilies();

/**
 * Execute a tool by name.
 *
 * `toolArgs` MUST ALREADY BE DE-TOKENISED. This dispatcher has no conversation
 * identity, so it cannot look up the Privacy Shield token map itself — every
 * caller runs `untokeniseToolArgs` before handing the args over, or the tool
 * writes the literal `[email_1]` placeholder wherever the real value belonged
 * (BFSF-171). The callers that do it today:
 *
 *   - core/agentRuntime/toolRoundExecutor.js — every tool, with the tool-PII
 *     block policy (on the REAL values) as the only thing that withholds PII;
 *   - routes/ai/directChat/toolExec.js       — every tool except web/agent
 *     search, whose queries deliberately keep their tokens;
 *   - routes/ai/webpageChat.js               — same carve-out as direct chat.
 *
 * routes/ai/notebookChat.js is the deliberate exception: it dispatches in token
 * space and restores at the document write boundary instead.
 *
 * @param {string} toolName - Name of the tool to execute
 * @param {Object} toolArgs - Arguments for the tool
 * @param {Object} [context]  - Execution context, handed to the tool family as is:
 *   @param {string}  [context.userId]       - Current user ID
 *   @param {Object}  [context.session]      - Express session (for OAuth tokens)
 *   @param {Object}  [context.userAuth]     - User auth info (encryptionKey, etc.)
 *   @param {Object}  [context.fixedParams]  - Pre-configured params for this tool (tier overrides etc)
 *   @param {string}  [context.agentId]      - Agent ID (or null for direct chat)
 *   @param {string}  [context.orgId]        - Organization ID for n8n/org-scoped tools
 *   @param {Function} [context.send]        - SSE send helper (for image gen streaming)
 *   @param {Object}  [context.imageGenSettings] - Image generation settings
 *   @param {Object}  [context.req]          - Express request (for image gen API access)
 *   @param {Array}   [context.attachments]  - File attachments (for n8n)
 *   @param {Function} [context.onImageGenerated] - Callback when image is generated
 *   @param {Object}  [context.runScope]     - { runId, rootRunId } inside an automation
 *                                          run; null in a chat. Lets the upload tools
 *                                          resolve a `generated_file` handle.
 *   @param {Object|false} [context.egress]  - Attribution for the egress row the
 *                                          chokepoint writes when no probe is active:
 *                                          { source, model, isDryRun, ids }. `false`
 *                                          opts a UI-only read out (see toolEgress.js).
 * @returns {Promise<*>} Tool result
 */
async function dispatchTool(toolName, toolArgs, context = {}) {
    // Guard: some providers return tool_calls without a valid function name
    if (!toolName) {
        log.warn('[ToolDispatcher] Skipping tool with undefined name');
        return { error: 'Tool call had no function name — emit a fresh tool_call with the function.name field set, or answer in plain text.' };
    }
    // Media-gen prompt moderation was removed when Azure Content Safety
    // was dropped. The upstream media-gen providers (Azure OpenAI image,
    // FAL, ElevenLabs) still apply their own safety filters.
    const routed = await dispatchToToolFamily(toolName, toolArgs, context);
    if (routed.handled) return routed.result;

    const automationCallCtx = automationCallContext(context);
    const called = await dispatchAgentCallable(toolName, toolArgs, context.userId, automationCallCtx);
    if (called.handled) return called.result;
    const stepped = await dispatchStepTool(toolName, toolArgs, context.userId, automationCallCtx);
    if (stepped.handled) return stepped.result;

    const hint = unloadedGroupHint(toolName);
    if (hint) return hint;

    // ─── Fallback: Component Tools ──────────────────────────────
    return await executeComponentTool(toolName, toolArgs, context.userAuth, context.fixedParams, context.agentId);
}

// ─── Agent-Callable Automations (trigger.kind === 'agent_call') ─
// Named dynamically (toolName or automation_<id>), so no static isXxxTool
// guard can match them. Reachable ONLY through the agent they are bound to
// (the server-built callerAgentId / agentId, never anything the model sent):
// without an agent nothing matches. The call carries who is calling (agent,
// asker, conversation, and the run when an AI step calls it) and
// dispatchAgentCallableTool re-checks the binding itself. A failure of the
// START comes back as `{ error, code }` for the model; only a failed LOOKUP
// falls through to the next matcher.
function automationCallContext(context) {
    return {
        userId: context.userId,
        // The person who asked, not an acting or borrowed integration identity.
        askerUserId: context.askerUserId || null,
        agentId: context.agentId || null,
        callerAgentId: context.callerAgentId || null,
        conversationId: context.conversationId || null,
        // Set by the streaming tool round only: its confirm layer already stood
        // between the model and this call, so a grant on 'ask' may run.
        confirmLayer: context.confirmLayer === true,
        runScope: context.runScope || null,
        // Set inside an automation run that uses its starter's own connections:
        // a nested automation call records that person as its starter.
        connectionsCallerUserId: context.connectionsCallerUserId || null,
    };
}

async function dispatchAgentCallable(toolName, toolArgs, userId, automationCallCtx) {
    if (!userId) return { handled: false };
    return await featureModule('automation/agentCallableTools')
        .dispatchAgentCallableByName(toolName, toolArgs, automationCallCtx);
}

// ─── Reusable Steps (kind='block') exposed as chat tools ────
// Named step_<title>; matched the same dynamic way as agent-callable
// automations and dispatched to runStepAsTool (owner-only, runs as caller).
async function dispatchStepTool(toolName, toolArgs, userId, automationCallCtx) {
    if (!userId) return { handled: false };
    let match = null;
    let tools = null;
    try {
        tools = featureModule('automation/agentCallableTools');
        const stepTools = await tools.getStepToolsForUser(userId);
        match = stepTools.find(t => t?.function?.name === toolName) || null;
    } catch (e) {
        log.warn('[ToolDispatcher] Step tool lookup failed:', e.message);
    }
    if (!match) return { handled: false };
    try {
        return { handled: true, result: await tools.dispatchStepTool(match.__step, toolArgs, automationCallCtx) };
    } catch (e) {
        log.warn(`[ToolDispatcher] Step tool ${match.__step?.id} not started: ${e.message}`);
        return { handled: true, result: require('../automationModel/automationCallDepth').toolErrorFor(e) };
    }
}

// ─── Progressive-disclosure safety net ─────────────────────
// If the name belongs to a heavy integration group but no executor above
// claimed it, the model likely referenced a tool it never loaded. Hand
// back a recoverable hint instead of a confusing "unknown tool" so it can
// self-correct via load_tools. (No-op for the normal Claude path, which
// can only emit tools that were actually sent.)
function unloadedGroupHint(toolName) {
    try {
        const { toolNameToGroupKey } = require('./toolDisclosure');
        const grp = toolNameToGroupKey(toolName);
        if (grp) {
            return { error: `Tool "${toolName}" belongs to the "${grp}" group, which isn't loaded yet. Call load_tools({groups:["${grp}"]}) first, then call this tool.` };
        }
    } catch (err) { bestEffort('core/tools/toolDispatcher:unloadedGroupHint', err); /* non-fatal — fall through to component lookup */ }
    return null;
}

/**
 * The Nextcloud family chain WITHOUT the scope guard, for callers that are
 * not a tool call (the scope picker in routes/ncScope.js). Returns undefined
 * when no family matched. The chain itself lives with the integration
 * (integrations/nextcloudToolFamily.js) and is reached through the registry.
 */
async function executeNextcloudFamilyTool(toolName, toolArgs, userId, session, extra = {}) {
    const family = getToolFamily('nextcloud');
    if (!family?.executeFamily) {
        throw new Error('The Nextcloud tool family is not registered (integrations/toolFamilies.js was not loaded)');
    }
    return await family.executeFamily(toolName, toolArgs, userId, session, extra);
}

// The one entry point: the dispatcher behind the egress chokepoint, which
// writes the ledger row for callers that have no capture context of their own.
const executeTool = createEgressChokepoint(dispatchTool);

module.exports = { executeTool, executeNextcloudFamilyTool };
