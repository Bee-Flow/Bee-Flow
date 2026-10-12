/**
 * Builder tools — function-calling schemas the conversational builder agent
 * uses to mutate a draft automation. Each tool has:
 *   - schema (OpenAI/Anthropic function-call format) injected into the LLM
 *   - apply() implementation that mutates a Draft instance and returns
 *     a small JSON snippet describing the change.
 *
 * Drafts are kept per (userId, builderSessionId) and persisted to
 * automations(is_draft=TRUE) after every successful mutation, so a
 * page refresh recovers the work.
 *
 * The apply* implementations live in ./builderTools/ by family (mirrors
 * appStudio/builderTools/ and builderPrompt/); this facade keeps the module
 * path, the dispatch table and the exact public surface.
 */

const { summariseDefinition } = require('./summarise');

// §WS5 — trigger catalog data + tool schemas live in ./builderTools/.
const { TRIGGER_FIELDS_BY_EVENT, TRIGGER_OUTPUT_SAMPLES, buildTriggerOutputsCatalog } = require('./builderTools/triggerCatalog');
const { TOOL_SCHEMAS } = require('./builderTools/schemas');

const { validateAndFixBindings } = require('./builderTools/bindings');
const { emptyDefinition, applyWireErrorBranch, findStepAnywhere } = require('./builderTools/draftGraph');
const {
    applyTrigger, applyAddAction, applyAddAi, applyAddCondition, applyAddLoop,
    applyAddCode, applyAddNotification, applyAddHttpRequest,
    applyAddGenerateDocument, applyAddFillDocument, applyAddSlide, applyAddPresentation, applyAddDataExtraction, applyAddSet, applyAddDateTime, applyAddWait,
    applyAddFormPage, applyAddStopError, applyAddSwitch, applyAddFilter,
    applyAddLimit, applyAddDedupe, applyAddAggregate, applyAddSummarize,
    applyAddArrayOp,
    applyAddDatatable,
    applyAddKnowledgeWrite,
    applyAddNote,
} = require('./builderTools/stepBuilders');
const {
    generateLayerKey, makeLayerSkeleton, sanitizeLayerParams,
    applyCreateLayer, applySetLayerContract, applyAddCallLayer,
} = require('./builderTools/layers');
const { applyInlineLayer } = require('./builderTools/inlineLayer');
const { applyAddApproval } = require('./builderTools/approval');
const { applyCreateDatatable } = require('./builderTools/datatableCreate');
const { applyAddTrigger, applyUpdateTrigger } = require('./builderTools/triggers');
const {
    PATCHABLE_FIELDS, applyUpdateStep, applyUpdateSteps, applyReplaceStep, applyRemoveStep,
} = require('./builderTools/stepEditing');
const { applyAddSteps } = require('./builderTools/addSteps');
const { applyInspectTool } = require('./builderTools/inspection');
const { followAddedSteps } = require('./builderTools/routeFollowDraft');
const {
    summariseDraftSteps, renderStepIdLine, renderEdgeLine,
    compactSample, compactDryRunForModel, truncateToolResultJson,
} = require('./builderTools/modelPayload');
const { persistDraft } = require('./builderTools/persistence');
const { applyRequestDryRun } = require('./builderTools/dryRun');
const { canonicalJson, applyPatchOps, describePatch } = require('./builderTools/suggestedPatch');

function applySetMetadata(draft, args) {
    if (typeof args.title === 'string') draft.title = args.title;
    if (typeof args.description === 'string') draft.description = args.description;
    return { title: draft.title, description: draft.description };
}

function applySummarise(draft) {
    const { summary, hasSideEffects } = summariseDefinition(draft);
    return { summary, hasSideEffects };
}

