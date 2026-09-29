/**
 * The steps that decide which way a run goes — `condition` and `switch`, and
 * `guard`, which routes on what the Privacy Shield's detector found — plus the
 * detector settings `guard` shares with `tokenize`, which scans the same way
 * but replaces what it finds instead of branching on it.
 *
 * The edge-dependent halves (is a branch actually wired?) are TOP-LEVEL only:
 * a loop body or a parallel branch is a linear step array with no edges of its
 * own — the runtime synthesizes brancher-aware chains there itself.
 */

const { parseExpr, TOPIC_HOST_SPEC } = require('../../expr');

// Rules that decide a route may ask "is about" (shared/expr/topics.mjs);
// a switch's step-level VALUE expression may not, it is not a rule.
const TOPICS = { host: TOPIC_HOST_SPEC };
const { isObject } = require('../helpers');
const { piiCategoryIds } = require('../piiCategories');
const { RESERVED_PROTO_KEYS } = require('../constants');

function checkCondition(ctx, step, at) {
    const { pushE } = ctx;
    if (step.type === 'condition') {
        if (!step.expr || typeof step.expr !== 'string') pushE({ code: 'condition.expr_missing', severity: 'error', path: at + '.expr', message: `Step ${step.id}: condition requires \`expr\`.`, hint: 'Provide a restricted-grammar expression like `steps.x.output.count > 0`.' });
        else {
            try { parseExpr(step.expr, TOPICS); }
            catch (e) { pushE({ code: 'condition.expr_parse', severity: 'error', path: at + '.expr', message: `Step ${step.id}: condition expr parse error — ${e.message}`, hint: 'Restricted grammar only — no function calls, assignments, or templates.' }); }
        }
    }
}

function checkBranchWiring(ctx, step, at) {
    const { pushE, pushW, graph, nested } = ctx;
    // then/else wiring, shared by the two steps that route on a yes/no
    // answer. A guard whose "personal data" branch goes nowhere is the
    // whole point of the step landing on the floor, so it is checked the
    // same way — with its own wording, because "condition has no then edge"
    // tells a guard author nothing.
    //
    // Nested bodies have no edges (the runtime chains them), so this is a
    // top-level rule only.
    if ((step.type === 'condition' || step.type === 'guard') && !nested) {
        const isGuard = step.type === 'guard';
        const labels = new Set(graph.edges.filter(e => e.from === step.id).map(e => e.label));
        if (!labels.has('then') && !labels.has('else')) {
            // For a GUARD this is a warning, not an error. You drop the node
            // first and wire the alert second, and every save in between
            // goes through this validator — an error there makes the
            // intermediate state unsaveable, so the canvas holds a node the
            // stored definition does not, and the next action fails with
            // `runPartial: step … not found in definition`. Nothing unsafe
            // happens meanwhile: an unwired guard just ends the run, and the
            // runner says so when it had a finding to pass on.
            (isGuard ? pushW : pushE)(isGuard
                ? { code: 'guard.dead_branch', severity: 'warning', path: at + '.edges', message: `Step ${step.id}: this guard has no branch wired yet — nothing happens whether personal data is found or not.`, hint: 'Wire the "personal data" branch to what should happen (an alert, a Stop and error).' }
                : { code: 'condition.dead_branch', severity: 'error', path: at + '.edges', message: `Step ${step.id}: condition has no 'then' or 'else' edges — both branches dead-end.`, hint: `Append the next step with afterStepId:"${step.id}" (the edge auto-labels then, then else), or wire EXISTING steps onto the branches with builder_update_step({stepId:"${step.id}", patch:{thenStepId:"<id>", elseStepId:"<id>"}}).` });
        } else if (!labels.has('then') || !labels.has('else')) {
            // One-sided is legitimate for a guard — "alert me when there is
            // personal data, otherwise stop" is a complete routine — so it
            // stays a warning there too, worded as a check rather than a fault.
            pushW(isGuard
                ? { code: 'guard.partial_branch', severity: 'warning', path: at + '.edges', message: `Step ${step.id}: guard has only the ${labels.has('then') ? '"personal data"' : '"clean"'} branch wired — the other ends the run.`, hint: 'That is fine if it is what you meant; wire both to keep the routine going either way.' }
                : { code: 'condition.partial_branch', severity: 'warning', path: at + '.edges', message: `Step ${step.id}: condition has only one branch wired — the other will dead-end.`, hint: `Wire the "${labels.has('then') ? 'else' : 'then'}" branch: append the next step with afterStepId:"${step.id}", branch:"${labels.has('then') ? 'else' : 'then'}", or MOVE an existing step there with builder_update_step({stepId:"<that step>", patch:{afterStepId:"${step.id}", branch:"${labels.has('then') ? 'else' : 'then'}"}}). Remove the condition if a one-sided check is intended.` });
        }
    }
}

