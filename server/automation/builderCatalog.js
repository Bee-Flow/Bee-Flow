/**
 * The builder's app/action catalog — "what can this user wire up?".
 *
 * Moved out of routes/ai/automationBuilder.js when the MCP surface
 * (automation/mcpBuilder.js) needed the same answer: `automation/` may not
 * require `routes/` (server/layering.test.js enforces the downward rule), and
 * a second copy of the permission logic is exactly the kind of duplication
 * that drifts until the two surfaces disagree about what a user may use.
 *
 * Two sets, deliberately distinct:
 *
 *   connected — apps the user can invoke RIGHT NOW (OAuth done, API key
 *               configured, group not opted out). Drives the "Connect" badge.
 *   permitted — every app the user is ALLOWED to use under the org / group /
 *               personal-toggle gates, regardless of credentials.
 *
 * ── `available` MEANS RUNNABLE, NOT BROWSABLE ───────────────────────────
 * It used to be `permitted || connected`, which is the right answer for a
 * PALETTE: a person browsing wants to see what exists, and a greyed-out app
 * with a Connect button teaches them something. But the only consumers of this
 * catalog are the AI builder's prompt renderers, which put it in front of a
 * model under the heading "the ONLY tools you may propose" — an
 * AUTHORISATION question, not a discovery one. A person understands a
 * greyed-out row; a model reads a list as a menu.
 *
 * On the account this was found on that read 50 of 50 apps as available with
 * 3 connected — 317 actions advertised, 13 runnable — and a small model duly
 * built a Gmail step for an org with no Gmail. `getUserPermittedApps` says so
 * about itself ("palette is design-time discovery") and fails open by design;
 * routes/automation/catalog.js and routes/agents/toolCatalog.js both carry
 * warnings not to build a catalog from it. This module was the one that did.
 *
 * So `available` now follows the RESOLVED tool set, and `actions` carries only
 * the actions this user can actually run — an app can be connected while only
 * some of its actions are granted, and the model must see the difference.
 * `permitted` stays on the row: it is still the honest answer to "could this
 * user connect it", which is what the add-time refusal uses to say
 * "…is a Gmail action, and Gmail is not connected" instead of "unknown tool".
 *
 * Fails CLOSED, but never SILENTLY: if the resolver cannot answer, we throw
 * rather than return an empty catalog. An empty catalog is indistinguishable
 * from "you have no integrations", and a model told that will either invent a
 * tool or give up — both worse than a turn that fails with a real message.
 */

'use strict';

const log = require('../telemetry/log');

/**
 * @param {string} userId
 * @param {object|null} session  Live request session, or the offline session
 *   from automation/triggerBus loadSession() for unattended/MCP callers.
 */
