/** @typedef {import('../core/agentRuntime/chatStream/turnState').ToolDef} ToolDef */
// @typecheck
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
 * It must not be `permitted || connected`, which is the right answer for a
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
const { fallback } = require('../utils/bestEffort');

/**
 * @param {string} userId
 * @param {Partial<Express.Session> | null} session  Live request session, or the offline session
 *   from automation/triggerBus loadSession() for unattended/MCP callers.
 * @param {{ deps?: Pick<typeof import('../core/integrations/integrationTools'), 'getIntegrationTools' | 'getUserPermittedApps'>
 *   & Partial<Pick<typeof import('../core/integrations/integrationTools'), 'availableMcpServerIds'>> | null }} [opts]
 *   `deps` replaces the resolver (tests). Without `availableMcpServerIds` no MCP server counts as connected.
 */
async function buildCatalogForUser(userId, session, { deps = null } = {}) {
    try {
        const { TOOL_REGISTRY, loadTools } = require('./toolRegistry');
        const { getOutputSchema, OUTPUT_SCHEMAS } = require('./outputSchemas');
        const { isSideEffect, isMemoisable } = require('./sideEffectMap');
        const resolver = deps || require('../core/integrations/integrationTools');
        const { getIntegrationTools, getUserPermittedApps } = resolver;
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
        /** @type {ToolDef[]} */
        let userToolDefs = [];
        try {
            // `automationStep: true` because design time must equal run time: it is
            // what execAi passes when it resolves the same set to authorise a
            // step, and without it a tool the runner will happily execute is
            // missing from the builder (and now, refused by it).
            const r = await getIntegrationTools(/** @type {Parameters<typeof getIntegrationTools>[0]} */ ({ userId, session, isAdmin: !!session?.isAdmin, automationStep: true }));
            userToolDefs = await connectedOnly(Array.isArray(r.tools) ? r.tools : [], userId, resolver.availableMcpServerIds);
            for (const t of userToolDefs) if (t?.function?.name) userToolNames.add(t.function.name);
        } catch (e) {
            const err = new Error(`Could not resolve which integrations you can use: ${/** @type {Error} */ (e).message}`);
            err.code = 'catalog_unresolved';
            throw err;
        }

        let permittedSet = null;
        try {
            permittedSet = await getUserPermittedApps({ userId, session, isAdmin: !!session?.isAdmin });
        } catch (err) { fallback('automation/builderCatalog:permittedApps', err); /* null: permitted follows what is runnable */ }

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
            }).filter((a) => a !== null);
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
        // The runnable tools no registry entry owns — MCP server tools, org
        // custom integrations, agent-callable automations, Step tools and any
        // inline one — as rows of their own after the registry apps, so the
        // model sees every tool it may use and builder_inspect_tool can answer
        // their inputs.
        const registryNames = new Set();
        for (const app of apps) for (const a of app.actions) registryNames.add(a.name);
        /** @type {CatalogApp[]} */ (apps).push(...extraAppRows(userToolDefs, registryNames, { isSideEffect, isMemoisable, getOutputSchema }));
        // `toolNames` stays the raw resolved set and the authority: the add-time
        // gate authorises against THIS, not against `apps`, so a tool is never
        // refused because a row could not be built for it.
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
        log.warn('[builderCatalog] catalog could not be built:', e && /** @type {Error} */ (e).message);
        return { apps: [], triggerOutputs: {}, catalogError: (e && /** @type {Error} */ (e).message) || 'catalog unavailable' };
    }
}

// ── Connected only ────────────────────────────────────────────────────────
// The assistant may use an app only when it is switched on AND connected for
// this user. Registry apps reach the resolved set only with their credentials;
// an MCP server's tools reach it on the org and group grant alone
// (externalToolInjection appendMcpTools checks no credential), so a server the
// user switched on but never gave its credentials would get a row and its
// tools would pass the add-time gate. Its tools are dropped here, before the
// rows and `toolNames` are built from the set. Custom integrations are org-wide
// with no credential per user, and Step tools and agent-callable automations
// are the user's own: they stay.

/**
 * The resolved definitions without the tools of an MCP server this user has
 * not supplied every credential for. An answer we cannot get counts as "not
 * connected" (fail closed: it can only hide a server).
 * @param {ToolDef[]} defs
 * @param {string} userId
 * @param {((names: Set<string>, userId: string) => Promise<Set<string>>) | undefined} availableMcpServerIds
 * @returns {Promise<ToolDef[]>}
 */