function checkPrivacyScan(ctx, step, at) {
    const { pushE, pushW } = ctx;
    // The two steps that scan with the Privacy Shield's detector: the guard
    // branches on the answer, tokenize replaces what it finds. Same scan
    // config, same "tighten, never loosen" rule — so the same checks. Branch
    // wiring is handled above, with the condition's rules.
    if (step.type === 'guard' || step.type === 'tokenize') {
        // A WARNING, not an error, and the difference matters: an error
        // here makes a freshly dropped guard unsaveable, so the canvas
        // shows a node the saved definition does not have — and "Execute"
        // then fails with `runPartial: step … not found in definition`,
        // which explains nothing. The runtime refuses to run an unbound
        // guard (execGuard), so nothing can pass quietly; this only lets
        // the author save and come back to it.
        if (!step.sourceRef || typeof step.sourceRef !== 'string') {
            pushW({ code: `${step.type}.sourceRef_missing`, severity: 'warning', path: at + '.sourceRef', message: `Step ${step.id}: this step has nothing to scan yet.`, hint: 'Pick a value from an earlier step — an email body, a document\'s text, a form answer. The run fails until you do.' });
        }
        if (step.categories !== undefined && step.categories !== null) {
            if (!Array.isArray(step.categories)) {
                pushE({ code: `${step.type}.categories_invalid`, severity: 'error', path: at + '.categories', message: `Step ${step.id}: ${step.type}.categories must be an array of category ids.`, hint: 'Leave it out to use everything the organisation looks for.' });
            } else {
                const known = piiCategoryIds();
                const unknown = known
                    ? step.categories.filter(c => typeof c !== 'string' || !known.has(c))
                    : step.categories.filter(c => typeof c !== 'string');
                // A typo'd category would narrow the scan to nothing and
                // report clean — the one failure this step must never have.
                if (unknown.length) pushE({ code: `${step.type}.category_unknown`, severity: 'error', path: at + '.categories', message: `Step ${step.id}: unknown PII category ${unknown.map(c => JSON.stringify(c)).join(', ')}.`, hint: known ? `Known categories: ${[...known].join(', ')}.` : 'Use a category id from the Privacy Shield settings.' });
            }
        }
        if (step.confidence !== undefined && step.confidence !== null
            && (typeof step.confidence !== 'number' || !(step.confidence >= 0 && step.confidence <= 1))) {
            pushE({ code: `${step.type}.confidence_invalid`, severity: 'error', path: at + '.confidence', message: `Step ${step.id}: ${step.type}.confidence must be a number between 0 and 1.`, hint: 'Leave it out to use the organisation\'s threshold; a higher value only reports what the detector is more sure about.' });
        }
        if (step.type === 'guard' && step.onFound !== undefined && (step.onFound === null || typeof step.onFound !== 'object' || Array.isArray(step.onFound))) {
            pushE({ code: `${step.type}.onFound_invalid`, severity: 'error', path: at + '.onFound', message: `Step ${step.id}: guard.onFound must be an object.`, hint: 'e.g. { "stop": true, "mask": false }.' });
        }
    }
}

