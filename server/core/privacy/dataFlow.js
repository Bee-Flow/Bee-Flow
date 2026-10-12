// @typecheck
/**
 * WHERE PERSONAL DATA TRAVELS — asked once, over an automation's steps, in the
 * order they are written, in one vocabulary.
 *
 * The question "does personal data leave through this automation" was answered in
 * two places that could not see each other:
 *
 *   - `playbooks/phases/compliancePhase.js` asked it of an automation a playbook
 *     had just built, from a projection of `{ type, tool }` per step, and
 *     reported the step TYPES that could send.
 *   - the checks under `compliance/checks/gdpr/` asked it of what is already
 *     running — and each one that needed it grew its own half of the answer,
 *     because `playbooks/` and `compliance/` are both FEATURES and one feature
 *     may never require another (ARCHITECTURE.md, layering.test.js).
 *
 * So the shared answer belongs here, in core, exactly where
 * `personalColumns.js` went for the same reason and for the same pair of
 * callers. This module sits beside it and USES it: "which columns hold
 * personal data" is already answered once, and asking it again here would
 * rebuild the drift that file was written to end.
 *
 * WHAT IT ADDS OVER A LIST OF STEP TYPES, and why each one is not cosmetic:
 *
 *   - ORDER. A Privacy Shield is a position, not a property. The review's own
 *     finding is titled "a model reads the data with no privacy check IN FRONT
 *     OF IT", and it was suppressed by `types.some(t => PRIVACY_STEPS.has(t))`
 *     — any shield anywhere, including one placed after the model had already
 *     read the raw rows. An automation could silence the finding by putting the
 *     shield at the end, where it protects nothing.
 *   - THE DESTINATION, not the step type. `integration_action` is the largest
 *     outbound surface the product has and it says nothing at all about where
 *     the data goes; `gmail_compose` and `nextcloud_talk_send_message` are the
 *     same type and two different recipients. Art. 30(1)(d) asks for "the
 *     categories of recipients", and the review's own copy already named its
 *     argument `dests` while being handed step types.
 *   - WHAT IS ACTUALLY TRAVELLING, not only what could. The egress ledger
 *     (`integration_activity_log`) records the PII categories that really left,
 *     per automation and per tool. A definition that COULD send and a ledger that
 *     says it DID are two different claims and this module keeps them apart —
 *     the same way `personalColumns` keeps a name scan apart from a value scan.
 *
 * AND ONE THING IT DELIBERATELY DOES NOT DO: it never upgrades a guess into a
 * finding because the order looked wrong. A definition's `steps` array is the
 * order an automation is written in, which is the order it runs in for a linear
 * automation and only the authoring order for a branched one (the real graph
 * lives in `compliance/aiAct/graph.js`, which is a feature and out of reach
 * from here — and the playbook route sends no edges at all, only
 * `{ type, tool }` per step). So a shield counts as being in front of
 * everything it PRECEDES, and an automation is only reported as unshielded when no
 * shield precedes anything — i.e. when every shield it has is at the end. A
 * review that cries wolf is one people learn to skip, which is the failure
 * mode this whole surface is most vulnerable to.
 *
 * NULL IS NOT ZERO, here as everywhere in this directory. `carries: null`
 * means nobody established what this automation handles; `carries: []` means we
 * looked and it handles no personal data. A flow that reports "nothing
 * personal goes out" precisely when it could not look is the one thing this
 * module must never do.
 *
 * CATEGORIES ARE NEVER RE-SPELLED HERE. Every guard category that arrives —
 * from a ledger string, from a caller, from anywhere — goes through
 * `piiCategories.normalizeCategory` (via `personalColumns.kindOfCategory`).
 * A private snake_case squash of the same ids is what made eighteen of
 * twenty-one categories silently miss, so a column of nothing but telephone
 * numbers read as "no personal data here". There is one spelling of a
 * category in this product and it is not written in this file.
 */

'use strict';