async function connectedOnly(defs, userId, availableMcpServerIds) {
    const serverOf = (/** @type {ExtraToolDef} */ def) => def?._mcp?.serverId || null;
    if (!defs.some(serverOf)) return defs;
    /** @type {Set<string>} */
    let connected = new Set();
    try {
        if (typeof availableMcpServerIds === 'function') {
            const names = new Set(defs.map(d => d?.function?.name).filter(/** @returns {n is string} */ n => typeof n === 'string' && !!n));
            connected = await availableMcpServerIds(names, userId);
        }
    } catch (err) { fallback('automation/builderCatalog:connectedMcpServers', err); /* none counts as connected */ }
    return defs.filter(def => { const id = serverOf(def); return !id || connected.has(id); });
}

// ── Rows for the tools TOOL_REGISTRY has no home for ─────────────────────
// Grouped by where the tool comes from, in this order, each group one row:
// one row per MCP server ("MCP · <server>"), then org custom integrations,
// agent-callable automations, Step tools, and whatever else the resolver
// added inline. Ids are stable (`mcp:<serverId>` is the integration id the
// resolver gates on), because the session stores the catalogue ORDER by id
// (rankApps.applyCatalogOrder) and replays it on later turns.
const EXTRA_KIND_ORDER = ['mcp', 'custom', 'automation', 'step', 'other'];

/** @typedef {ToolDef & { _mcp?: { serverId?: string, serverName?: string | null }, _cint?: object, __automation?: object, __step?: object }} ExtraToolDef */

// The groups after MCP, each with the routing metadata that marks it. A custom
// integration's cached definitions may carry no `_cint`; their names always
// start with `cint_`.
/** @type {Array<{ kind: string, id: string, label: string, test: (def: ExtraToolDef, name: string) => boolean }>} */
const EXTRA_GROUPS = [
    { kind: 'custom', id: 'custom-integrations', label: 'Custom integrations', test: (def, name) => !!def._cint || name.startsWith('cint_') },
    { kind: 'automation', id: 'agent-automations', label: 'Agent-callable automations', test: def => !!def.__automation },
    { kind: 'step', id: 'step-tools', label: 'Step tools', test: def => !!def.__step },
];
const OTHER_GROUP = { kind: 'other', id: 'other-tools', label: 'Other tools' };

/**
 * Which group a resolved tool definition belongs to, read from the routing
 * metadata the injectors stamp on it (never sent to a model).
 * @param {ExtraToolDef} def
 * @returns {{ kind: string, id: string, label: string }}
 */
function extraGroupOf(def) {
    const d = def || /** @type {ExtraToolDef} */ ({});
    const mcp = d._mcp || {};
    if (mcp.serverId) return { kind: 'mcp', id: `mcp:${mcp.serverId}`, label: `MCP · ${mcp.serverName || mcp.serverId}` };
    const name = String((d.function && d.function.name) || '');
    const hit = EXTRA_GROUPS.find(g => g.test(d, name));
    return hit ? { kind: hit.kind, id: hit.id, label: hit.label } : { ...OTHER_GROUP };
}

/**
 * Catalog rows for every resolved tool that no registry row carries, with the
 * input schema of the definition itself.
 * @param {ToolDef[]} defs  the resolved definitions (getIntegrationTools)
 * @param {Set<string>} registryNames  the names the registry rows already carry
 * @param {{ isSideEffect: (n: string) => boolean, isMemoisable: (n: string) => boolean, getOutputSchema: (n: string) => CatalogAction['outputSchema'] }} classify
 * @returns {CatalogApp[]}
 */
function extraAppRows(defs, registryNames, { isSideEffect, isMemoisable, getOutputSchema }) {
    /** @type {Map<string, CatalogApp & { kind: string }>} */
    const rows = new Map();
    const seen = new Set(registryNames);
    for (const def of Array.isArray(defs) ? defs : []) {
        const name = def?.function?.name;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const group = extraGroupOf(def);
        let row = rows.get(group.id);
        if (!row) {
            row = { id: group.id, label: group.label, kind: group.kind, available: true, connected: true, permitted: true, actions: [] };
            rows.set(group.id, row);
        }
        const params = def.function?.parameters;
        row.actions.push({
            name,
            description: def.function?.description,
            // Unknown names are side effects (fail closed), as in the runner.
            sideEffect: isSideEffect(name),
            askOnceable: isMemoisable(name),
            outputSchema: getOutputSchema(name),
            inputSchema: params && typeof params === 'object' ? /** @type {CatalogAction['inputSchema']} */ (params) : null,
            outputSample: null,
        });
    }
    const rank = (/** @type {string} */ k) => EXTRA_KIND_ORDER.indexOf(k);
    return [...rows.values()].sort((a, b) => (rank(a.kind) - rank(b.kind)) || a.label.localeCompare(b.label));
}

