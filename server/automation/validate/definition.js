/**
 * Whole-document validation: the passes that span more than one graph — the
 * inline `layers` map, the graph-size ceilings, the hide/reveal pairing check,
 * the root + per-layer runs of validateGraph, the layer-reference graph — and
 * the draft/activate stage ladder that decides which of the resulting errors
 * block a save.
 */

const { isObject } = require('./helpers');
const { LAYER_KEY_RE, MAX_STEPS, MAX_EDGES, MAX_TOTAL_NODES } = require('./constants');
const { COMPLETENESS_CODES } = require('./completenessCodes');
const { validateGraph } = require('./graph');
const { validateLayerGraph } = require('./layerGraph');

/**
 * Validate a definition. Returns { ok, errors[], warnings[] } where each
 * record is `{ code, severity, path, message, hint }`. The structured
 * shape lets the SSE builder loop feed *specific* failures back to the
 * LLM so it can self-correct instead of guessing what the free-text
 * meant.
 *
 *   code        — short, stable identifier (e.g. 'condition.dead_branch')
 *   severity    — 'error' | 'warning'
 *   path        — JSON-pointer-ish path into the def (e.g. 'steps[3].expr',
 *                 'layers.enrich.steps[2].expr' for layer-scoped records)
 *   message     — human-readable, for UI display
 *   hint        — actionable next step, written for the LLM
 *
 * `availableTools` (optional) is a Set of tool names from the catalog. When
 * provided, integration_action.tool is checked against it.
 *
 * `toolRequiredParams` (optional) is an object map { toolName: ['p1', …] } of
 * each tool's required input names. When provided, an integration_action whose
 * required input is absent (or bound to an empty-string literal) is flagged —
 * this is what stops a Talk-send-with-no-room or calendar-event-with-no-date
 * from activating green and then failing silently.
 *
 * `availableAgents` (optional) is a Set of agent ids the AUTOMATION OWNER may
 * actually use — published, in their own organisation, shared with them. When
 * provided, an `ai_step.agentId` outside it is flagged. Built by the caller
 * (routes/automation/crud.js), because that is a database question and this
 * pass is pure. See the R2 block in stepRules.js for why every way of being
 * outside that set gets the SAME answer, and for what happens when the agent
 * disappears AFTER the automation was saved.
 *
 * `topicClassifier` (optional) says whether the topic classifier behind
 * "is about" rules is installed: `false` when no classify-service is
 * configured, `true` when it is, `null` (the default) when the caller did not
 * ask or could not reach it. Only `false` produces a finding, so a short
 * outage never blocks saving or activating (stepRules/topicRules.js).
 */