const MUTATING_TOOLS = new Set([
    'builder_propose_trigger', 'builder_add_action', 'builder_add_ai_step',
    // Additional entry points (definition.triggers[]) — root-only.
    'builder_add_trigger', 'builder_update_trigger',
    'builder_add_condition', 'builder_add_loop', 'builder_add_code_step',
    'builder_add_notification', 'builder_remove_step', 'builder_set_metadata',
    // batch append (tempId cross-refs). In CORE_TOOL_NAMES since 2026-09-11 —
    // every profile batches now; see the note there.
    'builder_add_steps',
    // §A in-place editing (no destroy-to-update)
    'builder_update_step', 'builder_update_steps', 'builder_replace_step',
    // Outbound HTTP / webhook call
    'builder_add_http_request',
    'builder_add_generate_document',
    // Fill a DESIGNED document (invoice/quote/letter) and keep the PDF.
    'builder_add_fill_document',
    // A slide (an object) and the deck that turns slides into a .pptx / PDF.
    'builder_add_slide', 'builder_add_presentation',
    // Named, typed fields out of text — on the admin's extraction model.
    'builder_add_data_extraction',
    // n8n-style utility nodes
    'builder_add_set', 'builder_add_datetime', 'builder_add_wait', 'builder_add_form_page',
    'builder_add_approval',
    'builder_add_stop_error', 'builder_add_switch', 'builder_add_call_layer',
    'builder_add_filter', 'builder_add_limit', 'builder_add_dedupe',
    'builder_add_aggregate', 'builder_add_summarize',
    'builder_add_array_op',
    // Rows that outlive the run.
    'builder_add_datatable',
    'builder_add_knowledge_write',
    // Canvas annotation — never wired, never executed (BFSF-411).
    'builder_add_note',
    // inline flowlets
    'builder_create_layer', 'builder_set_layer_contract',
    // Fold a flowlet into the flow that calls it (an approved plan asks for it).
    'builder_inline_layer',
    // §WS4 on-error branches
    'builder_wire_error_branch',
]);

// Mutators after which a refused call meets the SAME graph: title/description
// and a never-wired canvas note. Measured: a byte-identical builder_add_steps
// resent beside a builder_set_metadata every round never climbed past rung 1,
// and the accepted call also reset the route's wasted-round count, so the
// turn ran to the iteration budget instead of stopping after three.
const GRAPH_NEUTRAL_MUTATORS = new Set(['builder_set_metadata', 'builder_add_note']);

// Step-graph mutators that accept scope:'<layerKey>' to operate inside
// definition.layers[<key>] instead of the root flow. Excludes the root-only
// tools (propose_trigger, set_metadata) and the flowlet-management tools
// (create_layer / set_layer_contract take layerKey explicitly).
const SCOPED_GRAPH_TOOLS = new Set(
    [...MUTATING_TOOLS].filter(n => ![
        'builder_propose_trigger', 'builder_set_metadata',
        'builder_add_trigger', 'builder_update_trigger',
        'builder_create_layer', 'builder_set_layer_contract',
    ].includes(n)),
);

// Inject the shared `scope` parameter into every scoped tool's schema so
// the model discovers it without 18 hand-edited copies drifting apart.
for (const t of TOOL_SCHEMAS) {
    if (!SCOPED_GRAPH_TOOLS.has(t.function?.name)) continue;
    t.function.parameters = t.function.parameters || { type: 'object', properties: {} };
    t.function.parameters.properties = t.function.parameters.properties || {};
    t.function.parameters.properties.scope = {
        type: 'string',
        description: "Optional inline-flowlet key — apply this mutation inside definition.layers[<scope>] (that flowlet's own sub-flow) instead of the main flow. Omit for the main flow.",
    };
}

// Per-step iteration: a leaf step can run once per item of an upstream array
// via `forEach` — no wrapping `loop` container. Injected (single source of
// truth) only into the five step types the validator permits; validate.js's
// `foreach.type_unsupported` guards everything else.
const FOREACH_CAPABLE_TOOLS = new Set([
    'builder_add_action', 'builder_add_ai_step', 'builder_add_code_step',
    'builder_add_notification', 'builder_add_set', 'builder_add_http_request',
    // "for each row I found, save one" is the shape this exists for.
    'builder_add_datatable',
    'builder_add_knowledge_write',
    // "read every file, then pull the same fields out of each" — the second
    // step of that pair is this one.
    'builder_add_data_extraction',
]);
for (const t of TOOL_SCHEMAS) {
    if (!FOREACH_CAPABLE_TOOLS.has(t.function?.name)) continue;
    t.function.parameters = t.function.parameters || { type: 'object', properties: {} };
    t.function.parameters.properties = t.function.parameters.properties || {};
    t.function.parameters.properties.forEach = {
        type: 'object',
        description: 'Run this step once per item of an upstream array (no wrapping loop needed). Reference the current item inside this step as `loop.<itemVar>`. THIS IS THE DEFAULT for per-item work, including MULTI-STEP per-item work: chain a second forEach over the first one\'s `output.results` and it still sees its own item (`loop.<v>.item` is the original, `loop.<v>.output` is that item\'s result). Reach for builder_add_loop only when the per-item body must BRANCH or share one source item across two steps.',
        properties: {
            overRef: { type: 'string', description: 'Ref to the upstream array, e.g. "steps.<id>.output.results". Must start with trigger/steps/vars/secrets/loop.' },
            itemVar: { type: 'string', description: 'Name for the current item (default "item"); reference it as loop.<itemVar> inside this step.' },
            maxIterations: { type: 'number', description: 'Optional cap, 1..1000 (default 100).' },
        },
        required: ['overRef'],
    };
}