/**
 * Every input schema the catalog knows, by tool name: what builder_inspect_tool
 * answers and what the inspect-before-bind gate checks. From the rows first
 * (the registry's own `parameters`), then from the resolved definitions for
 * anything a row did not carry. Both come from the RESOLVED set, never the full
 * TOOL_REGISTRY: a schema here must not read as "the user has this tool".
 * @param {BuilderCatalog | null | undefined} catalog
 * @returns {Record<string, NonNullable<CatalogAction['inputSchema']>>}
 */
function inputSchemasByTool(catalog) {
    /** @type {Record<string, NonNullable<CatalogAction['inputSchema']>>} */
    const out = {};
    for (const app of (catalog?.apps || [])) addRowSchemas(out, app?.actions);
    addDefSchemas(out, /** @type {{ toolDefs?: ToolDef[] } | null | undefined} */ (catalog)?.toolDefs);
    return out;
}

/**
 * @param {Record<string, NonNullable<CatalogAction['inputSchema']>>} out
 * @param {CatalogAction[] | undefined} actions
 */
function addRowSchemas(out, actions) {
    for (const act of (actions || [])) {
        if (act && act.name && act.inputSchema) out[act.name] = act.inputSchema;
    }
}

/**
 * @param {Record<string, NonNullable<CatalogAction['inputSchema']>>} out
 * @param {ToolDef[] | undefined} defs
 */
function addDefSchemas(out, defs) {
    for (const def of Array.isArray(defs) ? defs : []) {
        const fn = def && def.function;
        const params = fn && fn.parameters;
        if (fn && fn.name && !out[fn.name] && params && typeof params === 'object') {
            out[fn.name] = /** @type {NonNullable<CatalogAction['inputSchema']>} */ (params);
        }
    }
}

// Far above any real session; a stored list longer than this is not ours.
const INSPECTED_TOOLS_CAP = 500;

/**
 * The tools a builder session already inspected (the stored session's
 * `inspectedTools`), as the per-turn set the inspect-before-bind gate reads.
 * Only names the user can still run survive: marking a tool disarms the gate,
 * and a tool that left the resolved set must meet the full refusal again.
 * Anything unreadable gives an empty set, which is today's per-turn reset.
 * @param {unknown} stored  `snapshot.inspectedTools`
 * @param {Set<string> | null | undefined} available  `catalog.toolNames` (absent: could not tell, keep the names)
 * @returns {Set<string>}
 */
function inspectedToolsFrom(stored, available) {
    /** @type {Set<string>} */
    const out = new Set();
    if (!Array.isArray(stored)) return out;
    for (const name of stored.slice(0, INSPECTED_TOOLS_CAP)) {
        if (typeof name !== 'string' || !name) continue;
        if (available instanceof Set && !available.has(name)) continue;
        out.add(name);
    }
    return out;
}

module.exports = { buildCatalogForUser, inputSchemasByTool, inspectedToolsFrom, _internals: { extraAppRows, extraGroupOf, connectedOnly } };

/**
 * @typedef {{ name: string, description?: string, sideEffect: boolean, askOnceable: boolean,
 *   outputSchema: ReturnType<typeof import('./outputSchemas').getOutputSchema>,
 *   inputSchema: { type?: string, properties?: Record<string, unknown>, required?: string[] } | null,
 *   outputSample: unknown }} CatalogAction
 * @typedef {{ id: string, label: string, available: boolean, connected: boolean, permitted: boolean, actions: CatalogAction[],
 *   kind?: string }} CatalogApp  `kind` is set on the rows of tools no registry entry owns (extraAppRows)
 * `toolNames` is absent when the catalog could not be built (`catalogError` set); `datatables` and
 * `documents` are attached by the callers that need them.
 * @typedef {{ apps: CatalogApp[], toolNames?: Set<string>, triggerOutputs: Record<string, unknown>, catalogError?: string,
 *   datatables?: import('./builderTools/pendingDatatables').DatatableCatalogEntry[] | null,
 *   documents?: Awaited<ReturnType<typeof import('./builderDocumentCatalog').buildDocumentCatalogForUser>> | null }} BuilderCatalog
 */
