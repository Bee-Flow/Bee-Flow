// @typecheck
/**
 * The edge rules of validateGraph (./graph.js): every edge references known
 * nodes, carries a label that fires, leaves no brancher unlabelled and nothing
 * after a terminal step; plus the cosmetic colour keys.
 */

const {
    KNOWN_EDGE_LABELS, EDGE_COLOR_KEYS,
    ON_ERROR_SOURCE_TYPES, ON_ERROR_FORBIDDEN_SOURCE_TYPES, BRANCHER_TYPES,
    TERMINAL_STEP_TYPES,
} = require('./constants');
const { isObject } = require('./helpers');

/**
 * How an edge AFTER a terminal step is reported: per type, because the
 * SEVERITY differs per type while the rule does not.
 *
 * `stop_error` predates this rule, so there it stays a WARNING:
 * existing definitions must keep saving and activating, the author is just
 * finally told (B9). `return_to_app` is new (there is no yesterday to
 * preserve), so there it is an ERROR. Completeness-listed though
 * (validate/completenessCodes.js): building halfway is fine, going live is not.
 *
 * Every terminal type MUST have a rule here; the drift test
 * (automation/validate/terminalSteps.test.js) fails on a type that
 * TERMINAL_STEP_TYPES names and this table does not.
 */
const TERMINAL_EDGE_RULES = new Map([
    ['stop_error', {
        code: 'edge.after_stop_error', severity: 'warning',
        message: (from, to) => `Edge ${from} → ${to}: steps after Stop-and-Error can never run.`,
        hint: 'Stop-and-Error halts the run. Remove this edge, or move the downstream steps before the stop.',
    }],
    ['return_to_app', {
        code: 'edge.after_terminal', severity: 'error',
        message: (from, to) => `Edge ${from} → ${to}: steps after Back-to-the-app can never run.`,
        hint: 'Back to the app ends the run and hands the app its instructions. Remove this edge, or move the downstream steps before it.',
    }],
]);

