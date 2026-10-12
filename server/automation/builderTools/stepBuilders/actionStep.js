/**
 * Builder tools — builder_add_action: the integration_action step. Resolves
 * the tool, gates it, binds and repairs its inputs, redirects a datatable
 * step sent here by mistake, and refuses a second identical call.
 */

const { isSideEffect } = require('../../sideEffectMap');
const { newId, appendAfter } = require('../draftGraph');
const { fieldsAtRef, checkLoopRef, describeItem } = require('../outputFields');
const { validateAndFixBindings, sanitizeForEach, unboundLoopVarError } = require('../bindings');
const { inspectGateError } = require('../inspection');
const { resolveToolName, unknownToolError, findDuplicateAction } = require('./toolResolution');
const {
    unboundRequiredInputs, autoBindRequiredInputs, boundInputNote, requiredInputError,
} = require('./inputBindings');
const { applyAddDatatable } = require('./datatableStep');

/**
 * A DATATABLE step handed to builder_add_action, or null.
 *
 * Measured 2026-09-16: the model sent builder_add_action({type:"datatable",
 * inputs:{datatableId, op, where, sort, limit}}) and was told to add a `tool`
 * name from the integrations catalog — advice it cannot follow, because the
 * step is not an integration action. It resent the same call three times and
 * the build stopped with nothing on the canvas.
 *
 * `datatableId`/`datatableKey` is the tell: builder_add_action has no such
 * field, and a datatable step cannot exist without one. The step is built by
 * the tool that owns it and the redirect is reported, so the model learns the
 * name instead of guessing again.
 */
function datatableStepFromActionArgs(args) {
    if (!args || typeof args !== 'object') return null;
    const inputs = (args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs)) ? args.inputs : {};
    const names = (o) => (typeof o.datatableId === 'string' && o.datatableId.trim()) || (typeof o.datatableKey === 'string' && o.datatableKey.trim());
    if (!names(args) && !names(inputs)) return null;
    if (typeof args.tool === 'string' && args.tool.trim()) return null;   // a real action against a table id: leave it alone
    // The step's fields live either beside `inputs` or inside it; the ones
    // inside win nothing — both are merged, entry level first.
    const merged = { ...inputs, ...args };
    delete merged.inputs;
    delete merged.type;
    return merged;
}

