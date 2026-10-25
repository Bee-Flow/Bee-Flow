// @typecheck
/**
 * The deduction behind an agent-driven AI step's toolstack: which tools may
 * run with no human present (withholdConfirmTools), plus the small readers of
 * a tool definition it needs. Extracted from ./aiStepAgent.js, which re-exports
 * the public names; the module header there explains why an unattended step
 * gets a narrower toolbelt than the same agent in chat.
 */

'use strict';

const toolPolicy = require('../agentRuntime/toolPolicy');
// The tool registry is automation/'s, reached through ./featurePorts.js.
const { runnerPort } = require('./featurePorts');
const log = require('../../telemetry/log');

/** Does this tool carry its own identity, outside the tool registry? */
function _carriesOwnIdentity(tool) {
    if (!tool || typeof tool !== 'object') return false;
    if (tool.__automation && tool.__automation.id) return true;
    if (tool.__step && tool.__step.id) return true;
    if (tool._mcp && tool._mcp.serverId) return true;
    if (tool._custom && (tool._custom.integrationId || tool._custom.id)) return true;
    return false;
}

/** Does this tool start an automation (an agent-callable automation or a Step)? */
function _startsAutomation(tool) {
    return !!_automationIdOf(tool);
}

/**
 * The automation id behind this tool, or null.
 *
 * Two shapes, one answer: an agent-callable automation carries
 * `__automation.id`, a reusable Step `__step.id`. Both are rows of
 * `automations`, so both can be held against the agent owner's
 * `tools.automations` grants — and that is exactly what `getIntegrationTools`
 * does NOT do for the second shape.
 */
function _automationIdOf(tool) {
    if (!tool || typeof tool !== 'object') return null;
    const auto = tool.__automation && tool.__automation.id;
    if (typeof auto === 'string' && auto) return auto;
    const step = tool.__step && tool.__step.id;
    if (typeof step === 'string' && step) return step;
    return null;
}

function _toolName(tool) {
    const name = tool && tool.function && tool.function.name;
    return (typeof name === 'string' && name) ? name : null;
}

/**
 * The apps the REGISTRY says do not belong in an agent context.
 *
 * `availableTo` is the declaration (`automation/toolRegistry.js`); anything
 * without 'agent' in it is an app the agent picker could never show, so an
 * app no agent owner could ever have written anything down about.
 * `toolPolicy` reads that silence as the no-migration rule ("the owner saw it
 * and left it on"), and here that is false: nobody was asked.
 *
 * Memoised because the declaration is fixed per process. A registry that
 * cannot be read yields an EMPTY set and so no refusal — but that costs
 * nothing: with attribution broken, step 1 of the deduction already refuses
 * every registry tool, and these tools are not even built (`automationStep`
 * is off).
 */
let _nonAgentApps = null;
function _appsOutsideAgentContext() {
    if (_nonAgentApps) return _nonAgentApps;
    const out = new Set();
    try {
        const registry = runnerPort('toolRegistry');
        // `availabilityFor` is the shared reader; the row itself is the source.
        // A registry without that function is read on `availableTo`, because
        // the DECLARATION is what counts and a missing helper is not a missing
        // declaration. A row that declares nothing is available in both
        // contexts (DEFAULT_AVAILABILITY) and so does not belong here.
        const read = typeof registry.availabilityFor === 'function'
            ? (e) => registry.availabilityFor(e)
            : (e) => (Array.isArray(e.availableTo) ? e.availableTo : null);
        for (const entry of registry.allToolApps() || []) {
            if (!entry || !entry.app) continue;
            const contexts = read(entry);
            if (Array.isArray(contexts) && !contexts.includes('agent')) out.add(entry.app);
        }
    } catch (e) {
        log.warn('[AutomationRunner] tool registry unreadable while checking agent context:', e && e.message);
    }
    _nonAgentApps = out;
    return out;
}

/** Test seam: forget the memoised registry declaration. */
function _resetAgentContextApps() { _nonAgentApps = null; }

/** Does this tool belong to an app that only exists outside an agent context? */
function _outsideAgentContext(tool) {
    const apps = _appsOutsideAgentContext();
    if (apps.size === 0) return false;
    let appId = null;
    try { appId = toolPolicy.appIdForToolDef(tool); } catch (_) { return false; }
    return !!appId && apps.has(appId);
}