const { decodeCategories } = require('./piiCategories');
const { kindOfCategory, orderKinds } = require('./personalColumns');
// The product's ONE classifier of "does this tool leave the building".
// `effectOf`'s `sends` class is documented there as "a write that leaves the
// building" and the agent confirm policy already hangs on it; a second list
// here would be a second list to drift. The module is a leaf (no requires of
// its own), which is why it can be pulled in from core at all.
const { effectOf } = require('../../automation/sideEffectMap');
// The product's own answer to "which step types call a model", stated once in
// automation/automationGraph.js and read here rather than restated. See
// MODEL_TYPES below for what restating it cost.
const { AI_STEP_TYPES } = require('../../automation/automationGraph');

/**
 * Step types that reach outside the workspace whatever tool they run.
 *
 * `code` is in because its sandbox is handed an HTTPS fetch that can reach any
 * public host. `generate_document` and `presentation` are OUT on purpose: they
 * produce an artefact that stays inside the workspace, and what carries it
 * outside is the step that then mails or shares it — which is caught here
 * anyway. Counting the generation itself would mark every document-producing
 * automation as exporting data.
 */
const OUTBOUND_TYPES = Object.freeze(new Set(['http_request', 'notification', 'code']));

/**
 * Step types where a model reads whatever it was handed — `AI_STEP_TYPES`
 * from automation/automationGraph.js, not a fourth copy of it.
 *
 * The copy this replaces said `['ai_step', 'data_extraction', 'summarize',
 * 'fill_document']`, carried forward from the playbook review's hand-rolled
 * list, and it was wrong in both directions:
 *
 *   - `summarize` is a sum, a count or an average over a collection
 *     (core/automationRunner/execSummarize.js). No model is called. The
 *     comment above AI_STEP_TYPES says so in as many words, CONTRACTS.md says
 *     so, and the Art. 50(2) pass in execDocument.js agrees — so this module
 *     was the one place in the product that called counting rows "handing
 *     data to a model", and every automation that counts a column would have
 *     been told to put a Privacy Shield in front of an arithmetic step.
 *   - `ai_tool` is a model step and was MISSING, which is the expensive
 *     direction: an automation whose model call is an `ai_tool` read as having no
 *     model in it at all.
 *   - `fill_document` fills a template. It is a GENERATING step — what makes
 *     it interesting to the AI Act is that it writes model output to a file,
 *     which `aiAct/signals.generatingStepsDownstreamOfAi` already handles by
 *     asking what feeds it. It does not itself read anything to a model.
 *
 * One list, in one place. A fifth model step type added to automationGraph
 * arrives here by itself.
 */
const MODEL_TYPES = Object.freeze(new Set(AI_STEP_TYPES));

/** The Privacy Shield in its three runtime shapes. */
const SHIELD_TYPES = Object.freeze(new Set(['guard', 'tokenize', 'untokenize']));

/**
 * The one shape that puts real values BACK. It is a shield step (the editor
 * shows it under the shield, and `role` stays 'shield'), but it protects
 * nothing: a reveal in front of a send means the real values travel. The
 * editor's own rule already drops it (complianceRules.js SHIELD_TYPES); the
 * flow reading must agree, or the Art. 30 check calls a re-identifying
 * automation "guarded".
 */
const REVEAL_TYPES = Object.freeze(new Set(['untokenize']));

/** Step types that read or write the workspace's own rows. */
const STORE_TYPES = Object.freeze(new Set(['datatable']));

/** What a step is, for this question. One role per step, strongest first. */
const ROLES = Object.freeze(['shield', 'exit', 'model', 'store', 'step']);

/**
 * What the automation's flow amounts to. Each value is one distinct situation,
 * not a score — the same shape `personalColumns.CONFIDENCE` takes.
 */
const VERDICTS = Object.freeze({
    /** The steps could not be read: no array, or nothing in it. */
    unknown: 'unknown',
    /** Nothing in this automation leaves the workspace. */
    contained: 'contained',
    /** It sends, and nothing personal that we could see is in play. */
    no_personal_data: 'no_personal_data',
    /** It sends personal data, and a Privacy Shield stands in front of it. */
    guarded: 'guarded',
    /** It can send personal data with no shield in front of the exit. */
    unguarded: 'unguarded',
    /** The ledger says personal data really has gone out unshielded. */
    confirmed: 'confirmed',
});

/**
 * Destinations whose bare tool prefix is not a word anybody recognises.
 * Kept short on purpose: an alias table is a second vocabulary, and the only
 * entries that earn a place are the ones where the prefix is meaningless.
 */