function applyAddAction(draft, rawArgs, draftWrap) {
    let args = rawArgs || {};
    const asDatatable = datatableStepFromActionArgs(args);
    if (asDatatable) {
        const r = applyAddDatatable(draft, asDatatable, draftWrap);
        const note = 'this step names a datatable, so it was built as a `datatable` step — builder_add_action is for integration tools only. Use builder_add_datatable (or type:"datatable" in builder_add_steps) next time.';
        if (r && r.error) return { ...r, _fixHint: `${r._fixHint ? `${r._fixHint} ` : ''}Note: ${note}` };
        return { ...r, _warnings: [...(r._warnings || []), note] };
    }
    let toolNote = null;
    let removedNote = null;
    if (!args.tool || typeof args.tool !== 'string' || (draftWrap?._availableToolNames && !draftWrap._availableToolNames.has(args.tool))) {
        const r = resolveToolName(args, draftWrap);
        if (r.tool) {
            args = { ...args, tool: r.tool };
            toolNote = r.note;
            // Only the key the name was READ from leaves the inputs map, and
            // the removal is said. Deleting every TOOL_NAME_KEYS string
            // dropped a literal name:"Q3" on nextcloud_create_folder when the
            // tool came from top-level `toolName`, then refused the step for
            // the very key it had removed — a resend loop the repeat ladder
            // ends with _stop (2026-09-13).
            const m = /^inputs\.([^.]+)/.exec(r.from || '');
            if (m && args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs) && Object.hasOwn(args.inputs, m[1])) {
                const inputs = { ...args.inputs };
                delete inputs[m[1]];
                args.inputs = inputs;
                removedNote = `inputs.${m[1]} was removed from the inputs — it carried the tool name, not a value for ${r.tool}.`;
            }
        }
    }
    const unknown = unknownToolError(args.tool, draftWrap, { label: typeof args.label === 'string' ? args.label : null });
    if (unknown) return unknown;
    const gate = inspectGateError(args.tool, args.inputs, draftWrap);
    if (gate) return gate;
    const bindings = validateAndFixBindings(args.inputs || {}, draft, { draftWrap });
    // A suggested path is never auto-applied to an action that changes data.
    if (bindings.error) return { error: bindings.error, ...(bindings._suggestedPatch && !isSideEffect(args.tool) ? { _suggestedPatch: bindings._suggestedPatch } : {}) };
    let inputs = bindings.inputs;
    const { forEach, error: feErr, notes: feNotes } = sanitizeForEach(args.forEach, draft, draftWrap);
    if (feErr) return { error: feErr };
    const loopErr = unboundLoopVarError(inputs, forEach);
    if (loopErr) return loopErr;
    // Every server-side repair lands here as a sentence on the success result
    // — a path read differently, or one the tool's description cannot find.
    const warnings = [toolNote, removedNote, ...(bindings.notes || []), ...(feNotes || [])].filter(Boolean);
    // Required inputs left unbound. The builder's validator is not handed the
    // tool schemas, so a read step with no `path` finalised clean and failed
    // only at run time with "path is required" — one live run per missing
    // binding (measured 2026-09-12, then again from a small model that wrote
    // a forEach'd nextcloud_read_file with no inputs at all). The §B3 gate
    // above only fires until the tool has been inspected once; this is the
    // check that stays. What the draft can answer for is bound and said
    // (autoBindRequiredInputs); what is left is refused with the binding to
    // add — and nothing else about the step was wrong, so the hint says that.
    let missing = unboundRequiredInputs(args.tool, inputs, draftWrap);
    let candidates = [];
    if (missing.length) {
        const auto = autoBindRequiredInputs({ graph: draft, tool: args.tool, inputs, forEach, missing, afterStepId: args.afterStepId, draftWrap });
        if (auto.bound.length) {
            inputs = auto.inputs;
            const res = forEach ? fieldsAtRef(draft, forEach.overRef, draftWrap) : null;
            for (const b of auto.bound) warnings.push(boundInputNote(b, res, forEach));
            missing = unboundRequiredInputs(args.tool, inputs, draftWrap);
        }
        candidates = auto.candidates;
    }
    if (missing.length) return requiredInputError(args.tool, missing, forEach, candidates, draft, draftWrap);
    // A loop.<var>.<field> binding checked against the item's shape. A
    // fan-out field bound without its envelope is repaired (the measured
    // `loop.r.content` for `loop.r.output.content`); a field the item does
    // not have is only WARNED about here — an integration_action's inputs
    // are not the one binding a data_extraction's source is, and a tool may
    // read a field the curated shape does not list.
    if (forEach) {
        const prefix = `loop.${forEach.itemVar}.`;
        let res = null;
        for (const [k, b] of Object.entries(inputs)) {
            if (!b || b.kind !== 'ref' || typeof b.path !== 'string' || !b.path.startsWith(prefix)) continue;
            const chk = checkLoopRef(draft, b.path, forEach, draftWrap);
            if (chk.ok && chk.path) {
                inputs = { ...inputs, [k]: { ...b, path: chk.path } };
                warnings.push(`input "${k}": ${chk.note}`);
            } else if (!chk.ok) {
                res = res || fieldsAtRef(draft, forEach.overRef, draftWrap);
                const phrase = describeItem(res);
                const dym = chk.suggestions && chk.suggestions.length ? ` Did you mean ${chk.suggestions.join(' or ')}?` : '';
                if (phrase) warnings.push(`input "${k}" reads ${b.path} but ${phrase} — it will be empty at run time.${dym}`);
                else if (chk.message) warnings.push(`input "${k}": ${chk.message}`);
            }
        }
    }
    // Hallucinated-param check: a bound input the tool doesn't declare is
    // silently ignored at run time — surface it as a warning (not a reject:
    // catalog inputSchemas may legitimately under-declare).
    const declared = draftWrap?._inputSchemasByTool?.[args.tool]?.properties;
    if (declared && typeof declared === 'object') {
        const unknown = Object.keys(inputs || {}).filter(k => !(k in declared));
        if (unknown.length) {
            warnings.push(...unknown.map(k => `input "${k}" is not declared on ${args.tool} (declared: ${Object.keys(declared).join(', ')}) — it will likely be ignored at runtime`));
        }
    }
    // Mutually exclusive paths are NOT duplicates: the same action on a
    // condition's `then` and `else`, or on two switch cases, is a normal shape
    // — only one of them ever runs. Skip the check whenever this append is
    // explicitly a branch, or the anchor is a brancher (which auto-assigns
    // then/else). Everything else on one linear path is a real duplicate.
    const anchor = args.afterStepId ? (draft.steps || []).find(x => x && x.id === args.afterStepId) : null;
    const onOwnBranch = !!args.branch || !!args.caseName
        || (anchor && (anchor.type === 'condition' || anchor.type === 'guard' || anchor.type === 'switch'));
    // Only when the call actually carries inputs. A parameterless action is a
    // stub shape (and a legitimate one — "list my rooms" twice is odd but not
    // wrong), whereas every real duplicate observed in builds carried the same
    // bound inputs: the same folder listed twice, the same spreadsheet written
    // twice. Requiring inputs keeps the guard on the cases where "identical"
    // provably means "the same call".
    const hasInputs = inputs && Object.keys(inputs).length > 0;
    const dup = (onOwnBranch || !hasInputs) ? null : findDuplicateAction(draft, args.tool, inputs);
    if (dup) {
        return { error: `This draft already has step "${dup.id}" calling ${args.tool} with identical inputs — adding it again would run the same call twice. Reference "${dup.id}" downstream (steps.${dup.id}.output.…) instead. If you really need a second, distinct call, change an input.` };
    }
    const step = {
        id: newId('a'),
        type: 'integration_action',
        tool: args.tool,
        inputs,
        label: args.label || args.tool,
        sideEffect: isSideEffect(args.tool),
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step, ...(warnings.length ? { _warnings: warnings } : {}) };
}

module.exports = { applyAddAction };
