// @typecheck
/**
 * Per-graph validation: the rules that apply to ONE graph — the root
 * definition or a layer/Step mini-definition. Trigger shape and the
 * kind-specific trigger contracts (schedule, form, app_event, app_trigger),
 * step ids and types, edges and their labels, the DAG check, the call_layer /
 * call_block reference passes, and the walk that runs the per-step rules over
 * top-level steps and every step nested in a loop body / parallel branch.
 *
 * The per-step-type field rules themselves live in validate/stepRules.js; the
 * cross-graph passes (layers map, size ceilings, the draft/activate stage
 * ladder) live in validate/definition.js, which drives this module.
 */

const { isObject, topoOrder } = require('./helpers');
const { collectCallLayerSteps, validateCallLayerStep } = require('./callLayer');
const { collectCallBlockSteps, validateCallBlockStep } = require('./callBlock');
// The rule groups, one module each; validateGraph runs them in phase order.
// The step rules are handed to the rule modules through ctx rather than
// required there: stepRules sits inside the server's import cycle, and the rule
// modules need not.
const { createStepChecker, checkPinnedOutput } = require('./stepRules');
const { checkPrimaryTrigger } = require('./graphTrigger');
const { collectGraphNodes, checkContractOutputs } = require('./graphNodes');
const { checkEdges } = require('./graphEdges');
const { walkGraphSteps, checkFormEndings } = require('./graphWalk');
const { checkDataRefCycles } = require('./dataRefCycles');

/**
 * Walk a graph (root definition or a layer mini-definition) collecting every
 * call_layer step — including those nested inside loop bodies and parallel
 * branches. Returns [{ step, path }] with builder-style paths.
 */

const NODE_SEG_RE = /^(trigger|triggers|steps)(?:\[(.+)\])?$/;

/**
 * The step a record's path addresses, as an id the canvas can select.
 *
 * Paths are not uniform, and deliberately so: a top-level step is addressed
 * by INDEX (`steps[3]`) except where the rule already knew the id
 * (`steps[<id>]`, form_page.input_after_ending); a trigger by id where it has
 * one (`triggers[<id>]`, C7); a nested step always by id
 * (`steps[3].body.steps[<id>]`). This resolves whichever form it meets against
 * the graph, and the DEEPEST addressed node wins — a record about a loop-body
 * step is about that step, not its loop. Null when the path names no node
 * (`edges[2]`, `piiLineColors`, an index that no longer exists).
 * @param {string} pathPrefix
 * @param {string} path
 */
function stepIdFromPath(graph, pathPrefix, path) {
    if (typeof path !== 'string' || !path) return null;
    const local = pathPrefix && path.startsWith(pathPrefix) ? path.slice(pathPrefix.length) : path;
    /**
     * @param {string} tok
     */
    const byToken = (list, tok) => {
        if (!Array.isArray(list)) return null;
        const hit = list.find((s) => isObject(s) && s.id === tok);
        if (hit) return tok;
        if (!/^\d+$/.test(tok)) return null;
        const at = list[Number(tok)];
        return isObject(at) && typeof at.id === 'string' && at.id ? at.id : null;
    };
    let found = null;
    let topLevel = true;
    for (const part of local.split('.')) {
        const m = NODE_SEG_RE.exec(part);
        if (!m) continue;
        const [, seg, tok] = m;
        if (seg === 'trigger') {
            if (!tok && isObject(graph.trigger) && typeof graph.trigger.id === 'string') found = graph.trigger.id;
        } else if (seg === 'triggers') {
            if (tok) found = byToken(graph.triggers, tok) ?? found;
        } else if (tok && tok !== '?') {
            // First `steps[…]` is the top-level list (index or id); anything
            // after it is a loop body / parallel branch, addressed by id.
            found = (topLevel ? byToken(graph.steps, tok) : tok) ?? found;
            topLevel = false;
        }
    }
    return found;
}

/**
 * The Finding targetRef for one record of this graph — see validateGraph.
 * @param {string} pathPrefix
 * @param {string} path
 */
function automationTargetRef(graph, pathPrefix, path, target) {
    const ref = { kind: 'automation', id: target?.id ?? null };
    if (target?.title) ref.title = target.title;
    if (typeof path === 'string' && path) {
        ref.path = path;
        const stepId = stepIdFromPath(graph, pathPrefix, path);
        if (stepId) ref.stepId = stepId;
    }
    return ref;
}

