/**
 * Automation graph helpers — one reading of a routine definition shared by the
 * document runner (which marks a file a model wrote) and by the compliance
 * checks: the AI-Act signals (compliance/aiAct/signals.js), the Art. 50(2)
 * marking check, the calendar's "affects" counts and the Machinery detector,
 * so they can never disagree on what counts as an AI step.
 *
 * It lives beside the rest of the definition grammar (bind.js, stepContract.js)
 * rather than under compliance/: core/automationRunner reads it too, and core
 * must not depend on a product feature.
 *
 * Nesting follows the shared walker in automation/stepContract.js (loop
 * bodies, parallel branches); this module only adds WHERE a step sits (its
 * builder-style path and its container) and the definition's layers, which
 * the shared walker leaves to its callers. condition/switch steps have no
 * nested arms in this grammar — their branches are edges — so a flat visit of
 * a container's children is the whole graph.
 *
 * Pure and DB-free: safe to require from a check, a route or a test.
 */

const { walkSteps: walkGraphSteps } = require('./stepContract');

// The step types that call a model. `summarize` is NOT one of them — it is an
// aggregate op over a collection (automation/validate/stepRules.js), and the
// client fallback in ComplianceBlock must agree (CONTRACTS.md).
const AI_STEP_TYPES = Object.freeze(['ai_step', 'data_extraction', 'ai_tool']);
const _AI = new Set(AI_STEP_TYPES);

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function isAiStep(step) {
    return isObject(step) && _AI.has(step.type);
}

/**
 * Visit every step of a definition — the root graph first, then each layer
 * — descending into loop bodies and parallel branches, parents before their
 * children. `fn(step, { path, parentId, layer })`:
 *   path      builder-style address ('steps[2]', 'steps[2].body.steps[<id>]',
 *             'steps[4].branches[1].steps[<id>]', 'layers[<key>].steps[0]')
 *   parentId  id of the enclosing loop/parallel step, null at the top level
 *   layer     the layer key, null for the root graph
 */
function walkSteps(definition, fn) {
    if (!isObject(definition) || typeof fn !== 'function') return;
    _walkGraph(definition, null, fn);
    if (!isObject(definition.layers)) return;
    for (const [key, layer] of Object.entries(definition.layers)) {
        if (isObject(layer)) _walkGraph(layer, key, fn);
    }
}

function _walkGraph(graph, layerKey, fn) {
    if (!Array.isArray(graph.steps)) return;
    const prefix = layerKey === null ? '' : `layers[${layerKey}].`;
    // The shared walker visits a container before its children, so recording
    // each child's address while at the parent means the address is known by
    // the time the walker reaches the child. Top-level steps are addressed by
    // index, nested ones by id — the shape validate/graph.js emits.
    const where = new Map(); // step object → { path, parentId }
    graph.steps.forEach((s, i) => { if (isObject(s)) where.set(s, { path: `${prefix}steps[${i}]`, parentId: null }); });
    walkGraphSteps(graph.steps, (s) => {
        const at = where.get(s) || { path: `${prefix}steps[${s.id ?? '?'}]`, parentId: null };
        if (s.type === 'loop' && Array.isArray(s.body)) {
            for (const child of s.body) {
                if (isObject(child)) where.set(child, { path: `${at.path}.body.steps[${child.id ?? '?'}]`, parentId: s.id ?? null });
            }
        } else if (s.type === 'parallel' && Array.isArray(s.branches)) {
            s.branches.forEach((branch, bi) => {
                for (const child of Array.isArray(branch) ? branch : []) {
                    if (isObject(child)) where.set(child, { path: `${at.path}.branches[${bi}].steps[${child.id ?? '?'}]`, parentId: s.id ?? null });
                }
            });
        }
        fn(s, { path: at.path, parentId: at.parentId, layer: layerKey });
    });
}

/** Every step of the definition, in walk order, as `{ step, path, parentId, layer }`. */
function listSteps(definition) {
    const out = [];
    walkSteps(definition, (step, ctx) => out.push({ step, ...ctx }));
    return out;
}

/** The AI steps of the definition, in walk order. */
function aiSteps(definition) {
    return listSteps(definition).filter(x => isAiStep(x.step));
}

/**
 * The text of a template field as the runtime resolves it: a plain string
 * ('{{steps.ai_1.output.text}}'), or a binding object the builder flattened
 * ({kind:'template', value} / {kind:'ref', path} / {kind:'literal', value}).
 */
function templateText(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (isObject(v)) {
        if (typeof v.value === 'string') return v.value;
        if (typeof v.path === 'string') return v.path;
    }
    return '';
}

