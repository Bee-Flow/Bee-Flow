/**
 * The node rules of validateGraph (./graph.js): the additional triggers and
 * the top-level steps (shape, unique ids, types allowed in this scope), which
 * together give the id set the edge and DAG checks run on; and a contract
 * scope's output contract (layer_output, custom-node manifest).
 */

const { SECONDARY_TRIGGER_KINDS, VALID_STEP_TYPES } = require('./constants');
const { isObject, validatePosition } = require('./helpers');
const { checkBindableStepId } = require('./fieldChecks');
const { checkScheduleTrigger } = require('./graphTrigger');

/** definition.triggers[]: extra entry points (root scope only). */
function checkAdditionalTriggers({ graph, p, pushE, isContractScope, contractNoun, checkPinnedOutput }, ids, stepById) {
    if (isContractScope) {
        pushE({ code: 'triggers.not_supported_here', severity: 'error', path: p('triggers'), message: `A ${contractNoun} cannot declare additional triggers — only the automation root can.`, hint: 'Remove the `triggers` array from this scope.' });
    } else if (!Array.isArray(graph.triggers)) {
        pushE({ code: 'triggers.not_array', severity: 'error', path: p('triggers'), message: '`triggers` must be an array.', hint: 'Remove the field, or set it to an array of additional trigger step objects.' });
    } else {
        for (let i = 0; i < graph.triggers.length; i++) {
            const t = graph.triggers[i];
            // Path carries the trigger ID when present (not the index):
            // the FE maps validation records to canvas nodes by substring-
            // matching the id in `path`, so index-based paths left these
            // badges homeless (C7).
            const at = p(`triggers[${(isObject(t) && typeof t.id === 'string' && t.id) ? t.id : i}]`);
            if (!isObject(t)) { pushE({ code: 'triggers.item_shape', severity: 'error', path: at, message: 'Each additional trigger must be an object.', hint: 'Remove the malformed entry.' }); continue; }
            if (!t.id || typeof t.id !== 'string') { pushE({ code: 'triggers.item_id_missing', severity: 'error', path: at + '.id', message: 'Each additional trigger needs an `id`.', hint: 'Re-add it via the builder tool that generates a stable id.' }); continue; }
            if (ids.has(t.id)) { pushE({ code: 'triggers.item_id_duplicate', severity: 'error', path: at + '.id', message: `Duplicate step id: ${t.id}`, hint: 'Every trigger/step in the automation needs a unique id.' }); continue; }
            // Which kinds may be ADDITIONAL is one constant shared with the
            // builder tools (SECONDARY_TRIGGER_KINDS): webhook, app_event and
            // — since automation_schedules (2026-09) — schedule. manual /
            // form / agent_call / app_trigger only make sense as the one
            // primary entry.
            if (!SECONDARY_TRIGGER_KINDS.has(t.kind)) {
                pushE({ code: 'triggers.kind_unsupported', severity: 'error', path: at + '.kind', message: `Additional trigger "${t.id}": kind must be one of ${[...SECONDARY_TRIGGER_KINDS].map(k => `"${k}"`).join(', ')} (got "${t.kind}").`, hint: 'Manual, form, agent-call and app triggers can only be the automation\'s one primary trigger.' });
                continue;
            }
            // Same can-never-fire guard as the primary trigger (C6).
            if (t.kind === 'app_event' && (!t.appEvent?.provider || !t.appEvent?.event)) {
                pushE({ code: 'trigger.app_event_incomplete', severity: 'error', path: at + '.appEvent', message: `Additional trigger "${t.id}": app-event trigger has no provider/event — it can never fire.`, hint: 'Open the trigger node and pick a provider and event.' });
            }
            // Same cron rules as the primary schedule — a secondary schedule
            // that cannot fire would sit "active" with next_run_at NULL.
            if (t.kind === 'schedule') checkScheduleTrigger(t, at, pushE);
            validatePosition(t.position, at, pushE);
            // Same pin rules as the primary trigger — an extra entry point
            // can be pinned too, and export strips both.
            checkPinnedOutput(t, at, { pushE, isTrigger: true });
            ids.add(t.id);
            stepById.set(t.id, t);
        }
    }
}

