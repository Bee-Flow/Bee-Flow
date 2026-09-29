/**
 * Run it, see what broke, fix it, run it again — bounded, and honest about
 * the run that never went green.
 *
 * This is core/aiAgent.js's `_chatLoop` in the shape a custom-node body needs.
 * What is ported is the SHAPE: a counted loop with a hard ceiling
 * (`maxIterations = 30` there), one outward call per turn whose result is fed
 * back as the next turn's evidence, an early return the moment the work is
 * done, and a terminal branch for "the bound ran out". The outward call here
 * is not a tool dispatcher: it is `codeSandbox.runCode({ mode: 'test' })`,
 * which runs the author's body with every bridge stubbed and reports the
 * failure in the author's own line numbers plus a `wouldHaveCalled` list.
 *
 * THREE THINGS ARE DELIBERATELY NOT THE SAME AS OVER THERE.
 *
 * 1. THE BOUND IS SMALL. Thirty turns is right for a conversation that is
 *    making progress. A repair either converges in two or three passes or it
 *    is guessing, and a loop that guesses ten times costs ten model calls and
 *    ten isolates to arrive at the same "it still throws".
 *
 * 2. EXHAUSTION RETURNS, IT DOES NOT THROW. `_chatLoop` ends with
 *    `throw new Error('AI Agent exceeded maximum tool call iterations')`, and
 *    everything it learned on the way dies with the stack. Here the evidence
 *    IS the product: the author needs to see what was tried and what each
 *    attempt did, most of all when nothing worked. So every exit is a value
 *    with the whole attempt log attached.
 *
 * 3. A FAILED REPAIR RETURNS `code: null`. This is the failure the loop
 *    exists to prevent, so it is worth saying plainly: the obvious way to
 *    write this is to keep the latest candidate in a variable and return it
 *    at the end. Then a caller that reads `.code` gets a body that was never
 *    shown to run — usually the LAST one the model produced, i.e. the one
 *    least tested of all — and saves it as a working node. The last candidate
 *    is still handed back, under `lastCandidate`, because an author may well
 *    want to see it; it is just never in the field a caller reaches for when
 *    it wants the body that works.
 *
 * THE MODEL IS INJECTED, NEVER REQUIRED. `defaultDeps` follows
 * playbooks/phases/complianceFacts.js: `proposeFix` defaults to null, the way
 * its `signalsFromDefinition` does, and without it this module still runs the
 * body once and reports exactly what broke — it simply cannot repair, and
 * says so (`no_repairer`) instead of pretending it tried. That keeps the
 * model call at the caller's seam, keeps automation/ free of the LLM client,
 * and keeps these tests off the network.
 *
 * WHAT COUNTS AS GREEN. Not "it did not throw". A body that throws nothing
 * and returns nothing is the "runs green, writes nothing" failure
 * customNode.js makes declared outputs mandatory to prevent, so a run is only
 * green when the returned object carries every declared output. That is the
 * same single rule customNodePromote.js binds the node's layer_output to, so
 * what the node promises and what this loop checks cannot become two answers.
 *
 * KNOWN BLIND SPOT: a call to a tool outside `allowedTools` is refused inside
 * the isolate and answered as `{ error: 'tool "x" not allowed for this step' }`
 * BEFORE it reaches a bridge, so it never lands in `wouldHaveCalled`. A body
 * that ignores that error therefore looks like a body that called nothing.
 * Fixing that belongs in codeSandbox, where the refusal is raised.
 */

'use strict';

// A repair either converges quickly or it is guessing. See the header.
const MAX_REPAIR_ATTEMPTS = 3;
// A caller may ask for fewer; it may not ask for more. Same reasoning as
// codeSandbox's clampLimits: an author-supplied bound that nothing clamps is
// an author-supplied bill (one model call and one V8 isolate per turn).
const ATTEMPT_CEILING = 5;

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * The real collaborators, with room for the caller to replace one.
 *
 * `proposeFix` is deliberately null: the model call belongs to whoever owns
 * the model choice, the prompt and the budget for it, and wiring it here
 * would drag the LLM client into automation/ and a network call into every
 * test that touches this loop. Without it the loop tests the body and reports
 * — "not repaired because nothing was there to repair it", never "repaired".
 */
function defaultDeps(overrides = {}) {
    return {
        runTest: ({ code, inputs, limits, allowedTools }) => {
            const sandbox = require('./codeSandbox');
            if (!sandbox.isAvailable()) {
                // Flagged rather than described: the loop has to tell "this
                // box has no isolate" from "the author's code throws", and
                // matching on a message is how those two become one.
                const e = new Error(`Code step disabled: ${sandbox.loadError() || 'isolated-vm not installed'}`);
                e.sandboxUnavailable = true;
                throw e;
            }
            return sandbox.runCode({
                code,
                inputs,
                limits,
                mode: 'test',
                // The gate the manifest promises. Passed through testBridges
                // untouched (it spreads the caller's bridges), so a rehearsal
                // refuses exactly what a live run would refuse.
                bridges: { allowedTools: new Set(allowedTools || []) },
            });
        },
        proposeFix: null,
        ...overrides,
    };
}