function validateDefinitionStrict(def, { availableTools = null, toolRequiredParams = null, deliverableEvents = null, scope = 'root', availableBlocks = null, knownConnectionIds = null, availableAgents = null, topicClassifier = null } = {}) {
    const errors = [];
    const warnings = [];
    const pushE = (rec) => errors.push(rec);
    const pushW = (rec) => warnings.push(rec);

    if (!isObject(def)) {
        return {
            ok: false,
            errors: [{ code: 'shape.not_object', severity: 'error', path: '', message: 'Definition must be an object.', hint: 'Pass a JSON object with trigger, steps, and edges keys.' }],
            warnings: [],
        };
    }

    // ── Inline layers map: root-only, plain object, snake-case keys ──────
    // Validated FIRST so call_layer reference checks inside the graphs can
    // resolve against the well-formed subset.
    const layersMap = {};
    if (def.layers !== undefined) {
        if (!isObject(def.layers)) {
            pushE({ code: 'layers.shape', severity: 'error', path: 'layers', message: '`layers` must be an object map of { key: miniDefinition }.', hint: 'Each entry is { title, trigger (kind layer_input), steps (incl. a layer_output), edges }.' });
        } else {
            for (const [key, value] of Object.entries(def.layers)) {
                if (!LAYER_KEY_RE.test(key)) {
                    pushE({ code: 'layers.key_invalid', severity: 'error', path: `layers.${key}`, message: `Invalid layer key "${key}".`, hint: 'Keys must match ^[a-z][a-z0-9_]*$ (lowercase snake_case, starting with a letter).' });
                    continue;
                }
                if (!isObject(value)) {
                    pushE({ code: 'layers.value_shape', severity: 'error', path: `layers.${key}`, message: `Layer "${key}" must be an object (a mini-definition).`, hint: 'Use { title, trigger, steps, edges } — same shape as the root document.' });
                    continue;
                }
                layersMap[key] = value;
            }
        }
    }

    // §WS1.4 — graph-size ceilings (DoS guard, independent of the body limit).
    // Counted up front and failed fast so the O(n) graph passes (topo-sort +
    // Levenshtein id suggestions) never run on a pathologically large blob.
    {
        // Count EVERY executable node, including steps nested inside loop
        // bodies and parallel branches — otherwise the ceiling is bypassable by
        // burying 100k steps in a loop.body / parallel.branches (each is a real
        // node the runner walks).
        const countNested = (steps) => {
            if (!Array.isArray(steps)) return 0;
            let n = steps.length;
            for (const s of steps) {
                if (!isObject(s)) continue;
                if (s.type === 'loop') n += countNested(s.body);
                if (s.type === 'parallel' && Array.isArray(s.branches)) {
                    for (const branch of s.branches) n += countNested(branch);
                }
            }
            return n;
        };
        const rootSteps = countNested(def.steps);
        // Total edges also counts each layer's edges — a layer graph is real
        // execution surface, so its edges must count toward the DoS ceiling too.
        let totalEdges = Array.isArray(def.edges) ? def.edges.length : 0;
        for (const layer of Object.values(layersMap)) {
            totalEdges += Array.isArray(layer.edges) ? layer.edges.length : 0;
        }
        if (rootSteps > MAX_STEPS) {
            pushE({ code: 'shape.too_many_steps', severity: 'error', path: 'steps', message: `Definition has ${rootSteps} steps (incl. loop/parallel bodies) — the maximum is ${MAX_STEPS}.`, hint: 'Split the work into reusable Steps/Flowlets or multiple automations.' });
        }
        if (totalEdges > MAX_EDGES) {
            pushE({ code: 'shape.too_many_edges', severity: 'error', path: 'edges', message: `Definition has ${totalEdges} edges (incl. layers) — the maximum is ${MAX_EDGES}.`, hint: 'Simplify the graph or split it into multiple automations.' });
        }
        let totalNodes = rootSteps;
        for (const layer of Object.values(layersMap)) {
            const layerNodes = countNested(layer.steps);
            totalNodes += layerNodes;
            if (layerNodes > MAX_STEPS) {
                pushE({ code: 'layers.too_many_steps', severity: 'error', path: 'layers', message: `A layer has ${layerNodes} steps (incl. loop/parallel bodies) — the maximum is ${MAX_STEPS} per layer.`, hint: 'Flatten or split the layer.' });
            }
        }
        if (totalNodes > MAX_TOTAL_NODES) {
            pushE({ code: 'shape.too_many_nodes', severity: 'error', path: '', message: `Definition has ${totalNodes} total steps across all layers — the maximum is ${MAX_TOTAL_NODES}.`, hint: 'Reduce the number of steps or split into multiple automations.' });
        }
        if (errors.length) return { ok: false, errors, warnings };
    }

    // BFSF-355 — "Show real values again" with nothing that ever hid anything.
    // The three Privacy Shield stages are one node now, and the contract between
    // them is the thing a single node cannot enforce: a reveal only means
    // something downstream of a hide. This shape validated completely clean
    // before, so the author's first sign of trouble was an empty output at run
    // time. A WARNING, never an error — the hide may legitimately live in a
    // Step/flowlet this document only calls, and an automation must stay savable
    // and activatable while it is being built.
    {
        const walk = (steps, fn) => {
            if (!Array.isArray(steps)) return;
            for (const s of steps) {
                if (!isObject(s)) continue;
                fn(s);
                if (s.type === 'loop') walk(s.body, fn);
                if (s.type === 'parallel' && Array.isArray(s.branches)) for (const b of s.branches) walk(b, fn);
            }
        };
        let hides = false;
        const reveals = [];
        const inspect = (s) => {
            // A guard hides too when it carries the tokenizing action — that is
            // exactly what Check + Hide is (engine.js execGuard, onFound.tokenize).
            if (s.type === 'tokenize') hides = true;
            else if (s.type === 'guard' && isObject(s.onFound) && s.onFound.tokenize) hides = true;
            else if (s.type === 'untokenize') reveals.push(s);
        };
        walk(def.steps, inspect);
        for (const layer of Object.values(layersMap)) walk(layer.steps, inspect);
        if (!hides) {
            for (const s of reveals) {
                pushW({
                    code: 'untokenize.no_hide_step', severity: 'warning', path: 'steps',
                    message: `Step ${s.id}: nothing in this automation hides personal data, so there are no placeholders to put back.`,
                    hint: 'Add a Privacy Shield step in "Hide personal data" or "Check and hide" mode before this one — or remove this step if the values were never hidden.',
                });
            }
        }
    }

    // Handoff 5: the buttons that start this automation from another app. A
    // root-document concern only; Steps and layers are never started that way.

    const graphOpts = { errors, warnings, layers: layersMap, availableTools, toolRequiredParams, deliverableEvents, availableBlocks, knownConnectionIds, availableAgents, topicClassifier };

    // Root graph. Preserve the original early-return semantics: a root
    // whose basic shape is broken returns immediately (the layer graphs
    // would only add noise on top of a fundamentally malformed document).
    // scope is 'root' for automations or 'block' for a standalone Step (whose
    // root IS the input/output contract — validateGraph applies the layer
    // rules and flags any nested `layers` itself).
    validateGraph(def, '', { ...graphOpts, scope });
    if (!isObject(def.trigger) || !Array.isArray(def.steps) || !Array.isArray(def.edges)) {
        return { ok: false, errors, warnings };
    }

    // Steps (scope='block') don't carry inline layers — skip the per-layer and
    // layer-reference passes entirely (validateGraph already flagged any).
    if (scope !== 'block') {
        // Each layer mini-definition gets the SAME per-graph validation under
        // its own path prefix, plus the layer-scope rules (layer_input trigger,
        // single layer_output, no approval, no nested layers).
        for (const [key, layer] of Object.entries(layersMap)) {
            validateGraph(layer, `layers.${key}.`, { ...graphOpts, scope: 'layer' });
        }

        // Layer-reference graph: cycles, depth cap, orphans.
        validateLayerGraph(def, layersMap, pushE, pushW);
    }

    return { ok: errors.length === 0, errors, warnings };
}