// §WS4: extend every `branch` enum with 'error' in one place (same
// no-drift rationale as the scope injection above). branch:'error' wires
// the new step onto afterStepId's on_error branch — it runs only when
// that step fails after exhausting its retries.
for (const t of TOOL_SCHEMAS) {
    const b = t.function?.parameters?.properties?.branch;
    if (!b || !Array.isArray(b.enum)) continue;
    if (!b.enum.includes('error')) b.enum.push('error');
    b.description = `${b.description || ''} Pass "error" to wire this step onto afterStepId's on_error branch instead (runs only when that step fails after retries; bind the failure via steps.<afterStepId>.error.message).`.trim();
}

// Mutators where id confusion actually happens: they change the topology
// (rewire/relabel/remove) so the model needs the FULL structured step list
// back. Pure appends only need the compact id line — the new step's shape is
// already in the `added` echo.
const TOPOLOGY_TOOLS = new Set([
    // A new root: the model needs to see it listed beside the primary trigger.
    'builder_add_trigger',
    'builder_remove_step', 'builder_replace_step', 'builder_update_step',
    'builder_update_steps', 'builder_add_condition', 'builder_add_switch',
    'builder_wire_error_branch', 'builder_add_loop', 'builder_set_layer_contract',
    // Replaces one step by the flowlet's whole graph: the model needs the new ids.
    'builder_inline_layer',
    // Introduces a whole new scoped graph (trigger params + layer_output) —
    // the model needs the structured per-layer section, not just ids.
    'builder_create_layer',
    // A batch may contain branching entries and lands the bulk of a build in
    // one call — one full echo here replaces the N echoes the serial flow paid.
    'builder_add_steps',
]);

// ── Public API ──────────────────────────────────────────

/**
 * Apply a tool call, mutating the in-memory draft. Returns a small JSON
 * report describing what changed (becomes the `tool` message back to the
 * LLM and feeds the SSE update to the frontend).
 */