function checkSwitch(ctx, step, at) {
    const { pushE, pushW, graph, nested } = ctx;
    if (step.type === 'switch') {
        // Two case shapes coexist (see engine.js's switchCaseRule):
        //   RULE  { name, expr }  — its own condition, no step-level expr
        //   VALUE { name, value } — compared against the step's expr
        // and `arrayRef` makes the whole step work through a LIST, where
        // each rule sees the row as `item`. The step-level `expr` is only
        // required when a VALUE case actually needs something to compare
        // against — demanding it from a pure rule switch (what the unified
        // Filter & Route editor writes) would 400 every save.
        const isRuleCase = (c) => isObject(c) && typeof c.expr === 'string' && c.expr.trim().length > 0;
        const switchList = typeof step.arrayRef === 'string' && step.arrayRef.trim().length > 0;
        const switchCases = Array.isArray(step.cases) ? step.cases : [];
        const needsStepExpr = !switchList && (switchCases.length === 0 || switchCases.some(c => !isRuleCase(c)));
        // BFSF-356 fan-out opt-in. ABSENT (or null) means first-match-wins,
        // which is how every switch ever saved behaves — so no stored
        // definition can trip this rule, and it stays an INTEGRITY error
        // that blocks a draft save too. A typo like 'al' or 'any' must not
        // silently keep the OPPOSITE semantic the author asked for (the
        // engine's own fallback to 'first' is defence in depth, not the
        // place to report the mistake): duplicate emails/tickets/API
        // writes, or the absence of them, is exactly the class of surprise
        // this ticket is about.
        if (step.matchMode != null && step.matchMode !== 'first' && step.matchMode !== 'all') {
            pushE({ code: 'switch.matchMode_invalid', severity: 'error', path: at + '.matchMode', message: `Step ${step.id}: \`matchMode\` must be "first" or "all" (got ${JSON.stringify(step.matchMode)}).`, hint: '"first" (the default when the field is absent) sends each record down the first matching output only; "all" asks every output independently, so a record can travel several.' });
        }
        if (step.arrayRef != null && typeof step.arrayRef !== 'string') {
            pushE({ code: 'switch.arrayRef_type', severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: switch \`arrayRef\` must be a path string.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.items`.' });
        } else if (step.arrayRef === '') {
            // The step is IN list mode (the key is present) but the source
            // is still blank — same treatment as the collection ops: an
            // amber draft warning that blocks activation, never a save
            // failure while the user is picking the list.
            pushE({ code: 'switch.arrayRef_missing', severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: this step works through a list but no source list is set.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.items`.' });
        }
        if (needsStepExpr && (!step.expr || typeof step.expr !== 'string')) pushE({ code: 'switch.expr_missing', severity: 'error', path: at + '.expr', message: `Step ${step.id}: switch requires \`expr\`.`, hint: 'Restricted-grammar expression whose value is matched against each case — or give every case its own `expr` rule.' });
        else if (step.expr && typeof step.expr === 'string') { try { parseExpr(step.expr); } catch (e) { pushE({ code: 'switch.expr_parse', severity: 'error', path: at + '.expr', message: `Step ${step.id}: switch expr parse error — ${e.message}`, hint: 'Restricted grammar only.' }); } }
        if (!Array.isArray(step.cases) || step.cases.length === 0) pushE({ code: 'switch.cases_missing', severity: 'error', path: at + '.cases', message: `Step ${step.id}: switch requires at least one case.`, hint: 'cases: [{ name: "...", value: ... }] or [{ name: "...", expr: "..." }].' });
        else {
            const seenNames = new Set();
            for (let i = 0; i < step.cases.length; i++) {
                const c = step.cases[i];
                if (!isObject(c) || !c.name || typeof c.name !== 'string') { pushE({ code: 'switch.case_shape', severity: 'error', path: at + `.cases[${i}]`, message: `Step ${step.id}: switch case ${i} missing name.`, hint: 'Each case needs { name, value } or { name, expr }.' }); continue; }
                if (isRuleCase(c)) {
                    try { parseExpr(c.expr, TOPICS); }
                    catch (e) { pushE({ code: 'switch.case_expr_parse', severity: 'error', path: at + `.cases[${i}].expr`, message: `Step ${step.id}: case "${c.name}" rule parse error — ${e.message}`, hint: 'Restricted grammar only. Inside a list the current row is `item`.' }); }
                }
                if (c.name === 'default') { pushE({ code: 'switch.case_name_reserved', severity: 'error', path: at + `.cases[${i}].name`, message: `Step ${step.id}: case name "default" is reserved; use \`defaultBranch\` instead.`, hint: 'Set defaultBranch on the switch step to route unmatched values.' }); continue; }
                // Same reserved-name hole the set/layer_output/parse_json
                // field names already close: in collection mode execSwitch
                // buckets rows into a plain object keyed by case name, and
                // assigning `__proto__` never creates an own key — the case
                // matched, its rows went nowhere, and the run stayed green.
                if (RESERVED_PROTO_KEYS.has(c.name)) { pushE({ code: 'switch.case_name_reserved', severity: 'error', path: at + `.cases[${i}].name`, message: `Step ${step.id}: case name "${c.name}" is reserved — in list mode its rows silently vanish at run time.`, hint: 'Rename the case; __proto__/constructor/prototype cannot be object keys here.' }); continue; }
                if (seenNames.has(c.name)) pushE({ code: 'switch.case_name_duplicate', severity: 'error', path: at + `.cases[${i}].name`, message: `Step ${step.id}: duplicate switch case name "${c.name}".`, hint: 'Each case name must be unique.' });
                seenNames.add(c.name);
            }
            // Edge-wiring rules are top-level only: a body switch is a
            // pass-through in the runtime's synthesized linear chain and
            // has no edges of its own — running these there would flag
            // every body switch as no_branches.
            if (!nested) {
                const out = graph.edges.filter(e => e.from === step.id);
                // An outgoing case edge carries its case name as either
                // `caseName` OR `label: "case:<name>"` (both shapes exist —
                // see layout.js). Read both so validation matches how the
                // runtime actually routes.
                const edgeCaseName = (e) => {
                    if (e.caseName) return e.caseName;
                    if (typeof e.label === 'string' && e.label.startsWith('case:')) return e.label.slice(5);
                    return null;
                };
                const edgeCaseNames = out.map(edgeCaseName).filter(Boolean);
                const caseLabels = new Set(edgeCaseNames);
                const declared = new Set(step.cases.map(c => c.name));
                // A defaultBranch only counts as an escape hatch when the case
                // it names actually has an outgoing edge — a merely-NAMED
                // default used to suppress no_branches/partial_branches while
                // unmatched runs silently dead-ended at run time (A4).
                const hasDefaultEdge = caseLabels.has('default')
                    || (!!step.defaultBranch && caseLabels.has(step.defaultBranch));
                if (step.defaultBranch && declared.has(step.defaultBranch) && !caseLabels.has(step.defaultBranch)) {
                    pushW({ code: 'switch.defaultBranch_unwired', severity: 'warning', path: at + '.defaultBranch', message: `Step ${step.id}: unmatched values route to case "${step.defaultBranch}", which has no outgoing edge.`, hint: 'Wire that case on the canvas, or wire the default port — unmatched runs fall back to it.' });
                }
                if (step.defaultBranch && caseLabels.has('default')) {
                    pushW({ code: 'switch.default_edge_shadowed', severity: 'warning', path: at + '.defaultBranch', message: `Step ${step.id}: both \`defaultBranch\` and a wired default port exist — the default port only fires when the "${step.defaultBranch}" case has no edge.`, hint: 'Pick one: clear defaultBranch to use the default port, or unwire the default port.' });
                }
                // A case edge whose name matches no declared case (and isn't the
                // reserved 'default') is a typo that silently dead-ends at run
                // time — the runtime routes by exact case name.
                for (const name of new Set(edgeCaseNames)) {
                    if (name !== 'default' && !declared.has(name)) {
                        pushE({ code: 'switch.case_edge_unknown', severity: 'error', path: at + '.edges', message: `Step ${step.id}: switch edge routes case "${name}" which is not a declared case.`, hint: 'Fix the caseName to match a declared case, or add the case. Typos dead-end silently at run time.' });
                    }
                }
                const wired = step.cases.filter(c => caseLabels.has(c.name)).length;
                // Only truly dead if NOTHING is wired — a switch routed only
                // through its default branch is valid (the default handles all
                // unmatched values), so don't false-flag it.
                if (wired === 0 && !hasDefaultEdge) pushE({ code: 'switch.no_branches', severity: 'error', path: at + '.edges', message: `Step ${step.id}: switch has no case or default edges wired — all branches dead-end.`, hint: 'Add edges from this switch with caseName matching each case, or wire a default branch.' });
                else if (wired < step.cases.length && !hasDefaultEdge) pushW({ code: 'switch.partial_branches', severity: 'warning', path: at + '.edges', message: `Step ${step.id}: only ${wired}/${step.cases.length} switch cases have outgoing edges and there is no default.`, hint: 'Wire each case to its next step, add a default, or remove unused cases.' });
            }
        }
    }
}

module.exports = { checkCondition, checkBranchWiring, checkPrivacyScan, checkSwitch };
