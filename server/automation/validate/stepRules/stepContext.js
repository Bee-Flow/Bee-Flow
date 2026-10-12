/**
 * The graph-level state every per-step rule reads, derived ONCE per graph.
 *
 * `createStepChecker` used to close over all of this; the rules now take it as
 * an explicit `ctx`, so each rule module can be read (and required) on its own.
 * What lives here is everything that depends on the WHOLE graph rather than on
 * the step in hand: the step index, the loop nesting above each step, which
 * output fields later steps read, and the branch labels wired out of a node.
 */

const { isObject } = require('../helpers');
const { inferAiStepOutputSchema, collectAiStepOutputReads } = require('../../../core/automationRunner/aiOutputInference');

/**
 * Build the context for ONE graph. The caller's bindings are carried through
 * unchanged; the rest is derived here.
 */
function createStepContext({
    graph, trigger, ids, seenSoFar, pushE, pushW,
    availableTools, toolRequiredParams, knownConnectionIds, availableAgents, topicClassifier, isContractScope,
}) {
    // Branch labels actually wired OUT of a node, for the pinned-brancher rule.
    // Mirrors the runtime's EFFECTIVE label (`label`, else `case:<caseName>` —
    // shared.js effectiveEdgeLabel) rather than reading `label` alone: an edge
    // drawn from a case port can carry only `caseName`, the runtime routes it
    // fine, and treating it as unlabelled here would report a correctly wired
    // switch as a dead end.
    // Top-level steps by id — used by the `count` → `returned` deprecation
    // notice, which has to know what kind of step an upstream ref points at.
    const stepsById = new Map(
        (Array.isArray(graph?.steps) ? graph.steps : [])
            .filter(s => isObject(s) && typeof s.id === 'string')
            .map(s => [s.id, s]),
    );

    // The fan-out wrapper's own keys: not model fields, never reported as a
    // field read (see fieldsReadFromStep below).
    const FANOUT_KEYS = new Set(['results', 'iterations', 'succeeded', 'failed', 'truncated', 'totalItems', 'error', 'item', 'index', 'status']);
    // `loopVarsAbove` — for every step, the itemVars of the loops whose body
    // it sits in (outermost first). A top-level step has none; only its own
    // forEach binds a loop.<var> for it.
    const loopVarsAbove = new Map();
    const walkLoopVars = (list, above) => {
        for (const s of (Array.isArray(list) ? list : [])) {
            if (!isObject(s)) continue;
            loopVarsAbove.set(s, above);
            if (Array.isArray(s.body)) walkLoopVars(s.body, s.type === 'loop' && typeof s.itemVar === 'string' ? [...above, s.itemVar] : above);
            // parallel.branches: each branch is a flat list of steps that
            // inherits the loop vars of whatever body the parallel sits in.
            if (Array.isArray(s.branches)) for (const b of s.branches) walkLoopVars(Array.isArray(b) ? b : (Array.isArray(b?.steps) ? b.steps : []), above);
        }
    };
    walkLoopVars(graph?.steps, []);
    // The fields later steps read off a step's output, in two shapes: every
    // field read straight off it (`all`) and, separately, the fields read
    // through a fan-out's envelope (`viaLoop`, also in `all`):
    // `loop.<item>.output.<f>` in a step iterating its `results`, or
    // `results[*].output.<f>` / `results[0].output.<f>`. For a per-item step
    // only the second shape is served — its output is the list of answers.
    //
    // The reads are the ones the runner infers a schemaless step's schema
    // from (aiOutputInference.collectAiStepOutputReads), so a warning here and
    // the schema the run asks for cannot disagree: the shared path grammar for
    // paths and templates (`output["Total (EUR)"]`, `steps["ex1"]…`), the
    // expression parser for formulas (`count-1` there reads `count`, minus
    // one), and never a label, a description or a pinned sample. The step's
    // own forEach is set aside for the read, so a field read straight off a
    // per-item step is seen too; the envelope is unwrapped here.
    const fieldsCache = new Map();
    const firstField = (t) => (t && t.type === 'prop' && typeof t.key === 'string' && !/^-?[0-9]+$/.test(t.key) ? t.key : null);
    const isElement = (t) => !!t && (t.type === 'wild' || t.type === 'match' || (t.type === 'prop' && (typeof t.key === 'number' || /^-?[0-9]+$/.test(t.key))));
    const fieldsReadFromStep = (stepId) => {
        if (fieldsCache.has(stepId)) return fieldsCache.get(stepId);
        const asOneRun = {
            ...graph,
            steps: (Array.isArray(graph?.steps) ? graph.steps : []).map(s => (isObject(s) && s.id === stepId && s.forEach ? { ...s, forEach: undefined } : s)),
        };
        const found = new Set();
        const viaLoop = new Set();
        for (const { tokens } of collectAiStepOutputReads(asOneRun, stepId)) {
            const [r, el, out, f] = tokens;
            if (firstField(r) === 'results' && isElement(el) && out && out.type === 'prop' && out.key === 'output' && firstField(f)) {
                found.add(f.key);
                viaLoop.add(f.key);
                continue;
            }
            const name = firstField(r);
            if (name && !FANOUT_KEYS.has(name)) found.add(name);
        }
        const res = { all: [...found], viaLoop: [...viaLoop] };
        fieldsCache.set(stepId, res);
        return res;
    };

    // The schema the RUNNER will ask a schemaless step for, inferred from how
    // later steps read it (execAi uses the same function), so a finding can
    // show the real nested shape instead of guessing it. Memoised per step.
    const inferredCache = new Map();
    const inferredOutputOf = (stepId) => {
        if (!inferredCache.has(stepId)) inferredCache.set(stepId, inferAiStepOutputSchema(graph, stepId));
        return inferredCache.get(stepId);
    };

    const outgoingLabelsFor = (stepId) => {
        const set = new Set();
        for (const e of (Array.isArray(graph?.edges) ? graph.edges : [])) {
            if (!isObject(e) || e.from !== stepId) continue;
            const label = e.label || (e.caseName != null ? `case:${e.caseName}` : null);
            if (label) set.add(label);
        }
        return set;
    };

    return {
        graph, trigger, ids, seenSoFar, pushE, pushW,
        availableTools, toolRequiredParams, knownConnectionIds, availableAgents, topicClassifier, isContractScope,
        stepsById, loopVarsAbove, fieldsReadFromStep, inferredOutputOf, outgoingLabelsFor,
    };
}

module.exports = { createStepContext };