async function applyToolCall(name, args, draftWrap) {
    if (['builder_search_documents','builder_read_document'].includes(name)) return require('../core/documents/documentDiscovery').execute(name,args || {},draftWrap);
    if (MUTATING_TOOLS.has(name)) {
        const issue = require('../core/documents/documentDiscovery').inspectBindings(args,draftWrap,'builder');
        if (issue) return issue;
    }

    // Rung 2 of the ladder (rejectionLadder below): the call that was just
    // rejected comes back unchanged and the rejection carried its own fix —
    // apply the fix and dispatch that. A call the model edited itself no
    // longer matches the signature and is left alone.
    let callArgs = args;
    let repaired = null;
    const prev = draftWrap && typeof draftWrap === 'object' ? draftWrap._lastRejected : null;
    if (prev && prev.patch && prev.count >= 1 && MUTATING_TOOLS.has(name) && isRepeat(prev, name, args)) {
        const { args: patched, applied } = applyPatchOps(args, prev.patch.ops);
        if (applied.length) { callArgs = patched; repaired = applied; }
    }
    const result = await _applyToolCallRaw(name, callArgs, draftWrap, { sent: args });
    // For every mutation, append a live-id reminder so the LLM has the real
    // ids in front of it on the next turn (without it the model fabricated
    // ids like "step_1"). Topology changes echo the full structured list;
    // pure appends get a compact one-liner (~5x cheaper, and it repeats on
    // EVERY mutation so it dominated result tokens on long builds). A route
    // can force the full echo (small/lean profiles) via
    // `draftWrap._resultDetail = 'full'`.
    //
    // A PARTIAL batch — builder_add_steps that built entries 0..i-1 and then
    // refused entry i — is an error result with `added` entries in it. Those
    // steps are in the draft, so the echo rides along: without it the model
    // would resend from index i against a graph it was never shown.
    const partial = !!(result && typeof result === 'object' && result.error && Array.isArray(result.added) && result.added.length);
    if (MUTATING_TOOLS.has(name) && result && typeof result === 'object' && (!result.error || partial)) {
        followAdded(result, callArgs, draftWrap);
        if (TOPOLOGY_TOOLS.has(name) || draftWrap._resultDetail === 'full') {
            result._draftSteps = summariseDraftSteps(draftWrap.def);
        } else {
            result._stepIds = renderStepIdLine(draftWrap.def);
        }
        // The wiring rides on BOTH echoes. Neither carried edges before, so
        // the model was shown a flat list and had to infer the graph — which
        // is how a fan-out got mistaken for a chain and a step ended up
        // reading an output it could never see.
        result._wiring = renderEdgeLine(draftWrap.def);
        // Where did a single append LAND? When afterStepId is omitted the
        // step chains after the current tail — which, right after a
        // condition's first branch step, is that branch step, not the
        // condition. Measured: a model that wanted the other branch re-sent
        // the identical call seven times (each time narrating a `branch` it
        // never passed), removing the step in between. Naming the landing spot
        // and the one call that moves it is the information it lacked.
        if (result.added && !Array.isArray(result.added) && result.added.id
            && name !== 'builder_add_steps' && !(callArgs && callArgs.afterStepId)) {
            const g = (callArgs && typeof callArgs.scope === 'string' && callArgs.scope) ? draftWrap.def.layers?.[callArgs.scope] : draftWrap.def;
            const inc = (g?.edges || []).find(e => e && e.to === result.added.id);
            if (inc) {
                result.placedAfter = inc.label ? `${inc.from} (${inc.label})` : inc.from;
                const half = (g.steps || []).find(s => {
                    if (!s || s.type !== 'condition') return false;
                    const l = new Set((g.edges || []).filter(e => e && e.from === s.id).map(e => e.label));
                    return l.has('then') !== l.has('else');
                });
                if (half && inc.from !== half.id) {
                    const hasThen = (g.edges || []).some(e => e && e.from === half.id && e.label === 'then');
                    const missing = hasThen ? 'else' : 'then';
                    result._hint = `afterStepId was omitted, so this step was chained after ${inc.from} — the current tail. Condition ${half.id} still has an empty "${missing}" branch; if this step belongs there, MOVE it: builder_update_step({stepId:"${result.added.id}", patch:{afterStepId:"${half.id}", branch:"${missing}"}}). Do not remove and re-add it.`;
                }
            }
        }
    }
    // When a mutator rejected the call due to bad bindings, prefix the
    // error with a structured marker so the system prompt's "common
    // pitfalls" section catches the model's attention. Without this the
    // model sometimes ignores the error entirely and re-tries the same
    // call.
    // ONLY when the rejection really is about a binding. This used to be
    // stamped on EVERY error without its own hint — including "Unknown flowlet
    // scope", "Unknown toStepId" and "not patchable on a loop step", none of
    // which is a binding problem. Telling a model to go fix a ref path when the
    // real answer is "that scope is not a flowlet" is how it ends up re-sending
    // the same call with a cosmetically different path.
    if (result && typeof result === 'object' && result.error && !result._fixHint
        && /\b(binding|refs?\b|path\b|kind:|must start with|interpolat)/i.test(String(result.error))) {
        result._fixHint = 'Reject reason: invalid input binding. Fix the path/value and call the tool again. Refs MUST start with: trigger, steps, vars, secrets, loop.';
    }
    if (repaired && result && typeof result === 'object' && !result.error) {
        result._autoRepaired = repaired;
        result._note = `Your resend was identical, so the fix the error named was applied: ${repaired.join('; ')}. It is built now — do NOT resend it; continue with the next step.`;
    } else if (repaired && partial) {
        // The patched prefix landed and a LATER entry was refused: the repair
        // changed a step that is now in the draft, so it lands in _warnings
        // like every other repair — without it the model was never told its
        // itemVar/binding was rewritten. Not "built": `partial` is also true
        // when the patched entry is refused again behind reused entries, and
        // the ladder's count-2 sentence covers that case.
        result._autoRepaired = repaired;
        (result._warnings = result._warnings || []).push(`Your resend was identical, so the fix the earlier error named was applied before dispatch: ${repaired.join('; ')}.`);
    }
    // The ladder is keyed on what the model SENT, not on the patched form:
    // a third identical resend after a failed patch must still count.
    rejectionLadder(name, args, result, draftWrap, { patched: !!repaired });
    return result;
}

/**
 * Follow the route (W8): every step this call added that hangs off a
 * Condition working through a list reads what that Condition keeps, and an
 * added list Condition hands its outputs to the step after it (a splice).
 * The rewrites are the canvas's own (shared/expr/routeFollow.mjs) and are
 * said in `_warnings`, so the model knows which of its refs moved.
 */