async function buildCatalogForUser(userId, session) {
    try {
        const { TOOL_REGISTRY, loadTools } = require('./toolRegistry');
        const { getOutputSchema, OUTPUT_SCHEMAS } = require('./outputSchemas');
        const { isSideEffect, isMemoisable } = require('./sideEffectMap');
        const { getIntegrationTools, getUserPermittedApps } = require('../core/integrations/integrationTools');
        const { buildTriggerOutputsCatalog } = require('./builderTools');

        // The authoritative per-user answer: org ∩ group ∩ toggle ∩ entitlement
        // ∩ CREDENTIALS, plus the four classes no static registry can know
        // (MCP servers, org custom integrations, agent-callable automations, Step
        // tools). A failure here is not "the user has nothing" — it is "we do
        // not know", and the two must not look the same to the model.
        const userToolNames = new Set();
        // The resolved tool DEFINITIONS, kept beside the names for the
        // auto-derived app_event providers (builderPickerCatalog.js). Attached
        // below as a non-enumerable property: only that one reader wants them.
        let userToolDefs = [];
        try {
            // `automationStep: true` because design time must equal run time: it is
            // what execAi passes when it resolves the same set to authorise a
            // step, and without it a tool the runner will happily execute is
            // missing from the builder (and now, refused by it).
            const r = await getIntegrationTools({ userId, session, isAdmin: !!session?.isAdmin, automationStep: true });
            userToolDefs = Array.isArray(r.tools) ? r.tools : [];
            for (const t of userToolDefs) if (t?.function?.name) userToolNames.add(t.function.name);
        } catch (e) {
            const err = new Error(`Could not resolve which integrations you can use: ${e.message}`);
            err.code = 'catalog_unresolved';
            throw err;
        }

        let permittedSet = null;
        try {
            permittedSet = await getUserPermittedApps({ userId, session, isAdmin: !!session?.isAdmin });
        } catch (_) { /* null → fail closed below */ }

        const apps = TOOL_REGISTRY.map(entry => {
            const tools = loadTools(entry);
            const actions = tools.map(t => {
                const name = t?.function?.name;
                if (!name) return null;
                // inputSchema is the OpenAI-format `parameters` block already attached
                // to every tool entry — surface it so the client mapping UI can render
                // typed fields instead of generic key+value rows.
                // outputSample comes from outputSchemas.js so the VariableTree can
                // show realistic placeholder values without needing a dry-run.
                const sch = OUTPUT_SCHEMAS[name] || null;
                return {
                    name,
                    description: t.function?.description,
                    sideEffect: isSideEffect(name),
                    // May this action's answer be reused within one run? The
                    // settings panel disables its "ask only once" toggle on
                    // this, so it MUST be the same predicate the runner gates
                    // on — a UI that offers the toggle where execAi silently
                    // ignores it is worse than no toggle at all.
                    askOnceable: isMemoisable(name),
                    outputSchema: getOutputSchema(name),
                    inputSchema: t.function?.parameters || null,
                    outputSample: sch?.sample || null,
                };
            }).filter(Boolean);
            // Only the actions this user can actually run. An app can be
            // connected while a subset of its actions is granted (group
            // opt-outs, entitlement tiers), and advertising the rest is the
            // same lie one level down.
            const runnable = actions.filter(a => userToolNames.has(a.name));
            const connected = runnable.length > 0;
            // getUserPermittedApps no longer throws for an automation config-lookup
            // hiccup, so `permittedSet === null` should only happen on a
            // genuinely unexpected error; failing closed here is the safe
            // default for that case.
            const permitted = permittedSet ? permittedSet.has(entry.app) : connected;
            return {
                id: entry.app,
                label: entry.label,
                // Runnable, not browsable — see the header.
                available: connected,
                connected,
                permitted,
                actions: runnable,
            };
        });
        // `toolNames` is deliberately WIDER than anything in `apps`: it is the
        // raw resolved set, so it carries the four classes no registry entry
        // owns — MCP server tools, org custom integrations, agent-callable
        // automations and Step tools — plus inline ones like browse_web. The
        // add-time gate must authorise against THIS, not against `apps`, or it
        // would refuse a tool the user genuinely has purely because
        // TOOL_REGISTRY has no home for it.
        const result = { apps, toolNames: userToolNames, triggerOutputs: buildTriggerOutputsCatalog() };
        Object.defineProperty(result, 'toolDefs', { value: userToolDefs, enumerable: false });
        return result;
    } catch (e) {
        // A resolver failure must reach the caller: returning an empty catalog
        // here is what made "we could not tell" look like "you have nothing".
        if (e && e.code === 'catalog_unresolved') throw e;
        // The same sentence for the one failure that does NOT throw (the
        // registry itself would not load): the catalog is empty because we
        // could not read it, and the prompt must not say "no integrations
        // connected". `catalogError` is the marker the renderers look for;
        // `toolNames` stays absent, so the add-time gate stays permissive.
        log.warn('[builderCatalog] catalog could not be built:', e && e.message);
        return { apps: [], triggerOutputs: {}, catalogError: (e && e.message) || 'catalog unavailable' };
    }
}

module.exports = { buildCatalogForUser };