/**
 * Validate ONE graph — the root definition or a layer mini-definition.
 * Pushes records onto opts.errors / opts.warnings with `pathPrefix`
 * prepended to every path ('' for root, 'layers.<key>.' for layers).
 * Every record also carries `kind: 'automation'` and a `targetRef`
 * (core/findings/finding.js); `opts.target` = `{ id, title }` of the
 * automation being validated fills in the id, and is optional.
 *
 * opts:
 *   errors / warnings   — shared record arrays (mutated)
 *   scope               — 'root' | 'layer'
 *   layers              — the ROOT layers map (for call_layer reference checks)
 *   availableTools / toolRequiredParams / deliverableEvents /
 *   availableAgents /
 *   topicClassifier     — as on validateDefinition.
 *
 * Mirrors the original single-graph behaviour: stops validating THIS graph
 * at the same phase boundaries the original function early-returned at
 * (shape → ids/edges → DAG → per-step), without aborting sibling graphs.
 * @param {string} pathPrefix
 */
function validateGraph(graph, pathPrefix, opts) {
    const { errors, warnings, scope = 'root', layers = {}, availableTools = null, toolRequiredParams = null, deliverableEvents = null, availableBlocks = null, knownConnectionIds = null, knownVarNames = null, availableAgents = null, topicClassifier = null, target = null } = opts;
    // Every record that leaves this graph carries the two fields the shared
    // Finding shape adds (core/findings/finding.js): `kind`, and a `targetRef`
    // naming WHICH automation and — when the path addresses one — WHICH step.
    // Purely additive: severity and the draft/activate ladder are untouched,
    // validate/definition.js still decides what blocks at which stage. The
    // automation id is whatever the caller threaded in as opts.target
    // ({ id, title }); validateGraph itself only ever sees a definition.
    const withTarget = (rec) => (rec.targetRef ? rec : { ...rec, kind: 'automation', targetRef: automationTargetRef(graph, pathPrefix, rec.path, target) });
    const pushE = (rec) => errors.push(withTarget(rec));
    const pushW = (rec) => warnings.push(withTarget(rec));
    const startErrors = errors.length;
    const p = (s) => pathPrefix + s;
    // Contract scopes (layer + block) share the input/output-contract rules:
    // a fixed layer_input trigger, exactly one layer_output, no approval, no
    // nested layers. 'block' is a standalone Step (kind='block') validated at
    // the document root; 'layer' is an inline flowlet.
    const isContractScope = scope === 'layer' || scope === 'block';
    const contractNoun = scope === 'block' ? 'Step' : 'Layer';

    if (!isObject(graph.trigger)) pushE({ code: 'trigger.missing', severity: 'error', path: p('trigger'), message: 'Missing or invalid `trigger`.', hint: isContractScope ? `Every ${contractNoun} needs a layer_input trigger declaring its params.` : 'Call builder_propose_trigger before adding any steps.' });
    if (!Array.isArray(graph.steps)) pushE({ code: 'steps.not_array', severity: 'error', path: p('steps'), message: '`steps` must be an array.', hint: 'Initialise the draft via builder_propose_trigger so the shape is correct.' });
    if (!Array.isArray(graph.edges)) pushE({ code: 'edges.not_array', severity: 'error', path: p('edges'), message: '`edges` must be an array.', hint: 'Initialise the draft via builder_propose_trigger so the shape is correct.' });
    if (errors.length > startErrors) return;

    // Trigger — ensure it has an id and a kind.
    const trigger = graph.trigger;
    const ctx = { graph, pathPrefix, scope, p, pushE, pushW, isContractScope, contractNoun, trigger, checkPinnedOutput, createStepChecker };
    checkPrimaryTrigger(ctx, deliverableEvents);

    const { ids, stepById } = collectGraphNodes(ctx);
    checkContractOutputs(ctx);
    checkEdges(ctx, ids, stepById);
    if (errors.length > startErrors) return;

    // DAG check.
    const nodes = Array.from(ids);
    const order = topoOrder(nodes, graph.edges);
    if (!order) pushE({ code: 'graph.cycle', severity: 'error', path: p('edges'), message: 'Definition contains a cycle.', hint: 'Inspect the edges array; remove the back-edge that closes the loop.' });
    if (errors.length > startErrors) return;

    // call_layer reference checks — run over EVERY call step in this graph,
    // including those nested inside loop bodies / parallel branches.
    for (const { step, path: at } of collectCallLayerSteps(graph, pathPrefix)) {
        validateCallLayerStep(step, at, layers, pushE);
    }

    // call_block reference checks — external Step references. availableBlocks
    // (when provided) is the caller's published-Steps catalog.
    for (const { step, path: at } of collectCallBlockSteps(graph, pathPrefix)) {
        validateCallBlockStep(step, at, availableBlocks, pushE);
    }

    walkGraphSteps(ctx, { ids, stepById, order, availableTools, toolRequiredParams, knownConnectionIds, knownVarNames, availableAgents, topicClassifier });
    checkDataRefCycles(ctx);
    checkFormEndings(ctx, stepById);
}

module.exports = { validateGraph };