function followAdded(result, callArgs, draftWrap) {
    if (!result.added) return;
    const list = Array.isArray(result.added) ? result.added : [result.added];
    const ids = list.map(a => a && a.id).filter(id => typeof id === 'string');
    if (!ids.length) return;
    const scope = callArgs && typeof callArgs.scope === 'string' && callArgs.scope ? callArgs.scope : null;
    const graph = scope ? draftWrap.def.layers?.[scope] : draftWrap.def;
    if (!graph) return;
    const notes = followAddedSteps(graph, ids);
    if (!notes.length) return;
    (result._warnings = result._warnings || []).push(...notes);
    // A single added step that was itself re-pointed: echo what is stored.
    if (!Array.isArray(result.added)) {
        result.added = (graph.steps || []).find(s => s && s.id === result.added.id) || result.added;
    }
}

// ── The repeat ladder ────────────────────────────────────────────────
//
// A rejected mutator rolls back, so identical arguments against an unchanged
// draft are rejected identically, and nothing in the result used to say so.
// Measured with the fast local model: one byte-identical builder_add_steps
// sent three rounds running, a builder_update_steps fifteen times before
// that — and "stop retrying" in the hint was not obeyed either. So the same
// call, rejected again, climbs a ladder the model cannot fall off:
//   1st rejection  the error, plus the patch it carries (describePatch)
//   2nd, identical the patch is APPLIED before dispatch (applyToolCall above);
//                  without one — or when the patched call fails too — the
//                  result says so and hands over the one call to send
//                  (`resendAs`, real ids, anchored)
//   3rd            `_stop`: the route ends the turn and tells the user.
// "Identical" is key-order independent (canonicalJson) and, for a batch,
// also means "contains the entry that failed": a resend that obeyed the
// partial-result protocol (entries i.. only) and still carries the failing
// entry unchanged is the same attempt, not a fresh one. The memory lives on
// the per-turn draftWrap; a successful mutation OF THE GRAPH clears it because
// the draft the next call sees is a different one (GRAPH_NEUTRAL_MUTATORS —
// a title or a canvas note — leave it standing). The App Studio builder
// keeps the simpler shared counter (core/llm/toolCallHygiene).

/** The signatures a rejection is remembered by. */
function rejectionSignature(name, args, result) {
    const sig = `${name}\n${canonicalJson(args === undefined ? null : args)}`;
    const steps = Array.isArray(args?.steps) ? args.steps : null;
    const failed = name === 'builder_add_steps' && steps && result && Number.isInteger(result.failedIndex)
        ? steps[result.failedIndex] : undefined;
    const entrySig = failed !== undefined ? canonicalJson(failed) : null;
    // The entry as the partial result asked for it back (real ids, anchored):
    // sent verbatim and refused again, it is the same step failing.
    const resent = result?.resendAs?.args?.steps?.[0];
    const resendSig = resent !== undefined ? canonicalJson(resent) : null;
    return { sig, entrySig, resendSig };
}

/** Is this call the one `prev` remembers? */
function isRepeat(prev, name, args) {
    if (!prev || typeof prev !== 'object') return false;
    if (prev.sig === rejectionSignature(name, args, null).sig) return true;
    if (name !== 'builder_add_steps' || !Array.isArray(args?.steps)) return false;
    const sigs = [prev.entrySig, prev.resendSig].filter(s => typeof s === 'string');
    return sigs.length > 0 && args.steps.some(e => sigs.includes(canonicalJson(e)));
}

/** What to call the step that keeps failing: its label, its tool, its type. */
function failingLabel(name, args, result) {
    const steps = Array.isArray(args?.steps) ? args.steps : null;
    const entry = name === 'builder_add_steps' && steps && result && Number.isInteger(result.failedIndex) ? steps[result.failedIndex] : null;
    const spec = entry ? (entry.spec && typeof entry.spec === 'object' ? entry.spec : {}) : (args && typeof args === 'object' ? args : {});
    const type = entry ? entry.type : name.replace(/^builder_(add_)?/, '');
    return [spec.label, spec.tool, type].find(v => typeof v === 'string' && v) || name;
}

/**
 * A mutating call that changed NOTHING — every target already held exactly
 * these values (stepEditing: `updated: []` with a non-empty `unchanged`).
 *
 * It carries no `error`, so the ladder below used to read it as a success:
 * it did not count, and worse, it CLEARED the memory of the rejection before
 * it. Measured 2026-09-16 on a live automation build: three builder_update_steps
 * in a row, each answered "Nothing changed … re-sending the same patch will
 * not help", each resetting the ladder — the exact loop the ladder exists to
 * stop. A no-op is not progress, so it must not clear the memory, and an
 * identical one has to climb like any other repeat.
 */