// Fields of a generate_document step that can carry model output into the
// file (content is the body; title and fileName end up in the document too).
const GENERATE_TEMPLATE_FIELDS = Object.freeze(['content', 'title', 'fileName']);

// The step types whose FILE can carry model output, so the Art. 50(2) walk
// below must consider both. fill_document's own carrier is its `values` map —
// a filled invoice whose amounts an AI step read out of a PDF carries model
// output just as surely as a generated report does.
// `presentation` joined for the same reason: a deck whose slides an ai_step
// wrote is model output on paper, and its `slides` binding is the carrier.
// (`slide` is not here: it produces an object, never a file.)
const DOCUMENT_STEP_TYPES = Object.freeze(['generate_document', 'fill_document', 'presentation']);

/** Every template string of a document step, as one blob to search for refs. */
function documentTemplateText(step) {
    const parts = GENERATE_TEMPLATE_FIELDS.map(f => templateText(step[f]));
    if (step.type === 'fill_document' && isObject(step.values)) {
        for (const v of Object.values(step.values)) parts.push(templateText(v));
        parts.push(templateText(step.copyName));
    }
    if (step.type === 'presentation') {
        parts.push(templateText(step.subtitle));
        // `slides` may be a template string or a list of them (or of objects
        // whose values are templates); serialised, every `steps.<id>` in it
        // is visible to the reference test.
        parts.push(typeof step.slides === 'string' ? templateText(step.slides) : (step.slides ? JSON.stringify(step.slides) : ''));
    }
    return parts.join('\n');
}

function _referencesStep(text, stepId) {
    if (!text || !stepId) return false;
    // `steps.<id>` followed by a non-identifier char or the end — so `steps.ai_1`
    // does not match `steps.ai_10`. Ids are builder slugs; escape defensively.
    const esc = String(stepId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`steps\\.${esc}(?![\\w-])`).test(text);
}

/**
 * The generate_document steps that plausibly put model output in a file —
 * the Art. 50(2) marking subjects. Two signals, strongest first:
 *   'reference'  a content/title/fileName template reads `steps.<aiStepId>`
 *   'downstream' the step comes after an AI step in walk order (same graph);
 *                the reference may be indirect (through a set/aggregate step)
 * Returns [{ step, path, parentId, layer, signal, aiStepIds }]; nothing when
 * the definition has no AI step at all.
 */
function generatingStepsDownstreamOfAi(definition) {
    const all = listSteps(definition);
    const out = [];
    // AI steps seen so far, per graph (root or layer) — a layer's document
    // step is not downstream of the root's AI step.
    const seenByGraph = new Map();
    for (const item of all) {
        const graphKey = item.layer === null ? '' : item.layer;
        if (!seenByGraph.has(graphKey)) seenByGraph.set(graphKey, []);
        const seen = seenByGraph.get(graphKey);
        if (isAiStep(item.step)) { if (item.step.id) seen.push(item.step.id); continue; }
        if (!DOCUMENT_STEP_TYPES.includes(item.step.type)) continue;

        const text = documentTemplateText(item.step);
        const referenced = _allAiIds(all, item.layer).filter(id => _referencesStep(text, id));
        if (referenced.length) {
            out.push({ ...item, signal: 'reference', aiStepIds: referenced });
        } else if (seen.length) {
            out.push({ ...item, signal: 'downstream', aiStepIds: seen.slice() });
        }
    }
    return out;
}

function _allAiIds(all, layer) {
    return all.filter(x => x.layer === layer && isAiStep(x.step) && x.step.id).map(x => x.step.id);
}

/**
 * The form triggers of a definition: the primary `trigger` when its kind is
 * 'form', plus every 'form' entry point in `triggers[]` (multi-trigger
 * routines). Root graph only — layers are invoked, never triggered.
 */
function formTriggersOf(definition) {
    if (!isObject(definition)) return [];
    const out = [];
    if (isObject(definition.trigger) && definition.trigger.kind === 'form') out.push(definition.trigger);
    for (const t of Array.isArray(definition.triggers) ? definition.triggers : []) {
        if (isObject(t) && t.kind === 'form') out.push(t);
    }
    return out;
}

/** True when a public form page (a form trigger or a form_page step) is part of the routine — the "customer-facing" signal. */
function hasFormPage(definition) {
    if (formTriggersOf(definition).length) return true;
    let found = false;
    walkSteps(definition, (s) => { if (s.type === 'form_page') found = true; });
    return found;
}

module.exports = {
    AI_STEP_TYPES,
    GENERATE_TEMPLATE_FIELDS,
    isAiStep,
    walkSteps,
    listSteps,
    aiSteps,
    templateText,
    generatingStepsDownstreamOfAi,
    formTriggersOf,
    hasFormPage,
};
