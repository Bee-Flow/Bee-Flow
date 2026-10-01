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
const { createFieldsOf } = require('../bindingPaths');

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

    /**
     * Which FIELDS of `stepId`'s output other steps actually read. Two shapes
     * count: a direct `steps.<id>.output.<field>`, and — the one that matters
     * for a fan-out — `loop.<itemVar>.output.<field>` inside a step whose
     * forEach iterates `steps.<id>.output.results`. The fan-out wrapper's own
     * keys are not model fields and are filtered out.
     */
    const FANOUT_KEYS = new Set(['results', 'iterations', 'succeeded', 'failed', 'truncated', 'totalItems', 'error', 'item', 'index', 'status']);
    // `loopVarsAbove` — for every step, the itemVars of the loops whose body
    // it sits in (outermost first). A top-level step has none; only its own
    // forEach binds a loop.<var> for it.
    const loopVarsAbove = new Map();
    const flatSteps = (() => {
        const out = [];
        const walk = (list, above) => {
            for (const s of (Array.isArray(list) ? list : [])) {
                if (!isObject(s)) continue;
                out.push(s);
                loopVarsAbove.set(s, above);
                if (Array.isArray(s.body)) walk(s.body, s.type === 'loop' && typeof s.itemVar === 'string' ? [...above, s.itemVar] : above);
                // parallel.branches: each branch is a flat list of steps that
                // inherits the loop vars of whatever body the parallel sits in.
                if (Array.isArray(s.branches)) for (const b of s.branches) walk(Array.isArray(b) ? b : (Array.isArray(b?.steps) ? b.steps : []), above);
            }
        };
        walk(graph?.steps, []);
        return out;
    })();
    // The fields later steps read off a step's output, in two shapes: the
    // direct `steps.<id>.output.<f>` reference (`all`) and, separately, the
    // fan-out `loop.<itemVar>.output.<f>` read by a step iterating over its
    // results (`viaLoop`, also in `all`). The two are told apart because
    // execAi.js infers an ai_step's schema from the direct refs only
    // (collectAiStepOutputFields has no `loop.` scan).
    const fieldsReadFromStep = (stepId) => {
        const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const found = new Set();
        const viaLoop = new Set();
        const scan = (text, prefix, into) => {
            const re = new RegExp(`${esc(prefix)}\\.([A-Za-z_$][\\w$]*)`, 'g');
            let m;
            while ((m = re.exec(text)) !== null) if (!FANOUT_KEYS.has(m[1])) { found.add(m[1]); if (into) into.add(m[1]); }
        };
        for (const s of flatSteps) {
            if (s.id === stepId) continue;
            let text;
            try { text = JSON.stringify(s); } catch (_) { continue; }
            if (!text) continue;
            scan(text, `steps.${stepId}.output`, null);
            const over = isObject(s.forEach) ? s.forEach.overRef : null;
            if (typeof over === 'string' && new RegExp(`^steps\\.${esc(stepId)}\\.output(\\.results)?$`).test(over.trim())) {
                scan(text, `loop.${s.forEach.itemVar || 'item'}.output`, viaLoop);
            }
        }
        return { all: [...found], viaLoop: [...viaLoop] };
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

    // Which fields a binding's source is known to produce, for the
    // unknown_field check in referenceScoping (null where not known).
    const fieldsOf = createFieldsOf(graph, stepsById);

    return {
        graph, trigger, ids, seenSoFar, pushE, pushW,
        availableTools, toolRequiredParams, knownConnectionIds, availableAgents, topicClassifier, isContractScope,
        stepsById, loopVarsAbove, fieldsReadFromStep, outgoingLabelsFor, fieldsOf,
    };
}

module.exports = { createStepContext };
