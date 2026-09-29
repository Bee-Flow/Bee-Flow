/**
 * Custom-node contract helpers.
 *
 * A custom node is a Step (kind='block' — see stepContract.js) with two
 * things a plain Step does not have: a BODY, one `code` step the author
 * wrote, and a CAPABILITY MANIFEST, `definition.capabilities`, naming
 * everything that body may reach outside the isolate.
 *
 * WHY THE MANIFEST HAS TO EXIST. A Step's reach is readable from its graph:
 * stepContract.requiredIntegrations() walks its integration_action steps, and
 * the palette hides the Step when the caller lacks one of those integrations.
 * A code body has no integration_action steps — it reaches Gmail through
 * `ctx.integrations.gmail_send(...)`, a tool name inside a string inside a
 * string — so that walk returns [] and the palette would offer the node to
 * everyone. Declaring the reach is the only way to answer "may this caller
 * use this node" before it runs. It is not a second, weaker copy of the run
 * time check: codeSandbox gates exactly these names through
 * `bridges.allowedTools`, so the manifest is a promise the sandbox keeps.
 *
 * WHY OUTPUTS ARE REQUIRED HERE while validate/graph.js only warns.
 * `layer.no_output` is a warning because a layer without one still runs and
 * hands back its last step's raw output. A custom node is picked from a
 * palette and bound to BY FIELD NAME: with nothing declared the binding
 * picker has no rows to show, every `steps.<id>.output.<field>` downstream
 * resolves to undefined, and the routine saves, runs green and writes
 * nothing. That is the "looks like it saved, saved nothing" failure this
 * product has shipped three times, and a node is a contract with the graph
 * around it — so the contract is not optional.
 *
 * Intentionally dependency-light, like stepContract.js and
 * appTriggerContract.js: pure functions, no I/O, safe to require from stores
 * and routes. codeSandbox is required LAZILY and only inside
 * validateCustomNode, because it pulls in the isolated-vm native module and
 * nothing else here needs it.
 */

'use strict';

const { stepParams, stepOutputFields, walkSteps } = require('./stepContract');

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * The capability vocabulary — one entry per outward surface the sandbox
 * actually gates, spelled the way codeSandbox gates it, and mapped to the
 * bridge that does the gating:
 *
 *   tool:<name>  ctx.integrations.<name>(args)  → bridges.executeTool, refused
 *                                                 unless <name> is in
 *                                                 bridges.allowedTools
 *   http         ctx.http(url, opts)            → bridges.fetchHttp
 *   db           ctx.db.query/exec/batch        → bridges.db
 *   secrets      ctx.secrets(name)              → no bridge at all; throws
 *
 * The mapping is the point, not decoration: a word that names no bridge names
 * nothing anyone enforces, and a manifest of such words is a promise with no
 * keeper. customNode.test.js pins this table against the bridges codeSandbox
 * really builds, so a fifth outward surface cannot be added there and quietly
 * stay undeclarable here.
 */
const CAPABILITY_BRIDGES = Object.freeze({
    tool: 'executeTool',
    http: 'fetchHttp',
    db: 'db',
    secrets: null,
});

const CAPABILITY_KINDS = Object.freeze(Object.keys(CAPABILITY_BRIDGES));

/**
 * The two a custom node can actually be given.
 *
 * A custom node's body runs from the automation runner (execCode in
 * core/automationRunner/execOutbound.js), and that call site builds exactly
 * two outward bridges: executeTool and fetchHttp.
 *
 * `db` is a real capability with one other owner — integrations/
 * webpageApiRuntime.js hands the sandbox a per-page SQLite bridge. The
 * automation runner passes none, and the sandbox only BUILDS `ctx.db` when a
 * db bridge is present, so a body that declares `db` and calls it dies on
 * "Cannot read properties of undefined" partway through a live run, after
 * whatever it already did. `secrets` is refused by the sandbox for every
 * caller — see the codeSandbox header for why that is a throw and not a null.
 *
 * Both stay IN the vocabulary rather than being left out of it: a node that
 * declares one should be told why it cannot have it, not told that the thing
 * it named does not exist.
 */
const GRANTABLE_CAPABILITY_KINDS = Object.freeze(['tool', 'http']);

// Tool names as the catalog spells them (gmail_send, nextcloud_list_files).
// Bounded because the manifest is stored, shipped and shown.
const TOOL_CAPABILITY_RE = /^tool:([A-Za-z0-9][A-Za-z0-9_.-]{0,79})$/;

/**
 * One manifest entry → { kind, tool } , or null when it is not a capability.
 *
 * A bare `tool` is null on purpose: the sandbox gates per tool NAME, so
 * "tool" grants nothing that can be checked and would read as if it granted
 * all of them.
 */
function parseCapability(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;
    const m = TOOL_CAPABILITY_RE.exec(s);
    if (m) return { kind: 'tool', tool: m[1] };
    if (s !== 'tool' && Object.prototype.hasOwnProperty.call(CAPABILITY_BRIDGES, s)) {
        return { kind: s, tool: null };
    }
    return null;
}