const DESTINATION_ALIASES = Object.freeze({ ms: 'microsoft', outlook: 'microsoft' });

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * WHERE a step's data goes, as a word a person recognises.
 *
 * For a connected-app action that is the app, read off the tool name: the
 * product's tool names are `<app>_<verb>` throughout, so `gmail_compose` is
 * Gmail and `nextcloud_share_by_email` is Nextcloud. For the three types that
 * are outbound whatever they run, the destination IS the type: an
 * `http_request` goes to a host the automation names and `code` can reach any
 * public one, and pretending to know more than that would be an invention.
 */
function destinationOf(step) {
    const type = str(step && step.type);
    const tool = str(step && step.tool);
    if (type === 'integration_action' || (!type && tool)) {
        if (!tool) return null;
        const prefix = tool.split('_')[0].toLowerCase();
        return DESTINATION_ALIASES[prefix] || prefix || null;
    }
    if (OUTBOUND_TYPES.has(type)) return type === 'notification' ? 'notification' : (type === 'code' ? 'code' : 'http');
    return null;
}

/**
 * Does THIS step send data out of the workspace?
 *
 * Fail closed on an unnamed tool: a step whose tool we cannot read is not
 * evidence that nothing leaves. The callers send `tool` alongside `type`
 * precisely so this almost never fires — before the playbook route did, EVERY
 * integration_action arrived toolless and the honest answer here would have
 * marked all of them outbound, including plain reads.
 */
function isExit(step) {
    const type = str(step && step.type);
    if (OUTBOUND_TYPES.has(type)) return true;
    if (type !== 'integration_action') return false;
    const tool = str(step && step.tool);
    if (!tool) return true;
    try {
        return effectOf(tool) === 'sends';
    } catch {
        return true;
    }
}

/** One step, in this module's words. `role` is single-valued: a step is one thing. */
function classifyStep(step, index = 0) {
    const type = str(step && step.type);
    const tool = str(step && step.tool) || null;
    const role = SHIELD_TYPES.has(type) ? 'shield'
        : isExit(step) ? 'exit'
            : MODEL_TYPES.has(type) ? 'model'
                : STORE_TYPES.has(type) ? 'store'
                    : 'step';
    return {
        index,
        type: type || null,
        tool,
        role,
        destination: role === 'exit' ? destinationOf(step) : null,
        // Only a `datatable` step carries one, and an `undefined` key would
        // travel into a stored artifact as a key that means nothing.
        ...(STORE_TYPES.has(type) && (step && step.datatableId) ? { datatableId: step.datatableId } : {}),
    };
}

/**
 * Which kinds of personal data a set of detected columns amounts to.
 *
 * `null` in, `null` out: a caller that never established what the automation
 * handles is not a caller that established it handles nothing.
 */
function carriedKinds(personal) {
    if (!Array.isArray(personal)) return null;
    const kinds = [];
    for (const c of personal) {
        if (!c) continue;
        for (const k of arr(c.kinds).length ? arr(c.kinds) : [c.kind]) if (k) kinds.push(k);
    }
    return orderKinds(kinds);
}

/**
 * Guard categories, in ANY spelling any producer has ever written, as our
 * kinds — the wire string from `pii_categories_detected` included.
 *
 * Both hops go through the canonical vocabulary: `decodeCategories` splits and
 * normalises the string, `kindOfCategory` maps the canonical id. Nothing in
 * here lowercases, squashes or re-spells a category, which is the one mistake
 * this side of the product has already made once, expensively.
 */
function kindsCarried(categories) {
    if (categories == null) return null;
    const list = typeof categories === 'string' ? decodeCategories(categories) : arr(categories);
    const kinds = [];
    for (const c of list) {
        const kind = kindOfCategory(c);
        if (kind) kinds.push(kind);
    }
    return orderKinds(kinds);
}

/**
 * The static reading: what the definition says CAN happen.
 *
 * `personal` is what `personalColumns` found in the data this automation works
 * with — an array, or `null` when nobody looked. `steps` is the definition's
 * step list in the order it is written; see the header for why order is read
 * conservatively.
 */