function isNoOpMutation(result) {
    return !!result && typeof result === 'object' && !result.error
        && Array.isArray(result.updated) && result.updated.length === 0
        && Array.isArray(result.unchanged) && result.unchanged.length > 0;
}

function rejectionLadder(name, args, result, draftWrap, { patched = false } = {}) {
    if (!draftWrap || typeof draftWrap !== 'object') return result;
    if (isNoOpMutation(result)) {
        // Climbs the same ladder, keyed on the arguments: rung 2 says so
        // plainly, rung 3 ends the turn. `_hint` already carries the tool's
        // own wording; the ladder appends the escalation to it.
        let sigs;
        try { sigs = rejectionSignature(name, args, null); } catch (_) { return result; }
        const prev = draftWrap._lastRejected;
        const count = prev && prev.sig === sigs.sig ? prev.count + 1 : 1;
        draftWrap._lastRejected = { ...sigs, count, patch: null, resendAs: null, noOp: true };
        if (count >= 3) {
            result._stop = {
                reason: 'no_op_repeat',
                message: `${name} changed nothing three times running. The step already holds these values — nothing further was tried.`,
            };
        } else if (count === 2) {
            result._hint = `${result._hint || ''} This is the SAME call as your previous attempt (2 times now) and it changed nothing again. Read the step with builder_inspect_tool, or move on — a third identical call ends the turn.`.trim();
        }
        return result;
    }
    if (!result || typeof result !== 'object' || !result.error) {
        if (MUTATING_TOOLS.has(name) && !GRAPH_NEUTRAL_MUTATORS.has(name)) draftWrap._lastRejected = null;
        return result;
    }
    let sigs;
    try { sigs = rejectionSignature(name, args, result); } catch (_) { return result; }
    const prev = draftWrap._lastRejected;
    // A batch rejection is a repeat only when the ENTRY it refuses is the one
    // `prev` remembers. A patched resend whose repaired prefix landed is
    // byte-equal to the previous call (the ladder keys on what the model
    // sent), yet the entry now refused is a later one failing for the first
    // time — measured: counted as attempt 2, the turn stopped after that
    // entry's SECOND refusal and the hint told two false sentences about it.
    // Single-step tools and batch-level errors (no entry) keep the whole-args
    // comparison.
    const sameEntry = prev && typeof sigs.entrySig === 'string' && typeof prev.entrySig === 'string'
        ? (sigs.entrySig === prev.entrySig || sigs.entrySig === prev.resendSig)
        : isRepeat(prev, name, args);
    const count = prev && sameEntry ? prev.count + 1 : 1;
    const patch = result._suggestedPatch || null;
    const resendAs = result.resendAs || (count > 1 && prev ? prev.resendAs : null);
    draftWrap._lastRejected = { ...sigs, count, patch, resendAs };
    const own = result._fixHint ? `${result._fixHint} ` : '';
    if (count === 1) {
        const described = patch ? describePatch(patch) : '';
        if (described) result._fixHint = `${own}${described}`;
        return result;
    }
    result._repeated = count;
    if (count === 2) {
        const same = `This is the SAME call as your previous attempt (2 times now), rejected for the same reason — re-sending identical arguments cannot succeed.${patched ? ' The attached patch was applied to it and the call was still refused.' : ''}`;
        result._fixHint = resendAs
            ? `${own}${same} Change exactly what the error names, then send exactly this ONE call next and nothing else: ${resendAs.tool}(${JSON.stringify(resendAs.args)})`
            : `${own}${same} Change exactly what the error names before calling again.`;
        return result;
    }
    result._stop = {
        reason: 'repeated_rejection',
        tool: name,
        error: String(result.error).slice(0, 300),
        entryIndex: Number.isInteger(result.failedIndex) ? result.failedIndex : null,
        label: failingLabel(name, args, result),
    };
    result._fixHint = `${own}This is the SAME call as your previous attempt (${count} times now). Stopped: the same step was rejected 3 times.`;
    return result;
}

/**
 * The `_hint` a dry-run step carries for the model: the output's type, its
 * top-level keys and a DEEP one-line shape in the run's own path grammar
 * (`messages[*]: { payload: { parts[*]: { body: { data } } } }`), the union
 * of every list entry, JSON text shown as what it encodes. Keys and types,
 * never values.
 *
 * An output over the 256 KB row cap is stored as a sentinel; its own keys
 * (`__truncated__`, `headSample`) are not the step's fields, and hinting
 * them taught the model to bind `steps.x.output.headSample`. The full copy
 * kept beside the row is read instead (or the sentinel's shape-preserving
 * preview when there is no copy). What the step really returned is also
 * remembered on the draft wrap for the rest of the turn, so the binding
 * checks of the next calls see this run's real shape (refCheck.js) — the
 * preview as `partial`: it cut lists and wide records, so nothing it lacks
 * is a reason to refuse, or even to doubt, a binding.
 */
