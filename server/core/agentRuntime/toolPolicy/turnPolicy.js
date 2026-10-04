/**
 * THE PER-TURN POLICY the round executor enforces, and the fail-closed version
 * of it.
 *
 * `buildToolPolicy` turns an assembled stack into the two answers that must
 * stay apart — `confirmByTool` (would a person have to say yes?) and
 * `gatedTools` (must the runtime hold this call back?) — plus the name gate.
 * `fallbackToolPolicy` is what a round runs on when building that threw: a
 * build failure may not quietly become a grant.
 */

'use strict';

const { effectOf } = require('../../../automation/sideEffectMap');
const { toolsConfigOf, CONFIRM_MODES } = require('./configShape');
const { hasCuratedGrants } = require('./grantResolution');
const { confirmForTool } = require('./confirmation');

/**
 * Turn an assembled tool stack into the per-turn policy the round executor
 * enforces.
 *
 * Two different questions come back, and keeping them apart is the whole
 * point (see the module header):
 *   `confirmByTool`  — the verdict: would a person have to say yes?
 *   `gatedTools`     — the action: must the runtime HOLD this call back?
 *
 * A tool is gated when its confirmation is something someone actually chose:
 * an explicit per-automation override, or an `ask` on an agent that carries a
 * stored `tools` map. An agent without that map gets an EMPTY `gatedTools`,
 * so every one of its calls dispatches exactly as it does today — draft cards
 * and all.
 *
 * @param {object} opts
 * @param {object} opts.agentConfig     the RUNTIME agent config
 * @param {Array}  opts.tools           the assembled tool definitions
 * @param {boolean} [opts.unattended]   nobody is watching this run
 * @param {object} [opts.automationConfirms]  toolName → 'direct'|'ask' for
 *   granted automations (their effect comes from the definition, not the name)
 * @returns {{allowedToolNames: Set<string>, confirmByTool: Map<string,string>,
 *            effectByTool: Map<string,string>, gatedTools: Set<string>,
 *            enforceNames: boolean, unattended: boolean,
 *            droppedForUnattended: string[]}}
 */
function buildToolPolicy({ agentConfig, tools, unattended = false, automationConfirms = null }) {
    const toolsConfig = toolsConfigOf(agentConfig);
    // A CURATED map is the opt-in: an agent saved through the picker has one,
    // an agent from before this feature does not — and an empty or junk-only
    // map is neither (see hasCuratedGrants; it is what a malformed `tools`
    // value leaves behind, and it must not opt an agent in by accident).
    const hasStoredGrants = hasCuratedGrants(toolsConfig);
    const allowedToolNames = new Set();
    const confirmByTool = new Map();
    const effectByTool = new Map();
    const gatedTools = new Set();
    const droppedForUnattended = [];
    let sawOverride = false;

    for (const t of tools || []) {
        const name = t && t.function && t.function.name;
        if (typeof name !== 'string' || !name) continue;
        const overrideConfirm = automationConfirms && automationConfirms.get
            ? automationConfirms.get(name) : (automationConfirms || {})[name];
        const hasOverride = CONFIRM_MODES.includes(overrideConfirm);
        // Set BEFORE the unattended drop below: the tool that is withheld is
        // precisely the one whose name must not then sail through gate 1 into
        // the dispatcher's own automation lookup.
        if (hasOverride) sawOverride = true;
        // Een override mag VERSMALLEN, nooit verbreden: de sends-regel is de
        // bodem. Een automatisering die verstuurt blijft 'ask', ook als de opgeslagen
        // grant 'direct' zegt — anders zet één veld in de kiezer de hele
        // bevestigingsplicht op verzendende automations uit.
        const baseConfirm = confirmForTool(name, toolsConfig);
        const confirm = (hasOverride && !(baseConfirm === 'ask' && overrideConfirm === 'direct'))
            ? overrideConfirm
            : baseConfirm;
        const effect = (automationConfirms && (overrideConfirm !== undefined))
            ? (confirm === 'ask' ? 'writes' : 'reads')
            : effectOf(name);
        // A granted automation carries its own confirm straight from its
        // definition, so it is chosen policy even on an agent whose app map is
        // still empty.
        const gated = confirm === 'ask' && (hasStoredGrants || hasOverride);
        // R2's rule: with nobody present there is no one to answer a
        // confirmation, so a tool that would ask is left OUT of the stack
        // rather than run unapproved or park forever. Only GATED tools —
        // otherwise a mailing automation would lose the very tool `autoSend`
        // exists to let it use.
        if (unattended && gated) { droppedForUnattended.push(name); continue; }
        allowedToolNames.add(name);
        confirmByTool.set(name, confirm);
        effectByTool.set(name, effect);
        if (gated) gatedTools.add(name);
    }

    return {
        allowedToolNames, confirmByTool, effectByTool, gatedTools,
        // Gate 1 lives inside the same opt-in fence as the hold-back — see
        // `decideToolCall`. An agent nobody curated keeps the pre-A1b
        // behaviour for a name outside the stack: it falls through to the
        // dispatcher, which has its own handling for one (an agent-callable
        // automation of the caller, a progressive-disclosure hint, a component
        // tool). Refusing it there was a behaviour change nobody opted into.
        enforceNames: hasStoredGrants || sawOverride,
        unattended: !!unattended, droppedForUnattended,
    };
}