/** Canonical spelling of one parsed capability — what the manifest stores. */
function capabilityId(cap) {
    return cap.kind === 'tool' ? `tool:${cap.tool}` : cap.kind;
}

/**
 * The declared manifest, normalized: recognised entries only, deduped, in
 * declaration order. Same division of labour as appTriggerContract — the
 * readers get the usable half, validateCustomNode reports the junk.
 */
function declaredCapabilities(definition) {
    const raw = definition?.capabilities;
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of raw) {
        const cap = parseCapability(entry);
        if (!cap) continue;
        const id = capabilityId(cap);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ...cap, id });
    }
    return out;
}

/** The tool names the manifest declares, sorted unique. */
function capabilityToolNames(definition) {
    return [...new Set(declaredCapabilities(definition).filter(c => c.kind === 'tool').map(c => c.tool))].sort();
}

/**
 * The manifest as codeSandbox wants it: the Set for `bridges.allowedTools`.
 *
 * Derived from the manifest and nothing else, so the list the palette gated
 * on and the list the isolate enforces are the same list — that is what makes
 * the declaration binding rather than descriptive. (The runner narrows it
 * further against the caller's CURRENT permissions; a manifest is a ceiling,
 * never a grant.)
 *
 * `http` has no equivalent yet: execOutbound builds fetchHttp for every code
 * step, so an undeclared ctx.http call still works. Withholding that bridge
 * from a node that does not declare it belongs where the bridges are built,
 * not here — this is the seam it would read from.
 */
function sandboxAllowedTools(definition) {
    return new Set(capabilityToolNames(definition));
}

// Every code step in the node — root graph and any nested layer, the same
// two places requiredIntegrations collects from, so the two never disagree
// about what the node contains.
function eachCodeStep(definition, fn) {
    if (!isObject(definition)) return;
    const collect = (graph) => walkSteps(graph?.steps, (s) => { if (s.type === 'code') fn(s); });
    collect(definition);
    if (isObject(definition.layers)) for (const layer of Object.values(definition.layers)) collect(layer);
}

function codeSteps(definition) {
    const out = [];
    eachCodeStep(definition, s => out.push(s));
    return out;
}

/** The single code step that is the node's body, or null. */
function customNodeBody(definition) {
    const bodies = codeSteps(definition);
    return bodies.length === 1 ? bodies[0] : null;
}

/**
 * True when this Step definition is a custom node.
 *
 * The presence of a code body IS the difference that matters: it is exactly
 * the case where the graph stops answering "what does this reach", which is
 * why the manifest and this module exist at all.
 */
function isCustomNodeDefinition(definition) {
    return codeSteps(definition).length > 0;
}

/** Contract + manifest in one call, the way stepContract() reads a Step. */
function customNodeContract(definition) {
    const body = customNodeBody(definition);
    return {
        params: stepParams(definition),
        outputFields: stepOutputFields(definition),
        capabilities: declaredCapabilities(definition).map(c => c.id),
        toolNames: capabilityToolNames(definition),
        bodyStepId: body ? (body.id ?? null) : null,
    };
}

/**
 * Validate a custom node's declaration — used at save time, same issue-record
 * shape as appTriggerContract/formTriggerContract: `[{ code, path, message,
 * hint }]`, empty = valid. Every issue here is an error; the caller adds the
 * severity and the code prefix.
 *
 * Deliberately NOT re-checked here:
 *  - more than one layer_output. validate/graph.js already refuses that as
 *    `layer.multiple_outputs`, and two messages for one mistake is how an
 *    author learns to read neither.
 *  - the SHAPE of layer_output.fields, which is dataShapingRules'
 *    `layer_output.fields_shape`. A malformed `fields` still declares no
 *    outputs, so it lands on outputs_empty below and the author gets the
 *    shape message from the one place that owns it.
 */
