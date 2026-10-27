// @typecheck
'use strict';
/**
 * The egress chokepoint around the tool dispatcher.
 *
 * Every integration tool in the product runs through `executeTool`, but only
 * the three chat paths and the automation runner wrapped it in a capture
 * context and wrote an `integration_activity_log` row. Sub-agents, swarms,
 * voice, the /mcp endpoint, the Nextcloud assistant, webpage bridges, App
 * Studio connectors, trigger polls and form pickers dispatched the same tools
 * with no row at all: data left and the ledger said nothing.
 *
 * The rule now, at the one place every call passes:
 *
 *   - a probe is already active   → just run. The caller owns the probe and
 *                                   writes the row (chat, automations, bridges).
 *   - `context.egress === false`  → just run. For UI-only reads (a column
 *                                   picker) that are not a transfer anyone
 *                                   asked for; the call site says why.
 *   - otherwise                   → run inside a probe, then write the row
 *                                   with `context.egress = { source, model,
 *                                   isDryRun, ids }` as its attribution.
 *
 * The tool's own result and throw are passed through untouched; a thrown
 * call still gets its row (status 'error'), because the bytes had left.
 */

const log = require('../../telemetry/log');

function defaultLogToolEgress(o) {
    return require('../integrations/integrationLogging').logToolEgress(o);
}

/**
 * The part of the dispatch context the egress row reads.
 * @typedef {object} ToolEgressContext
 * @property {false | { source?: string, model?: string | null, isDryRun?: boolean, ids?: Record<string, unknown> }} [egress]  `false`: not a transfer anyone asked for
 * @property {string | null} [askerUserId]
 * @property {string | null} [userId]
 * @property {string | null} [orgId]
 * @property {string | null} [agentId]
 * @property {string | null} [conversationId]
 * @property {string | null} [automationId]
 * @property {Express.Session | null} [session]
 */

/**
 * Row ids from the dispatch context, overridden by what the caller states.
 * @param {ToolEgressContext} context
 * @param {Record<string, unknown>} [stated]
 */
function idsFrom(context, stated) {
    const asker = context.askerUserId || context.userId || null;
    const acting = context.askerUserId && context.userId && context.askerUserId !== context.userId
        ? context.userId : null;
    return {
        organization_id: context.orgId || context.session?.user?.organizationId || null,
        user_id: asker,
        agent_id: context.agentId || null,
        conversation_id: context.conversationId || null,
        automation_id: context.automationId || null,
        acting_user_id: acting,
        ...(stated && typeof stated === 'object' ? stated : {}),
    };
}

/**
 * @param {Function} dispatch  (toolName, toolArgs, context) → result
 * @param {{ probeApi?: any, logToolEgress?: Function, now?: () => number }} [deps]      test seam
 * @returns {Function} executeTool with the same signature
 */
function createEgressChokepoint(dispatch, deps = {}) {
    const now = deps.now || Date.now;
    const logRow = deps.logToolEgress || defaultLogToolEgress;
    // Read per call, not at load: tests swap outboundProbe for a stub, and a
    // stub without currentProbe means "capture is not in play here".
    const probeApi = () => deps.probeApi || require('../http/outboundProbe');

    /**
     * @param {string} toolName
     * @param {unknown} toolArgs
     * @param {ToolEgressContext} [context]
     */
    return async function executeTool(toolName, toolArgs, context = {}) {
        const ctx = context || {};
        const api = probeApi();
        if (!toolName || ctx.egress === false
            || typeof api.currentProbe !== 'function' || typeof api.runWithProbe !== 'function'
            || api.currentProbe()) {
            return dispatch(toolName, toolArgs, context);
        }

        const t0 = now();
        const { result: settled, probe } = await api.runWithProbe(async () => {
            try {
                return { ok: true, value: await dispatch(toolName, toolArgs, context) };
            } catch (error) {
                return { ok: false, error };
            }
        });

        try {
            const egress = ctx.egress && typeof ctx.egress === 'object' ? ctx.egress : {};
            logRow({
                toolName,
                toolArgs,
                result: settled.ok ? settled.value : undefined,
                error: settled.ok ? null : settled.error,
                probe: probe || null,
                source: egress.source || 'tool_dispatch',
                model: egress.model || null,
                isDryRun: !!egress.isDryRun,
                durationMs: now() - t0,
                session: ctx.session || null,
                ids: idsFrom(ctx, egress.ids),
            });
        } catch (err) {
            log.warn(`[ToolEgress] egress row for ${toolName} not written: ${err && /** @type {Error} */ (err).message}`);
        }

        if (!settled.ok) throw settled.error;
        return settled.value;
    };
}

module.exports = { createEgressChokepoint, _internals: { idsFrom } };