/**
 * Give a draft the benefit of the doubt on SHAPE only: absent `steps`/`edges`
 * become empty arrays, on the root graph and on every layer.
 *
 * A definition carrying just a trigger is semantically a valid empty draft —
 * "you haven't added any steps yet" — but the strict validator treats it as a
 * malformed document and early-returns, so the user got two cryptic shape
 * errors and no other feedback (BFSF-318). Activation still demands the real
 * arrays.
 *
 * Pure; the caller's object is never mutated.
 */
function coerceDraftShape(def) {
    if (!isObject(def)) return def;
    const out = { ...def };
    if (!Array.isArray(out.steps)) out.steps = [];
    if (!Array.isArray(out.edges)) out.edges = [];
    if (isObject(out.layers)) {
        out.layers = Object.fromEntries(Object.entries(out.layers).map(([key, layer]) => {
            if (!isObject(layer)) return [key, layer];
            const next = { ...layer };
            if (!Array.isArray(next.steps)) next.steps = [];
            if (!Array.isArray(next.edges)) next.edges = [];
            return [key, next];
        }));
    }
    return out;
}

/**
 * Validate a definition for a given lifecycle stage.
 *
 *   stage: 'activate' (default) — every rule blocks. Used by activate, import,
 *                                 version restore, provisioning, and the AI
 *                                 builder's finalize.
 *   stage: 'draft'              — INTEGRITY rules block; COMPLETENESS_CODES are
 *                                 downgraded to warnings tagged
 *                                 `blockedAt: 'activate'`. Used by the save
 *                                 paths so a half-built flow stays editable.
 *
 * The default is 'activate', so every pre-existing caller is unchanged.
 *
 * @returns {{ok: boolean, errors: object[], warnings: object[]}}
 */
function validateDefinition(def, opts = {}) {
    const stage = opts.stage || 'activate';
    if (stage !== 'draft') return validateDefinitionStrict(def, opts);

    const result = validateDefinitionStrict(coerceDraftShape(def), opts);
    const blocking = [];
    const downgraded = [];
    for (const rec of result.errors) {
        if (COMPLETENESS_CODES.has(rec.code)) downgraded.push({ ...rec, severity: 'warning', blockedAt: 'activate' });
        else blocking.push(rec);
    }
    return {
        ok: blocking.length === 0,
        errors: blocking,
        warnings: [...result.warnings, ...downgraded],
    };
}

module.exports = { validateDefinition, validateDefinitionStrict, coerceDraftShape };