function analyseFlow({ steps = null, personal = null } = {}) {
    const readable = Array.isArray(steps) && steps.length > 0;
    const classified = readable ? steps.map((s, i) => classifyStep(s, i)) : [];
    const shields = classified.filter((s) => s.role === 'shield');
    // "Shielded" means a hiding shield stands EARLIER than it, with no reveal
    // in between. A shield at the end of an automation guards nothing that came
    // before it, and a reveal after it puts the real values back for every step
    // that follows — until the next hiding shield.
    const hiddenAt = [];
    let hidden = false;
    for (const s of classified) {
        hiddenAt[s.index] = hidden;
        if (s.role === 'shield') hidden = !REVEAL_TYPES.has(s.type || '');
    }
    const shielded = (s) => hiddenAt[s.index] === true;
    const mark = (s) => ({ ...s, shielded: shielded(s) });
    const exits = classified.filter((s) => s.role === 'exit').map(mark);
    const models = classified.filter((s) => s.role === 'model').map(mark);
    const stores = classified.filter((s) => s.role === 'store');
    const carries = carriedKinds(personal);
    const unguardedExits = exits.filter((s) => !s.shielded);
    const unguardedModels = models.filter((s) => !s.shielded);

    let verdict;
    if (!readable) verdict = VERDICTS.unknown;
    else if (!exits.length) verdict = VERDICTS.contained;
    else if (carries === null) verdict = VERDICTS.unknown;
    else if (!carries.length) verdict = VERDICTS.no_personal_data;
    else if (!unguardedExits.length) verdict = VERDICTS.guarded;
    else verdict = VERDICTS.unguarded;

    return {
        readable,
        steps: classified,
        shields,
        exits,
        models,
        stores,
        // The step TYPES that send, deduped — the answer the playbook review
        // has always reported, kept under its own name so the two are not
        // confused with each other.
        outboundTypes: [...new Set(exits.map((s) => s.type).filter(Boolean))],
        // The recipients, deduped and sorted: Art. 30(1)(d)'s own question.
        destinations: [...new Set(exits.map((s) => s.destination).filter(Boolean))].sort(),
        carries,
        unguardedExits,
        unguardedModels,
        // An automation that reads personal data into a model with no shield in
        // front of THAT is a different finding from one that mails it out, and
        // they are both worth having.
        modelsUnshielded: unguardedModels.length,
        // Nothing observed yet — `mergeObserved` fills this. Null, not an
        // empty summary: "the ledger was not read" is not "the ledger is empty".
        observed: null,
        verdict,
    };
}

/**
 * What the egress ledger says REALLY left, per tool.
 *
 * Rows are `integration_activity_log` shaped. The projection is an explicit
 * ALLOW-LIST of four fields and that is the point of it (BFSF-441): a ledger
 * row also carries `user_id`, `acting_user_id`, `agent_name`, `data_summary`,
 * `server_ip` and `peer_ip`, and a projection written as "the row minus the
 * fields I do not want" would start leaking each of those the day a column is
 * added — into a compliance evidence record, which is the one place in this
 * product that is designed to be handed to an outsider.
 *
 * → `null` when there is nothing to read from (no rows argument at all), so a
 * ledger that was never consulted does not read as a ledger that is empty.
 *
 * `unscanned_calls` counts the calls of rows marked `scanned: false` — written
 * while the PII scan was off. Their empty category column means "nobody
 * looked", not "nothing personal", so a caller must never read those calls as
 * clean. A row with no `scanned` flag at all is not counted: that is a caller
 * that did not ask, not a ledger that said the scan was off.
 */
const EGRESS_FIELDS = Object.freeze(['tool', 'destination', 'calls', 'kinds']);

function observedEgress(rows) {
    if (!Array.isArray(rows)) return null;
    const byTool = new Map();
    let unscanned = 0;
    for (const r of rows) {
        if (!r) continue;
        const tool = str(r.tool_name || r.tool);
        if (!tool) continue;
        const kinds = kindsCarried(r.pii_categories_detected ?? r.categories ?? null) || [];
        const calls = Number(r.calls);
        if (r.scanned === false) unscanned += (Number.isFinite(calls) && calls > 0 ? calls : 1);
        const prev = byTool.get(tool) || { tool, destination: destinationOf({ type: 'integration_action', tool }), calls: 0, kinds: [] };
        byTool.set(tool, {
            tool: prev.tool,
            destination: prev.destination,
            calls: prev.calls + (Number.isFinite(calls) && calls > 0 ? calls : 1),
            kinds: orderKinds([...prev.kinds, ...kinds]),
        });
    }
    const tools = [...byTool.values()].map((t) => Object.fromEntries(EGRESS_FIELDS.map((f) => [f, t[f]])));
    return {
        tools,
        kinds: orderKinds(tools.flatMap((t) => t.kinds)),
        destinations: [...new Set(tools.map((t) => t.destination).filter(Boolean))].sort(),
        unscanned_calls: unscanned,
    };
}