function validateCustomNode(definition) {
    const issues = [];
    const push = (code, path, message, hint) => issues.push({ code, path, message, hint });

    if (!isObject(definition)) {
        push('node_shape', '', 'A custom node must be an object definition { trigger, steps, capabilities }.', 'Open the node in the builder and save it again.');
        return issues;
    }

    // ── The body ────────────────────────────────────────────────────────
    const bodies = codeSteps(definition);
    if (bodies.length === 0) {
        push('body_missing', 'steps', 'A custom node needs a code step as its body.', 'Add the code step, or keep this as a reusable Step instead of a custom node.');
    } else if (bodies.length > 1) {
        // One node, one body. With two, "the capabilities of this node" has
        // no single answer — sandboxAllowedTools would gate one isolate with
        // a list assembled from both, so each body would silently be granted
        // the other's tools.
        push('body_ambiguous', 'steps', `A custom node has one code step as its body; this one has ${bodies.length}.`, 'Merge them into one body, or build this as a reusable Step that calls several.');
    }

    // ── Declared outputs — the mandate. See the module header. ──────────
    const out = (Array.isArray(definition.steps) ? definition.steps : []).find(s => isObject(s) && s.type === 'layer_output');
    if (!out) {
        push('outputs_missing', 'steps', 'A custom node must declare its outputs: it has no layer_output step.', 'Add a layer_output step naming each field the node returns — downstream steps can only bind to fields it declares.');
    } else if (!isObject(out.fields) || Object.keys(out.fields).length === 0) {
        push('outputs_empty', 'steps.layer_output.fields', 'A custom node must declare at least one output field.', 'Name each value the body returns, e.g. { result: { kind: "ref", path: "steps.body.output.result" } } — an empty contract binds to nothing and the routine runs green while writing nothing.');
    }

    // ── The manifest ────────────────────────────────────────────────────
    const raw = definition.capabilities;
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
        push('capabilities_shape', 'capabilities', 'capabilities must be an array of capability names.', `Use [] for a node that reaches nothing, or names from: ${CAPABILITY_KINDS.map(k => (k === 'tool' ? 'tool:<name>' : k)).join(', ')}.`);
    } else if (Array.isArray(raw)) {
        raw.forEach((entry, i) => {
            const at = `capabilities[${i}]`;
            const cap = parseCapability(entry);
            if (!cap) {
                push('capability_unknown', at, `"${typeof entry === 'string' ? entry : String(entry)}" is not a capability this sandbox can grant.`, `Use tool:<name> for one tool, or one of: ${CAPABILITY_KINDS.filter(k => k !== 'tool').join(', ')}.`);
                return;
            }
            if (GRANTABLE_CAPABILITY_KINDS.includes(cap.kind)) return;
            // Declared, real, and refused at run time. Saying so here is the
            // whole point: the alternative is a node that passes review and
            // then fails from inside an isolate, where the only evidence is a
            // line number in someone else's code.
            if (cap.kind === 'secrets') {
                // The one wording for this refusal lives with the code that
                // raises it — codeSandbox's header says why there is exactly
                // one, so tests pin one string instead of copies that drift.
                // Required here rather than at the top of the file because it
                // pulls in isolated-vm and this branch is the only reader.
                const { SECRETS_NOT_CONFIGURED_MESSAGE } = require('./codeSandbox');
                push('capability_refused', at, `This node declares the "secrets" capability, but ${SECRETS_NOT_CONFIGURED_MESSAGE}`, 'Drop it and pass the value in through the node inputs, or reach the service with a tool capability, which calls a connected app under its own credentials.');
                return;
            }
            push('capability_unavailable', at, `The "${cap.kind}" capability is not available to a custom node.`, 'ctx.db exists only for webpage handlers; a routine\'s code body gets no database bridge, so the call would fail halfway through a live run. Read and write through a datatable step instead.');
        });
    }

    // ── Manifest ↔ the list the sandbox enforces ────────────────────────
    //
    // Two halves of one sentence: the manifest is read before the node is
    // offered, `allowedTools` when it runs. Drift either way has a run-time
    // face. A tool the body may call but the manifest does not declare makes
    // the palette offer the node to a caller who cannot grant it, and the run
    // answers `tool "x" not allowed for this step` from inside the isolate.
    // A tool the manifest declares but the body may not call hides the node
    // from callers over a reach it does not have, and if the body ever does
    // call it, the sandbox refuses the very thing the manifest promised.
    const declaredTools = new Set(capabilityToolNames(definition));
    const bodyTools = new Set();
    let badAllowedTools = false;
    eachCodeStep(definition, (s) => {
        if (s.allowedTools === undefined || s.allowedTools === null) return;
        // The SHAPE belongs to dataShapingRules (`code.allowed_tools_shape`).
        // Noted here only so a malformed list is not read as "declares none",
        // which would turn a shape bug into a false capability_undeclared.
        if (!Array.isArray(s.allowedTools)) { badAllowedTools = true; return; }
        for (const t of s.allowedTools) if (typeof t === 'string' && t.trim()) bodyTools.add(t.trim());
    });
    if (!badAllowedTools) {
        for (const t of [...bodyTools].sort()) {
            if (!declaredTools.has(t)) {
                push('capability_undeclared', 'capabilities', `The body may call "${t}", which the capability list does not declare.`, `Add "tool:${t}" to capabilities, or remove it from the body's allowedTools.`);
            }
        }
        for (const t of [...declaredTools].sort()) {
            if (!bodyTools.has(t)) {
                push('capability_not_granted', 'capabilities', `The capability list declares "tool:${t}", which the body is not allowed to call.`, `Add "${t}" to the body's allowedTools, or drop the capability — the sandbox answers 'tool "${t}" not allowed for this step' either way.`);
            }
        }
    }

    return issues;
}

module.exports = {
    CAPABILITY_KINDS,
    CAPABILITY_BRIDGES,
    GRANTABLE_CAPABILITY_KINDS,
    TOOL_CAPABILITY_RE,
    parseCapability,
    declaredCapabilities,
    capabilityToolNames,
    sandboxAllowedTools,
    customNodeBody,
    isCustomNodeDefinition,
    customNodeContract,
    validateCustomNode,
};