/**
 * The policy to run a round on when `buildToolPolicy` itself threw.
 *
 * A build failure may not quietly become a grant. Gate 1 survives unchanged —
 * `allowedToolNames` is exactly the stack that was offered — but the confirm
 * layer is REBUILT name by name instead of being dropped. An empty
 * `gatedTools` on an agent whose owner has curated a `tools` map means a tool
 * that owner put on `ask` is dispatched with no card at all, and in an
 * unattended run (where toolStackAssembly's own catch has left those tools in
 * the stack on the very same failure) that is a send going out unapproved.
 * "I could not read the confirm policy" is not a yes.
 *
 * A name whose confirmation cannot be classified at all is gated rather than
 * run. Gated tools are HELD here even headless rather than refused: nothing
 * dispatches either way, and a hold says what actually happened ("waiting for
 * approval", then the turn wraps up) where a refusal would tell the model a
 * tool it was just handed does not exist.
 *
 * An explicit per-automation `confirm` is honoured here as well: it comes from
 * the automation's own definition, so it is a choice someone made rather than a
 * legacy default, and it gates on an agent with no app map at all.
 *
 * An agent with NO curated map keeps the empty `gatedTools` it has today.
 * That is not a decision being lost, it is the absence of one: gating there
 * would take the draft cards away from every agent that predates the picker
 * and stop every mailing automation dead — the same reason `buildToolPolicy`
 * hangs the hold-back on `hasCuratedGrants`.
 *
 * Never throws: it is the handler for something that already threw.
 */
function fallbackToolPolicy({ agentConfig, tools, unattended = false, automationConfirms = null }) {
    const allowedToolNames = new Set();
    const confirmByTool = new Map();
    const effectByTool = new Map();
    const gatedTools = new Set();

    let toolsConfig = null;
    let curated = false;
    let unreadable = false;
    let sawOverride = false;
    try {
        toolsConfig = toolsConfigOf(agentConfig);
        curated = hasCuratedGrants(toolsConfig);
    } catch (_) {
        // Even reading the map failed. Only a map that is THERE can carry a
        // decision, so fall back on its bare presence — the wider reading, on
        // the side that holds calls back rather than the side that runs them.
        // And if the config will not even answer THAT (a throwing getter, an
        // exotic proxy), treat it as curated: an agent nobody can read the
        // grants of is the last one to run a send unasked.
        toolsConfig = null;
        unreadable = true;
        try { curated = !!(agentConfig && agentConfig.tools); } catch (_e) { curated = true; }
    }
    // With the map readable the fallback must reach the SAME verdict the
    // healthy path would — `direct` for a write the owner never put on `ask`,
    // or the fallback starts holding calls nobody asked to hold. It is only
    // when the map itself could not be read that the default flips: there the
    // owner's choice is missing rather than absent, and a missing choice is
    // not permission.
    const confirmOpts = unreadable ? { legacyDefault: 'ask' } : undefined;

    for (const t of tools || []) {
        const name = t && t.function && t.function.name;
        if (typeof name !== 'string' || !name) continue;
        allowedToolNames.add(name);

        // A granted automation carries its own confirm straight from its
        // definition, so it is chosen policy even on an agent whose app map is
        // empty — the same rule `buildToolPolicy` applies. Mirrored here so the
        // fallback cannot quietly implement half of it.
        let override;
        try {
            override = automationConfirms && automationConfirms.get
                ? automationConfirms.get(name) : (automationConfirms || {})[name];
        } catch (_) { override = undefined; }
        if (CONFIRM_MODES.includes(override)) {
            sawOverride = true;
            confirmByTool.set(name, override);
            effectByTool.set(name, override === 'ask' ? 'writes' : 'reads');
            if (override === 'ask') gatedTools.add(name);
            continue;
        }

        if (!curated) continue;                 // legacy agent: today's behaviour
        let confirm = 'ask';                    // unclassifiable ⇒ not a yes
        let effect = 'writes';
        try {
            effect = effectOf(name) || 'writes';
            confirm = confirmForTool(name, toolsConfig, confirmOpts);
        } catch (_) { /* keep the fail-closed pair above */ }
        confirmByTool.set(name, confirm);
        effectByTool.set(name, effect);
        if (confirm === 'ask') gatedTools.add(name);
    }

    return {
        allowedToolNames, confirmByTool, effectByTool, gatedTools,
        // Same fence as the healthy path — and `curated` is already the wide
        // reading here (a map that is merely THERE counts, an unreadable
        // config counts), so a failure never opens gate 1 for an agent that
        // has one.
        enforceNames: curated || sawOverride,
        unattended: !!unattended, droppedForUnattended: [],
    };
}

module.exports = { buildToolPolicy, fallbackToolPolicy };
