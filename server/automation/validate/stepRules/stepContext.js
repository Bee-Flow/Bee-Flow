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
const { isPick, isCompose, isPrefix, stepReadPaths } = require('../../../shared/mapping/index.mjs');

/** Every pick (and compose part) in `value`; a literal is data and is not read. */
function forEachPick(value, fn) {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const v of value) forEachPick(v, fn); return; }
    if (isPick(value)) { fn(value); return; }
    if (isCompose(value)) { for (const p of value.parts) if (isObject(p)) fn(p); return; }
    if (value.kind === 'literal') return;
    for (const k of Object.keys(value)) forEachPick(value[k], fn);
}

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
    // A field name the text scan below can match (`[A-Za-z_$][\w$]*`).
    const FIELD_RE = /^[A-Za-z_$][\w$]*$/;
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
            // A pick holds its path as data; read as the legacy path it spells.
            const picked = stepReadPaths(s).join('\n');
            scan(text, `steps.${stepId}.output`, null);
            scan(picked, `steps.${stepId}.output`, null);
            // A pick through a fan-out's results (`results.output.<f>`, a key
            // on a list maps over it) reads each item's output: the same read
            // as `loop.<v>.output.<f>` under a forEach over those results.
            scan(picked, `steps.${stepId}.output.results.output`, viaLoop);
            const over = isObject(s.forEach) ? s.forEach.overRef : null;
            if (typeof over === 'string' && new RegExp(`^steps\\.${esc(stepId)}\\.output(\\.results)?$`).test(over.trim())) {
                scan(text, `loop.${s.forEach.itemVar || 'item'}.output`, viaLoop);
                scan(picked, `loop.${s.forEach.itemVar || 'item'}.output`, viaLoop);
            }
            // The same two shapes as picks: a pick of `steps.<id>.output.<f>`,
            // and an `each` pick of `<f>` in a step that repeats over this
            // step's output (or its results), as the upgrade of a forEach
            // writes them.
            const rep = isObject(s.repeat) && isObject(s.repeat.over) ? s.repeat.over : null;
            // The list itself, as the text scan above read it in a forEach's
            // overRef: `steps.<id>.output.<f>` names <f>.
            if (rep && rep.root === 'steps' && rep.id === stepId && Array.isArray(rep.path)) {
                const f = rep.path[0];
                if (typeof f === 'string' && FIELD_RE.test(f) && !FANOUT_KEYS.has(f)) found.add(f);
            }
            const repeatsHere = !!rep && rep.root === 'steps' && rep.id === stepId && Array.isArray(rep.path)
                && (rep.path.length === 0 || (rep.path.length === 1 && rep.path[0] === 'results'));
            forEachPick(s, (p) => {
                const from = p.from;
                if (!isObject(from) || from.root !== 'steps' || from.id !== stepId || !Array.isArray(from.path)) return;
                if (p.take === 'each') {
                    if (!repeatsHere || !isPrefix(rep, from)) return;
                    const rest = from.path.slice(rep.path.length);
                    if (rest[0] === 'output' && typeof rest[1] === 'string' && FIELD_RE.test(rest[1]) && !FANOUT_KEYS.has(rest[1])) {
                        found.add(rest[1]);
                        viaLoop.add(rest[1]);
                    }
                    return;
                }
                const f = from.path[0];
                if (typeof f === 'string' && FIELD_RE.test(f) && !FANOUT_KEYS.has(f)) found.add(f);
            });
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