async function dryRunHint(s, draftWrap, { readFullOutput = null } = {}) {
    let out = s.output;
    let note = null;
    let partial = false;
    const { isTruncatedOutput, fullOutputRefOf } = require('./payloadTruncation');
    if (isTruncatedOutput(out)) {
        const ref = fullOutputRefOf(out);
        let full = null;
        if (ref) {
            const read = readFullOutput || require('../stores/automationStore/runFullOutputs').getRunFullOutput;
            try { full = await read(ref.runId, ref.stepId, ref.attempts); }
            catch { full = null; }
        }
        note = 'output over 256 KB: the shape is read from the full copy';
        if (full === null || full === undefined) {
            out = out.preview !== undefined ? out.preview : undefined;
            partial = true;
            note = out === undefined
                ? 'output over 256 KB and not kept: its shape is unknown here — inspect the step\'s tool instead'
                : 'output over 256 KB: the shape is read from a shortened preview (lists cut, keys kept)';
        } else {
            out = full;
        }
    }
    const isObj = out && typeof out === 'object' && !Array.isArray(out);
    const shapeCache = require('./shapeCache');
    const shape = out !== undefined && out !== null && typeof out === 'object' ? shapeCache.shapeHintOf(out) : null;
    if (out !== undefined && draftWrap && draftWrap.def) {
        const found = findStepAnywhere(draftWrap.def, s.stepId);
        if (found) require('./builderTools/refCheck').rememberStepShape(draftWrap, found.step, out, { partial });
    }
    // A step on a table that is only proposed ran against nothing: say so, so
    // the model does not read the empty result as "the table has no rows".
    if (isObj && out._pendingTable) note = [note, 'table not created yet: a preview reads no rows and writes nothing'].filter(Boolean).join('; ');
    return {
        outputType: Array.isArray(out) ? 'array' : (out === null || out === undefined ? 'null' : typeof out),
        topKeys: isObj ? Object.keys(out) : null,
        shape,
        ...(note ? { note } : {}),
    };
}