/** One attempt's evidence, in the one shape every exit of this module carries. */
function evidenceOf(n, code, { result, logs, calls } = {}, error = null, missingOutputs = []) {
    return {
        attempt: n,
        code,
        ok: !error && missingOutputs.length === 0,
        error: error || null,
        missingOutputs,
        // What the body WOULD have reached, from the stubbed bridges. Present
        // (empty) rather than absent on every attempt: "it called nothing" is
        // an answer, and an absent key reads as "nobody looked".
        wouldHaveCalled: Array.isArray(calls) ? calls : [],
        logs: Array.isArray(logs) ? logs : [],
        result: result === undefined ? null : result,
    };
}

/** The declared outputs a returned value does NOT carry. */
function missingFrom(result, expectOutputs) {
    if (!expectOutputs.length) return [];
    if (!isObject(result)) return [...expectOutputs];
    return expectOutputs.filter(name => result[name] === undefined);
}

/** A refusal: every exit that is not a body that ran. Never carries `code`. */
function notRepaired(reason, message, attempts, extra = {}) {
    const last = attempts.length ? attempts[attempts.length - 1] : null;
    return {
        ok: false,
        reason,
        message,
        // The field a caller reaches for when it wants the working body. A
        // repair that did not work does not have one — see the header.
        code: null,
        lastCandidate: last ? last.code : null,
        lastError: last ? last.error : null,
        attempts,
        attemptsUsed: attempts.length,
        ...extra,
    };
}

/** A model's answer, in whichever of the two shapes it comes back as. */
function proposedCode(answer) {
    if (typeof answer === 'string') return answer.trim() ? answer : null;
    if (isObject(answer) && typeof answer.code === 'string' && answer.code.trim()) return answer.code;
    return null;
}

/**
 * Test a code body, and repair it while it is broken — at most a few times.
 *
 * @param {string}   code            the body as written.
 * @param {object}   [inputs]        sample inputs for the rehearsal.
 * @param {string[]} [allowedTools]  the tools the body may reach — the same
 *                                   list codeSandbox gates through
 *                                   bridges.allowedTools.
 * @param {object}   [limits]        the body's resource ceilings.
 * @param {string[]} [expectOutputs] the node's declared outputs. A run is
 *                                   green only when the returned object
 *                                   carries every one of them.
 * @param {number}   [maxAttempts]   clamped to 1..ATTEMPT_CEILING.
 * @param {string}   [goal]          what the body is for, passed to the fixer.
 * @param {function} [onProgress]    ({ type, detail }) per turn, like
 *                                   _chatLoop's `emit`.
 *
 * @returns {Promise<{ ok: true, code, repaired, attempts, attemptsUsed, result }
 *                 | { ok: false, reason, message, code: null, lastCandidate, lastError, attempts, attemptsUsed }>}
 */