/** The top-level steps: shape, unique id, a known type allowed in this scope. */
function checkTopLevelSteps({ graph, scope, p, pushE, pushW, isContractScope, contractNoun }, ids, stepById) {
    for (let i = 0; i < graph.steps.length; i++) {
        const s = graph.steps[i];
        const at = p(`steps[${i}]`);
        if (!isObject(s)) { pushE({ code: 'step.not_object', severity: 'error', path: at, message: 'Each step must be an object.', hint: 'Remove the malformed entry and add a fresh step via builder_add_*.' }); continue; }
        if (!s.id || typeof s.id !== 'string') { pushE({ code: 'step.id_missing', severity: 'error', path: at + '.id', message: 'Each step needs an `id`.', hint: 'Use the id returned from the previous builder_add_* tool result.' }); continue; }
        if (ids.has(s.id)) { pushE({ code: 'step.id_duplicate', severity: 'error', path: at + '.id', message: `Duplicate step id: ${s.id}`, hint: 'Remove the duplicate or call builder_remove_step on one of them.' }); continue; }
        if (!VALID_STEP_TYPES.has(s.type)) { pushE({ code: 'step.unknown_type', severity: 'error', path: at + '.type', message: `Step ${s.id}: unknown type "${s.type}".`, hint: `Use one of: ${[...VALID_STEP_TYPES].join(', ')}.` }); continue; }
        // Approval steps pause the run and resume by PARENT-graph step id —
        // a pause inside a layer/Step sub-graph has no resumable address. The
        // runner enforces this too (execApproval throws inside layers).
        if (isContractScope && s.type === 'approval') {
            pushE({ code: 'layer.approval_forbidden', severity: 'error', path: at + '.type', message: `Step ${s.id}: approval steps are not supported inside a ${contractNoun}.`, hint: `Move the approval to the parent flow, before or after the call to this ${contractNoun}.` });
            continue;
        }
        // A `return_to_app` ends the WHOLE run and hands its instructions to
        // the Studio App that started it. Inside a flowlet/Step there is no
        // such app to hand them to — a contract scope returns to its CALLER,
        // which is a step in another graph, not a screen. Same argument the
        // two rules around this one make: a sub-graph has no address for
        // something that happens outside it.
        if (isContractScope && s.type === 'return_to_app') {
            pushE({ code: 'layer.return_to_app_forbidden', severity: 'error', path: at + '.type', message: `Step ${s.id}: "Back to the app" steps are not supported inside a ${contractNoun}.`, hint: `A ${contractNoun} returns to whatever called it. Move the step to the automation's main flow, after the call to this ${contractNoun}.` });
            continue;
        }
        // Same reason for form pages, which pause identically.
        if (isContractScope && s.type === 'form_page') {
            pushE({ code: 'layer.form_page_forbidden', severity: 'error', path: at + '.type', message: `Step ${s.id}: form steps are not supported inside a ${contractNoun}.`, hint: `Move the form step to the parent flow, before or after the call to this ${contractNoun}.` });
            continue;
        }
        // v1: a Step cannot call another Step (cross-row recursion can't be
        // statically checked). Inline flowlets and nested-in-automation calls
        // remain fine; only scope='block' forbids it.
        if (scope === 'block' && s.type === 'call_block') {
            pushE({ code: 'block.nested_call_forbidden', severity: 'error', path: at + '.type', message: `Step ${s.id}: a Step cannot contain another Step (call_block) yet.`, hint: 'Inline the logic, or compose Steps at the automation level instead.' });
            continue;
        }
        validatePosition(s.position, at, pushE);
        checkBindableStepId(s, at, pushW);
        ids.add(s.id);
        stepById.set(s.id, s);
    }
}

/** Every node id (triggers and top-level steps) and the node behind each. */
function collectGraphNodes(ctx) {
    const { graph, trigger } = ctx;
    // Additional triggers (definition.triggers[] — webhook/app_event only,
    // root scope only). `definition.trigger` stays the sole PRIMARY trigger;
    // this array holds EXTRA entry points, each still routed through
    // ordinary edges out of its own id (added to `ids` below so edge
    // references and topoOrder see it as another root — Kahn's algorithm
    // already seeds from every in-degree-0 node, not just one, so no cycle-
    // check changes are needed beyond including these ids in the graph).
    const ids = new Set([trigger.id]);
    const stepById = new Map();
    if (trigger.id) stepById.set(trigger.id, trigger);
    if (graph.triggers !== undefined) checkAdditionalTriggers(ctx, ids, stepById);
    checkTopLevelSteps(ctx, ids, stepById);
    return { ids, stepById };
}

/** A layer/Step's output contract, and a custom node's declared outputs and manifest. */
function checkContractOutputs({ graph, scope, p, pushE, pushW, isContractScope, contractNoun }) {
    // Layer output contract: exactly one layer_output per layer. Zero is a
    // degenerate-but-runnable layer (returns the last step's output) →
    // warning; more than one is ambiguous → error. At the ROOT, layer_output
    // steps stay legal (orphan layers converted to automations keep theirs).
    if (isContractScope) {
        const outs = graph.steps.filter(s => isObject(s) && s.type === 'layer_output');
        if (outs.length === 0) {
            pushW({ code: 'layer.no_output', severity: 'warning', path: p('steps'), message: `${contractNoun} has no layer_output step — callers receive the last step\'s raw output.`, hint: 'Add a layer_output step with explicit fields so it has a stable output contract.' });
        } else if (outs.length > 1) {
            pushE({ code: 'layer.multiple_outputs', severity: 'error', path: p('steps'), message: `${contractNoun} has ${outs.length} layer_output steps — the output contract is ambiguous.`, hint: 'Keep exactly one layer_output step; merge the branches into it.' });
        }
    }

    // A Step whose body is CODE is a custom node, and it answers to a stricter
    // contract than the warning above (automation/customNode.js). The
    // difference is not pedantry: a layer without declared outputs still runs
    // and hands back its last step's raw output, but a custom node is picked
    // from a palette and bound to BY FIELD NAME — with nothing declared the
    // binding picker has no rows, every `steps.<id>.output.<field>` downstream
    // resolves to undefined, and the automation saves, runs green and writes
    // nothing. Its capability manifest is checked here too, because the reach
    // of a code body is a tool name inside a string and the graph cannot see
    // it; codeSandbox enforces exactly these names at run time, so a manifest
    // that disagrees with the body's allow-list is a promise nobody keeps.
    //
    // Only in a contract scope, and only when a code body is actually there:
    // a plain Step of ordinary steps is not a custom node and must keep the
    // warning it has always had, not inherit an error it never agreed to.
    if (scope === 'block') {
        const { isCustomNodeDefinition, validateCustomNode } = require('../customNode');
        if (isCustomNodeDefinition(graph)) {
            for (const issue of validateCustomNode(graph)) {
                pushE({
                    code: `custom_node.${issue.code}`,
                    severity: 'error',
                    path: issue.path ? p(issue.path) : p('steps'),
                    message: issue.message,
                    hint: issue.hint,
                });
            }
        }
    }
}

module.exports = { collectGraphNodes, checkContractOutputs };