async function _applyToolCallRaw(name, args, draftWrap, { sent = args } = {}) {
    const draft = draftWrap.def;
    // Central scope resolution (inline flowlets): scoped tools may pass
    // scope:'<layerKey>' to operate on definition.layers[<key>]'s graph
    // instead of the root flow. Resolved ONCE here so every apply function
    // below just works on `graph` (mini-definitions share the root shape).
    const scope = (args && typeof args.scope === 'string' && args.scope) ? args.scope : null;
    let graph = draft;
    if (scope) {
        if (!SCOPED_GRAPH_TOOLS.has(name)) {
            return { error: `Tool ${name} does not accept a scope. Flowlet triggers/contracts are managed via builder_create_layer / builder_set_layer_contract.` };
        }
        graph = draft.layers?.[scope];
        if (!graph) {
            return { error: `Unknown flowlet scope "${scope}". Existing flowlets: ${Object.keys(draft.layers || {}).join(', ') || '(none — create one with builder_create_layer)'}.` };
        }
    }
    switch (name) {
        case 'builder_propose_trigger':    return applyTrigger(draft, args);
        case 'builder_add_trigger':        return applyAddTrigger(draft, args);
        case 'builder_update_trigger':     return applyUpdateTrigger(draft, args);
        case 'builder_add_action':         return applyAddAction(graph, args, draftWrap);
        case 'builder_add_ai_step':        return applyAddAi(graph, args, draftWrap);
        case 'builder_add_condition':      return applyAddCondition(graph, args);
        case 'builder_add_loop':           return applyAddLoop(graph, args, draftWrap);
        case 'builder_add_code_step':      return applyAddCode(graph, args, draftWrap);
        case 'builder_add_notification':   return applyAddNotification(graph, args, draftWrap);
        case 'builder_add_http_request':   return applyAddHttpRequest(graph, args, draftWrap);
        case 'builder_add_generate_document': return applyAddGenerateDocument(graph, args, draftWrap);
        case 'builder_add_fill_document':  return applyAddFillDocument(graph, args, draftWrap);
        case 'builder_add_slide':          return applyAddSlide(graph, args, draftWrap);
        case 'builder_add_presentation':   return applyAddPresentation(graph, args);
        case 'builder_add_data_extraction': return applyAddDataExtraction(graph, args, draftWrap);
        case 'builder_add_set':            return applyAddSet(graph, args, draftWrap);
        case 'builder_add_call_layer':     return applyAddCallLayer(draft, args, { graph, scope });
        case 'builder_create_layer':       return applyCreateLayer(draft, args);
        case 'builder_set_layer_contract': return applySetLayerContract(draft, args);
        case 'builder_inline_layer':       return applyInlineLayer(graph, draft, args);
        case 'builder_add_datetime':       return applyAddDateTime(graph, args);
        case 'builder_add_wait':           return applyAddWait(graph, args);
        case 'builder_add_approval':       return applyAddApproval(graph, args);
        case 'builder_add_form_page':      return applyAddFormPage(graph, args);
        case 'builder_add_stop_error':     return applyAddStopError(graph, args);
        case 'builder_add_switch':         return applyAddSwitch(graph, args, draftWrap);
        case 'builder_add_filter':         return applyAddFilter(graph, args, draftWrap);
        case 'builder_add_limit':          return applyAddLimit(graph, args, draftWrap);
        case 'builder_add_dedupe':         return applyAddDedupe(graph, args, draftWrap);
        case 'builder_add_aggregate':      return applyAddAggregate(graph, args, draftWrap);
        case 'builder_add_summarize':      return applyAddSummarize(graph, args, draftWrap);
        case 'builder_add_array_op':       return applyAddArrayOp(graph, args, draftWrap);
        case 'builder_add_datatable':      return applyAddDatatable(graph, args, draftWrap);
        // A table made at DESIGN time (a side effect outside the draft — never a
        // graph mutation): the catalog on draftWrap is refreshed in place.
        case 'builder_create_datatable':   return applyCreateDatatable(draftWrap, args);
        case 'builder_add_knowledge_write': return applyAddKnowledgeWrite(graph, args, draftWrap);
        case 'builder_add_note':           return applyAddNote(graph, args);
        case 'builder_add_steps':          return applyAddSteps(graph, args, { draft, scope, sent }, draftWrap);
        case 'builder_wire_error_branch':  return applyWireErrorBranch(graph, args);
        case 'builder_remove_step':        return applyRemoveStep(graph, args);
        case 'builder_update_step':        return applyUpdateStep(graph, args, draftWrap);
        case 'builder_update_steps':       return applyUpdateSteps(graph, args, draftWrap);
        case 'builder_replace_step':       return applyReplaceStep(graph, args, { draft, scope }, draftWrap);
        case 'builder_set_metadata':       return applySetMetadata(draftWrap, args);
        case 'builder_summarise':          return applySummarise(draft);
        case 'builder_inspect_tool':       return applyInspectTool(args, draftWrap);
        case 'builder_request_dry_run':    return applyRequestDryRun(draftWrap, args, { persistDraft, annotate: dryRunHint });
        case 'builder_finalize': {
            const automation = await persistDraft(draftWrap, { finalize: true });
            // Slim echo: the full automation row embeds the entire definition
            // JSON the model already has in context. Callers only read
            // `.automation.id` / `.title`; validation errors (when finalize
            // was requested on an invalid draft) stay structured.
            return {
                automation: { id: automation.id, title: automation.title },
                ok: !automation.validationErrors,
                ...(automation.validationErrors ? { validationErrors: automation.validationErrors } : {}),
            };
        }
        default:
            return { error: `Unknown builder tool: ${name}` };
    }
}

module.exports = {
    TOOL_SCHEMAS, MUTATING_TOOLS, SCOPED_GRAPH_TOOLS, applyToolCall, persistDraft, emptyDefinition,
    // Model-facing payload helpers (route + flowletAgent share these)
    compactSample, compactDryRunForModel, truncateToolResultJson, renderStepIdLine, renderEdgeLine,
    // Flowlet-creation primitives reused by the flowlet sub-agent (flowletAgent.js)
    // so its isolated drafts seed the EXACT same skeleton / keying.
    generateLayerKey, makeLayerSkeleton, sanitizeLayerParams,
    TRIGGER_FIELDS_BY_EVENT, TRIGGER_OUTPUT_SAMPLES, buildTriggerOutputsCatalog,
    _test_validateAndFixBindings: validateAndFixBindings,
    _test_dryRunHint: dryRunHint,
    // §A in-place-edit internals (exported for tests)
    findStepAnywhere, PATCHABLE_FIELDS,
    // The repeat ladder's signature (exported for tests)
    rejectionSignature, isRepeat,
};