async function repairCodeBody({
    code,
    inputs = {},
    allowedTools = [],
    limits = {},
    expectOutputs = [],
    maxAttempts = MAX_REPAIR_ATTEMPTS,
    goal = '',
    onProgress = null,
} = {}, deps = defaultDeps()) {
    const { runTest, proposeFix } = deps;
    const emit = (type, detail) => { if (typeof onProgress === 'function') onProgress({ type, detail }); };
    const expected = (Array.isArray(expectOutputs) ? expectOutputs : []).filter(n => typeof n === 'string' && n);
    const bound = Math.max(1, Math.min(Math.round(Number(maxAttempts) || MAX_REPAIR_ATTEMPTS), ATTEMPT_CEILING));

    const attempts = [];
    if (typeof code !== 'string' || !code.trim()) {
        return notRepaired('no_code', 'There is no body to test.', attempts);
    }

    let candidate = code;
    for (let n = 1; n <= bound; n++) {
        emit('testing', { attempt: n, of: bound });

        let evidence;
        try {
            const run = await runTest({ code: candidate, inputs, limits, allowedTools });
            const missing = missingFrom(run ? run.result : undefined, expected);
            evidence = evidenceOf(n, candidate, run || {}, null, missing);
        } catch (e) {
            if (e && e.sandboxUnavailable) {
                // Nothing about the body is known, so nothing about it may be
                // reported — and above all it must not be handed to a model
                // to "fix". This is the one failure that is not the author's.
                return notRepaired('sandbox_unavailable', e.message || String(e), attempts);
            }
            // runCode already says this in the author's own coordinates
            // ("at line 4, column 11"), so it is passed through verbatim
            // rather than re-wrapped: a second sentence around it is a second
            // place for the line number to go wrong.
            evidence = evidenceOf(n, candidate, {}, e && e.message ? e.message : String(e), []);
        }
        attempts.push(evidence);
        emit(evidence.ok ? 'passed' : 'failed', { attempt: n, error: evidence.error, missingOutputs: evidence.missingOutputs });

        if (evidence.ok) {
            return {
                ok: true,
                code: candidate,
                // True only when something was actually changed — a body that
                // worked first time was tested, not repaired, and saying
                // "repaired" about it would be a fix nobody made.
                repaired: n > 1,
                attempts,
                attemptsUsed: n,
                result: evidence.result,
            };
        }

        if (typeof proposeFix !== 'function') {
            return notRepaired('no_repairer', 'The body did not pass, and no repairer was wired in to fix it.', attempts);
        }
        if (n === bound) break;

        emit('repairing', { attempt: n, error: evidence.error });
        let answer;
        try {
            answer = await proposeFix({
                code: candidate,
                error: evidence.error,
                missingOutputs: evidence.missingOutputs,
                wouldHaveCalled: evidence.wouldHaveCalled,
                logs: evidence.logs,
                result: evidence.result,
                attempt: n,
                attempts,
                goal,
                inputs,
                allowedTools,
                expectOutputs: expected,
            });
        } catch (e) {
            // The fixer itself failed. That is not "the code is unfixable",
            // and reporting it as such would send the author rewriting a body
            // whose last run nobody has seen.
            return notRepaired('repairer_failed', `The repairer could not be reached: ${e && e.message ? e.message : String(e)}`, attempts);
        }

        const next = proposedCode(answer);
        if (!next) {
            return notRepaired('no_proposal', 'The repairer returned no replacement body.', attempts);
        }
        if (next === candidate) {
            // Byte-identical. Running it again produces the same failure, one
            // model call and one isolate later, and a loop that burns its
            // budget on a decision already made reads as progress from the
            // outside. Stop and say which attempt stopped repeating itself.
            return notRepaired('unchanged', 'The repairer handed back the same body, so the next attempt would fail in exactly the same way.', attempts);
        }
        candidate = next;
    }

    return notRepaired(
        'not_repaired',
        `The body still does not pass after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}.`,
        attempts,
    );
}

/**
 * One step replaced wherever it lives, structurally rather than in place.
 *
 * The body of a hand-built node can sit inside a loop body, a parallel branch
 * or a nested layer — the three places customNode.eachCodeStep looks — so a
 * replacement that only scanned the root array would return the node
 * UNCHANGED and report a repair, which is the same lie as returning the last
 * broken body. Matching is by object identity: two steps in one definition
 * can share an id (a layer's `body` and the root's), and repairing the wrong
 * one silently is worse than not repairing at all.
 */
function replaceStep(graph, target, next) {
    if (!isObject(graph)) return graph;
    const mapSteps = (steps) => (Array.isArray(steps) ? steps.map((s) => {
        if (s === target) return next;
        if (!isObject(s)) return s;
        if (s.type === 'loop' && Array.isArray(s.body)) return { ...s, body: mapSteps(s.body) };
        if (s.type === 'parallel' && Array.isArray(s.branches)) return { ...s, branches: s.branches.map(mapSteps) };
        return s;
    }) : steps);
    const out = { ...graph, steps: mapSteps(graph.steps) };
    if (isObject(graph.layers)) {
        out.layers = Object.fromEntries(Object.entries(graph.layers)
            .map(([k, layer]) => [k, isObject(layer) ? { ...layer, steps: mapSteps(layer.steps) } : layer]));
    }
    return out;
}

/**
 * The same loop, asked of a custom node instead of a loose body.
 *
 * Everything the loop needs is already declared on the node — the body, the
 * tools its manifest grants, its ceilings and the outputs it promises — so
 * reading them here rather than making the caller restate them is what keeps
 * "what the node declares" and "what was tested" the same thing. On success
 * the node comes back with the repaired body in place; on failure the node is
 * NOT returned changed, for the reason in the header.
 */
async function repairCustomNode({ definition, inputs = {}, maxAttempts, goal = '', onProgress = null } = {}, deps = defaultDeps()) {
    const { customNodeBody, customNodeContract, sandboxAllowedTools } = require('./customNode');
    const body = customNodeBody(definition);
    if (!body) {
        return notRepaired('no_body', 'This node has no single code body to test — a custom node is exactly one body plus the contract around it.', []);
    }
    const contract = customNodeContract(definition);
    const outcome = await repairCodeBody({
        code: body.code,
        inputs,
        allowedTools: [...sandboxAllowedTools(definition)],
        limits: isObject(body.limits) ? body.limits : {},
        expectOutputs: contract.outputFields,
        maxAttempts,
        goal,
        onProgress,
    }, deps);
    if (!outcome.ok) return outcome;
    return {
        ...outcome,
        definition: replaceStep(definition, body, { ...body, code: outcome.code }),
    };
}

module.exports = {
    repairCodeBody,
    repairCustomNode,
    defaultDeps,
    MAX_REPAIR_ATTEMPTS,
    ATTEMPT_CEILING,
};