/** One edge, at path `at`. */
function checkEdge({ trigger, pushE, pushW }, e, at, ids, stepById) {
    if (!isObject(e) || !e.from || !e.to) { pushE({ code: 'edge.shape', severity: 'error', path: at, message: 'Each edge needs `from` and `to`.', hint: 'Re-add the edge via the relevant builder_add_* tool which fills both fields.' }); return; }
    if (!ids.has(e.from)) pushE({ code: 'edge.unknown_from', severity: 'error', path: at + '.from', message: `Edge from unknown node: ${e.from}`, hint: 'Either remove the edge or add the missing step.' });
    if (!ids.has(e.to))   pushE({ code: 'edge.unknown_to',   severity: 'error', path: at + '.to',   message: `Edge to unknown node: ${e.to}`,   hint: 'Either remove the edge or add the missing step.' });
    // A note (BFSF-411) is a canvas annotation, never a flow node — the
    // guarantee execution.js/execFlow.js build on is that it carries no
    // edges at all. Enforced here too (not just left to the canvas/builder
    // tools) so a hand-edited or AI-authored definition can never smuggle
    // one into the graph.
    if (ids.has(e.from) && stepById.get(e.from)?.type === 'note') {
        pushE({ code: 'edge.note_no_edges', severity: 'error', path: at + '.from', message: `Edge ${e.from} → ${e.to}: a note is a canvas annotation and cannot be wired into the flow.`, hint: 'Remove this edge — notes never connect to anything.' });
    }
    if (ids.has(e.to) && stepById.get(e.to)?.type === 'note') {
        pushE({ code: 'edge.note_no_edges', severity: 'error', path: at + '.to', message: `Edge ${e.from} → ${e.to}: a note is a canvas annotation and cannot be wired into the flow.`, hint: 'Remove this edge — notes never connect to anything.' });
    }
    if (typeof e.label === 'string' && e.label) {
        // 'case:<name>' labels are validated against the switch's case
        // names by the switch-step block below; everything else must be
        // one of the runner's routed labels or it never fires.
        if (!KNOWN_EDGE_LABELS.has(e.label) && !e.label.startsWith('case:')) {
            pushW({ code: 'edge.label_unknown', severity: 'warning', path: at + '.label', message: `Edge ${e.from} → ${e.to} has unknown label "${e.label}" — it will never fire.`, hint: 'Use one of: then, else, on_success, on_error, case:<switch-case-name>, or remove the label so the edge fires on success.' });
        }
        if (e.label === 'on_error' && ids.has(e.from)) {
            const srcType = e.from === trigger.id ? 'trigger' : stepById.get(e.from)?.type;
            if (ON_ERROR_FORBIDDEN_SOURCE_TYPES.has(srcType)) {
                pushE({ code: 'edge.error_label_invalid', severity: 'error', path: at + '.label', message: `Edge ${e.from} → ${e.to}: a ${srcType === 'trigger' ? 'trigger' : `"${srcType}" step`} cannot have an on_error branch.`, hint: 'Error branches start from steps that can fail at run time (integration_action, ai_step, code, call_layer, loop, parallel, notification, wait). Remove this edge or move it to the failing step.' });
            } else if (!ON_ERROR_SOURCE_TYPES.has(srcType)) {
                pushW({ code: 'edge.error_label_unlikely', severity: 'warning', path: at + '.label', message: `Edge ${e.from} → ${e.to}: "${srcType}" steps are pure data operations that rarely fail — this error branch will likely never run.`, hint: 'Error branches are meant for steps that talk to external systems (integration_action, ai_step, code, call_layer, …). Keep it only if you rely on a structured failure like collection_too_large.' });
            }
        }
    }
    // An UNLABELLED edge out of a brancher never fires: the runtime routes
    // every BRANCHER_TYPES step by branch label only. It draws from the
    // first port and looks like a working connection (B5). The canvas now
    // refuses to create these; JSON/AI authoring could still. Completeness-
    // listed: existing drafts keep saving, activation blocks.
    // guard is in the set for the same reason condition is — runDag routes
    // a guard by the SAME then/else labels — omitting it would let
    // an unlabelled guard edge save, activate and silently
    // never fire.
    if (!e.label && e.caseName == null && ids.has(e.from)) {
        const srcType = e.from === trigger.id ? 'trigger' : stepById.get(e.from)?.type;
        if (BRANCHER_TYPES.has(srcType)) {
            const hint = srcType === 'switch'
                ? 'Delete it and drag from a case port (or the default port) instead.'
                : srcType === 'guard'
                    ? 'Delete it and drag from the "personal data" or the "clean" port instead.'
                    : 'Delete it and drag from the then/else port instead.';
            pushE({ code: 'edge.branch_unlabelled', severity: 'error', path: at, message: `Edge ${e.from} → ${e.to} leaves a ${srcType} with no branch label — it will never fire.`, hint });
        }
    }
    // Anything after a TERMINAL step is dead by definition — the runner
    // ends its walk there (runDag.js), so an edge out of one is a line the
    // canvas draws and nothing ever follows. Driven off the one shared
    // TERMINAL_STEP_TYPES set so this rule and the runner cannot disagree
    // about which steps end a run; the severity comes from the per-type
    // table at the top of this file.
    if (ids.has(e.from) && TERMINAL_STEP_TYPES.has(stepById.get(e.from)?.type)) {
        const rule = TERMINAL_EDGE_RULES.get(stepById.get(e.from).type);
        // No table entry = a terminal soort nobody wrote a message for.
        // Report it anyway rather than let the edge through silently: an
        // unknown terminal narrows to "still terminal".
        const rec = rule
            ? { code: rule.code, severity: rule.severity, path: at, message: rule.message(e.from, e.to), hint: rule.hint }
            : { code: 'edge.after_terminal', severity: 'error', path: at, message: `Edge ${e.from} → ${e.to}: steps after a "${stepById.get(e.from).type}" step can never run.`, hint: 'That step ends the run. Remove this edge, or move the downstream steps before it.' };
        (rec.severity === 'warning' ? pushW : pushE)(rec);
    }
    // Cosmetic connection colour — a palette KEY, picked in the canvas
    // (list mirrors agent-hub .../Builder/flow/edgeColors.js). Unknown
    // values render as the default line colour, so a typo (AI/JSON
    // authoring) is a warning and never blocks a save.
    if (e.color !== undefined && !EDGE_COLOR_KEYS.has(e.color)) {
        pushW({ code: 'edge.color_unknown', severity: 'warning', path: at + '.color', message: `Edge ${e.from} → ${e.to} has unknown colour ${JSON.stringify(e.color)} — the builder will show the default line colour.`, hint: `Use one of: ${[...EDGE_COLOR_KEYS].join(', ')}, or remove the color field.` });
    }
}

/** The PII line-colour overrides: palette keys only (warnings). */
function checkPiiLineColors({ graph, p, pushW }) {
    if (graph.piiLineColors !== undefined) {
        if (!isObject(graph.piiLineColors)) {
            pushW({ code: 'piiLineColors.shape', severity: 'warning', path: p('piiLineColors'), message: 'piiLineColors must be an object of { <PII group>: <colour key> } — ignoring it.', hint: 'Set PII colours from the canvas: Lines → the rules panel.' });
        } else {
            for (const [group, key] of Object.entries(graph.piiLineColors)) {
                if (!EDGE_COLOR_KEYS.has(key)) {
                    pushW({ code: 'piiLineColors.color_unknown', severity: 'warning', path: p(`piiLineColors.${group}`), message: `PII line colour for "${group}" is ${JSON.stringify(key)} — not a palette key, the default colour will be used.`, hint: `Use one of: ${[...EDGE_COLOR_KEYS].join(', ')}, or remove the entry.` });
                }
            }
        }
    }
}

/** Every edge of the graph, then the PII line colours. */
function checkEdges(ctx, ids, stepById) {
    const { graph, p } = ctx;
    for (let i = 0; i < graph.edges.length; i++) {
        const e = graph.edges[i];
        const at = p(`edges[${i}]`);
        checkEdge(ctx, e, at, ids, stepById);
    }
    // piiLineColors — the automation's PII group → colour overrides (Lines
    // panel). Same posture as edge.color: cosmetic, values must be palette
    // keys, anything else falls back to the default colour with a warning.
    checkPiiLineColors(ctx);
}

module.exports = { checkEdges, TERMINAL_EDGE_RULES };