/**
 * The two readings as one flow — the definition's and the ledger's.
 *
 * The ledger does not outrank the definition, it ANSWERS A DIFFERENT
 * QUESTION, and merging them the other way round is how a real finding gets
 * lost. "It could send personal data" stays true when the ledger is silent
 * (nothing has run yet, or the scan was off), so an empty ledger never turns
 * `unguarded` into `guarded`. What the ledger can do is turn a hypothesis into
 * a fact: personal data that really left through an exit with no shield in
 * front of it is `confirmed`, and that is a stronger statement than any
 * reading of a definition.
 */
function mergeObserved(flow, observed) {
    if (!flow) return flow;
    if (!observed) return { ...flow, observed: null };
    const kindsByTool = new Map(observed.tools.map((t) => [t.tool, t]));
    const exits = flow.exits.map((e) => {
        const seen = e.tool ? kindsByTool.get(e.tool) : null;
        return seen ? { ...e, observedCalls: seen.calls, observedKinds: seen.kinds } : e;
    });
    const leaked = exits.some((e) => !e.shielded && arr(e.observedKinds).length > 0);
    return {
        ...flow,
        exits,
        unguardedExits: exits.filter((e) => !e.shielded),
        observed,
        verdict: leaked ? VERDICTS.confirmed : flow.verdict,
    };
}

/**
 * The record this module hands to a caller that will STORE it — the compliance
 * evidence row, the playbook's artifacts.
 *
 * Built field by field from a named list, never by spreading the flow and
 * deleting what should not travel (BFSF-441). The flow carries whole step
 * objects, and a step object is the automation's own configuration: sooner or
 * later one of them holds a recipient address, a subject line or a bound
 * value. None of that is in this list, and nothing gets in by being added
 * upstream — which is the entire difference between an allow-list and a
 * delete-list.
 */
const FLOW_FIELDS = Object.freeze([
    'verdict', 'destinations', 'carries', 'outbound_types',
    'exits', 'exits_unshielded', 'models', 'models_unshielded',
    'shields', 'steps_total', 'observed_kinds', 'observed_calls',
]);

function flowRecord(flow) {
    if (!flow) return null;
    const observed = flow.observed;
    const record = {
        verdict: flow.verdict,
        destinations: flow.destinations.slice(),
        // `null` survives the projection: it is the difference between "no
        // personal data is in play" and "nobody established what is".
        carries: flow.carries === null ? null : flow.carries.slice(),
        outbound_types: flow.outboundTypes.slice(),
        exits: flow.exits.length,
        exits_unshielded: flow.unguardedExits.length,
        models: flow.models.length,
        models_unshielded: flow.unguardedModels.length,
        shields: flow.shields.length,
        steps_total: flow.steps.length,
        observed_kinds: observed ? observed.kinds.slice() : null,
        observed_calls: observed ? observed.tools.reduce((n, t) => n + t.calls, 0) : null,
    };
    // The allow-list is the contract, so it is applied rather than trusted:
    // a field added to the object above without being named here does not
    // travel, and `dataFlow.test.js` fails so the omission is a decision.
    return Object.fromEntries(FLOW_FIELDS.map((f) => [f, record[f]]));
}

module.exports = {
    analyseFlow, observedEgress, mergeObserved, flowRecord,
    classifyStep, destinationOf, isExit, carriedKinds, kindsCarried,
    OUTBOUND_TYPES, MODEL_TYPES, SHIELD_TYPES, REVEAL_TYPES, STORE_TYPES,
    ROLES, VERDICTS, DESTINATION_ALIASES, FLOW_FIELDS, EGRESS_FIELDS,
};