/**
 * A STORED `confirm: 'ask'` on this tool's app, read on the DEFINITION.
 *
 * `confirmForTool` — and with it `buildToolPolicy` — attributes on the NAME
 * (`appIdForTool`). An MCP tool and an org custom-integration tool are in no
 * registry, so that name yields `appId = null` and the function falls through
 * to `legacyDefault: 'direct'`. Meanwhile `normaliseToolsConfig` keeps the
 * `confirm: 'ask'` on `mcp:<serverId>` / `custom:<id>` in the row: a stored,
 * read-back and nowhere-enforced decision — exactly what the module header of
 * `toolPolicy` forbids, and on an unattended surface a sending tool nobody
 * stops.
 *
 * `isToolAllowed` already solves this on the `actions` side by looking at the
 * DEFINITION (`appIdForToolDef`); this is the same reading for the `confirm`
 * side. Only NARROWS: a stored `direct` changes nothing here, because it
 * cannot widen the floor rules of `buildToolPolicy` (sends ⇒ ask).
 *
 * The real fix belongs in `toolPolicy.confirmForTool` itself — that module is
 * outside this fence, so the deduction stays here for now.
 */
function _storedConfirmAsk(tool, toolsConfig) {
    if (!toolsConfig) return false;
    let appId = null;
    try { appId = toolPolicy.appIdForToolDef(tool); } catch (_) { return false; }
    if (!appId) return false;
    const entry = toolsConfig[appId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return entry.confirm === 'ask';
}

/**
 * Did this agent's owner touch the automation list?
 *
 * The PRESENCE of the key is the choice, not its contents — the same reading
 * as `_curatedAutomations` in `core/integrations/integrationTools.js`. An
 * empty section means "I unticked every automation".
 */
function _curatedAutomations(toolsConfig) {
    return !!(toolsConfig && Object.prototype.hasOwnProperty.call(toolsConfig, 'automations'));
}

/** The three reasons that travel outward. Vaguer is allowed, wider never. */
const WITHHOLD_REASONS = Object.freeze(['permission', 'confirm', 'unavailable']);

/**
 * Step 0 — apps that do not exist in an agent context. See
 * `_appsOutsideAgentContext`: no agent owner was ever asked about these apps,
 * so their silence is not a yes.
 */
function _dropOutsideAgentContext(list, drop) {
    const candidates = [];
    for (const t of list) {
        if (_outsideAgentContext(t)) drop(_toolName(t), 'unavailable');
        else candidates.push(t);
    }
    return candidates;
}

/**
 * Step 1 — attribution. A registry that cannot be read cannot say which app
 * owns a name, and the answer to an unanswerable question is not "all of
 * them". Only tools that carry their own identity stay.
 */
function _dropUnattributable(candidates, drop) {
    let degraded = false;
    try {
        degraded = toolPolicy.isAttributionAvailable() !== true;
    } catch (_) {
        degraded = true;               // cannot even ask ⇒ treat as degraded
    }
    if (!degraded) return { candidates, degraded };
    const own = [];
    for (const t of candidates) {
        if (_carriesOwnIdentity(t)) own.push(t);
        else drop(_toolName(t), 'unavailable');
    }
    return { candidates: own, degraded };
}

/**
 * Step 2 — the per-action grants, once more. `getIntegrationTools` already
 * applies them when it builds the catalog, but it does so in a `try` that, on
 * an unreachable policy module, carries on WITHOUT grants ("per-action grants
 * not applied"). That is a deliberate choice there, for chat; here it would
 * mean an unattended step gets the full toolbelt on the strength of a require
 * that threw. The same function, on the DEFINITION (so MCP and custom tools
 * are attributed on their own id), and it can only narrow.
 */
function _dropUngranted(candidates, toolsConfig, drop) {
    if (!toolsConfig) return candidates;
    const granted = [];
    const curated = _curatedAutomations(toolsConfig);
    let grants = null;
    if (curated) {
        try { grants = toolPolicy.automationGrantsOf(toolsConfig); } catch (_) { grants = null; }
        // Unreadable grants next to a section that DOES exist: the owner made
        // a choice and we cannot read it. Then no automations — the same
        // exit integrationTools takes.
        if (!grants) grants = {};
    }
    for (const t of candidates) {
        let ok = false;
        try { ok = toolPolicy.isToolAllowed(t, toolsConfig) === true; } catch (_) { ok = false; }
        // The automation intersection, for reusable Steps too. `addTools` —
        // and with it `isToolAllowed` — never touches those tools: they are
        // pushed straight onto the list in `getIntegrationTools`. Without this,
        // "all automations unticked" would still yield every published Step of
        // the automation owner.
        if (ok && curated) {
            const autoId = _automationIdOf(t);
            if (autoId && !Object.prototype.hasOwnProperty.call(grants, autoId)) ok = false;
        }
        if (ok) granted.push(t);
        else drop(_toolName(t), 'unavailable');
    }
    return granted;
}

/**
 * The deduction: keep only the tools that may run without a human present.
 *
 * Pure — no I/O, no catalog — so every branch can be tested on its own.
 * Returns the withheld names instead of letting them vanish: that is what the
 * step editor can show ("want this anyway? put an approval step after it")
 * and what ends up in the run log.
 *
 * Every name comes with a REASON, and it travels along instead of being
 * derived again on the other side. A name that falls here on the grants and
 * is judged again over there with `confirmForTool` gets 'ask' as soon as it
 * sends — after which the screen recommends an approval step that changes
 * nothing. Only the place that removed the tool knows WHY.
 *
 * @returns {{tools: Array, withheld: string[], reasons: Object<string,string>,
 *            degraded: boolean, policyError: string|null}}
 */
function withholdConfirmTools(tools, agentConfig) {
    const list = [];
    for (const t of Array.isArray(tools) ? tools : []) {
        if (_toolName(t)) list.push(t);
    }
    const withheld = [];
    const reasons = {};
    // The first reason wins: it names the first obstacle, not a later one.
    const drop = (name, reason) => {
        if (!name) return;
        if (!(name in reasons)) reasons[name] = WITHHOLD_REASONS.includes(reason) ? reason : 'unavailable';
        withheld.push(name);
    };

    const attributed = _dropUnattributable(_dropOutsideAgentContext(list, drop), drop);
    const degraded = attributed.degraded;
    let toolsConfig = null;
    try {
        toolsConfig = toolPolicy.toolsConfigOf(agentConfig);
    } catch (_) { toolsConfig = null; }
    const candidates = _dropUngranted(attributed.candidates, toolsConfig, drop);

    // Step 3 — the confirmation question, with chat's function.
    // `unattended: true` already takes the gated tools out of `confirmByTool`;
    // the ungated `ask` (a `sends` tool on an agent nobody curated) is still
    // in it, with the value 'ask'. One keep-rule therefore covers both: only
    // an explicit 'direct' stays.
    let confirmByTool = null;
    let policyError = null;
    try {
        const automationConfirms = toolPolicy.automationConfirmsFor(candidates, agentConfig);
        const policy = toolPolicy.buildToolPolicy({
            agentConfig,
            tools: candidates,
            unattended: true,
            automationConfirms,
        });
        confirmByTool = policy && policy.confirmByTool;
    } catch (e) {
        policyError = e && e.message ? e.message : 'tool policy unavailable';
    }
    if (!(confirmByTool instanceof Map)) {
        // No readable verdict ⇒ no tools. A policy that cannot be built is not
        // a grant, and the step simply runs on as a text step.
        for (const t of candidates) drop(_toolName(t), 'unavailable');
        return { tools: [], withheld, reasons, degraded, policyError: policyError || 'tool policy produced no verdict' };
    }

    const kept = [];
    for (const t of candidates) {
        const name = _toolName(t);
        // `_storedConfirmAsk` is the second reading `confirmForTool` cannot
        // do: an MCP server or an org custom integration is not attributed on
        // the NAME, so the owner's stored `ask` never reaches `confirmByTool`.
        // Only narrowing.
        if (confirmByTool.get(name) === 'direct' && !_storedConfirmAsk(t, toolsConfig)) kept.push(t);
        else drop(name, 'confirm');
    }
    return { tools: kept, withheld, reasons, degraded, policyError };
}

module.exports = {
    WITHHOLD_REASONS,
    withholdConfirmTools,
    _resetAgentContextApps,
    _startsAutomation,
    _toolName,
};

/**
 * A tool definition as this deduction reads it.
 * @typedef {import('../agentRuntime/toolPolicy/appIndex').ToolDef & { __automation?: { id?: string }, __step?: { id?: string } }} WithholdTool
 */

/** @typedef {import('../agentRuntime/toolPolicy/configShape').ToolsConfig} ToolsConfig */
