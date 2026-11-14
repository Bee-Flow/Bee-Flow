// @typecheck
/**
 * Builder tools — builder_add_action: the integration_action step. Resolves
 * the tool, gates it, binds and repairs its inputs, redirects a datatable
 * step sent here by mistake, and refuses a second identical call.
 */

const { isSideEffect } = require('../../sideEffectMap');
const { newId, appendAfter, lastStepId } = require('../draftGraph');
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
    const names = (/** @type {{ datatableId: string; datatableKey: string; }} */ o) => (typeof o.datatableId === 'string' && o.datatableId.trim()) || (typeof o.datatableKey === 'string' && o.datatableKey.trim());
    if (!names(args) && !names(inputs)) return null;
    if (typeof args.tool === 'string' && args.tool.trim()) return null;   // a real action against a table id: leave it alone
    // The step's fields live either beside `inputs` or inside it; the ones
    // inside win nothing — both are merged, entry level first.
    const merged = { ...inputs, ...args };
    delete merged.inputs;
    delete merged.type;
    return merged;
}

/**
 * A datatable step sent here is built by its own tool, and the redirect said.
 * @param {DraftGraph} draft @param {ActionArgs} asDatatable @param {BuilderWrap} draftWrap
 */
function addAsDatatable(draft, asDatatable, draftWrap) {
    const r = /** @type {Record<string, any>} */ (applyAddDatatable(draft, asDatatable, draftWrap));
    const note = 'this step names a datatable, so it was built as a `datatable` step — builder_add_action is for integration tools only. Use builder_add_datatable (or type:"datatable" in builder_add_steps) next time.';
    if (r && r.error) return { ...r, _fixHint: `${r._fixHint ? `${r._fixHint} ` : ''}Note: ${note}` };
    return { ...r, _warnings: [...(r._warnings || []), note] };
}

/**
 * The tool, read from the call (resolveToolName) when it is missing or not one
 * the user can run. Only the key the name was READ from leaves the inputs map,
 * and the removal is said: deleting every TOOL_NAME_KEYS string dropped a
 * literal name:"Q3" on nextcloud_create_folder when the tool came from
 * top-level `toolName`, then refused the step for the very key it had removed
 * — a resend loop the repeat ladder ends with _stop (2026-09-13).
 * @param {ActionArgs} args @param {BuilderWrap} draftWrap
 * @returns {{ args: ActionArgs, notes: (string|null)[] }}
 */
function resolveActionTool(args, draftWrap) {
    const known = typeof args.tool === 'string' && args.tool && !(draftWrap?._availableToolNames && !draftWrap._availableToolNames.has(args.tool));
    if (known) return { args, notes: [null, null] };
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- the pattern below is an anchored literal prefix then one negated class, on the resolver's own path text: linear
    const r = resolveToolName(args, draftWrap);
    if (!r.tool) return { args, notes: [null, null] };
    const next = { ...args, tool: r.tool };
    const m = /^inputs\.([^.]+)/.exec(r.from || '');
    if (!m || !next.inputs || typeof next.inputs !== 'object' || Array.isArray(next.inputs) || !Object.hasOwn(next.inputs, m[1])) return { args: next, notes: [r.note, null] };
    const inputs = { ...next.inputs };
    delete inputs[m[1]];
    next.inputs = inputs;
    return { args: next, notes: [r.note, `inputs.${m[1]} was removed from the inputs — it carried the tool name, not a value for ${r.tool}.`] };
}

/**
 * Required inputs left unbound. The builder's validator is not handed the
 * tool schemas, so a read step with no `path` finalised clean and failed only
 * at run time with "path is required" — one live run per missing binding
 * (measured 2026-09-12, then again from a small model that wrote a forEach'd
 * nextcloud_read_file with no inputs at all). The §B3 gate only fires until the
 * tool has been inspected once; this is the check that stays. What the draft
 * can answer for is bound and said (autoBindRequiredInputs); what is left is
 * refused with the binding to add — and nothing else about the step was wrong,
 * so the hint says that.
 * @returns {{ inputs: any } | { refusal: any }}
 */
function bindRequiredInputs(draft, args, draftWrap, { inputs, forEach, warnings }) {
    let missing = unboundRequiredInputs(args.tool, inputs, draftWrap);
    if (!missing.length) return { inputs };
    const auto = autoBindRequiredInputs({ graph: draft, tool: args.tool, inputs, forEach, missing, afterStepId: args.afterStepId, draftWrap });
    let bound = inputs;
    if (auto.bound.length) {
        bound = auto.inputs;
        const res = forEach ? fieldsAtRef(draft, forEach.overRef, draftWrap) : null;
        for (const b of auto.bound) warnings.push(boundInputNote(b, res, forEach));
        missing = unboundRequiredInputs(args.tool, bound, draftWrap);
    }
    if (missing.length) return { refusal: requiredInputError(args.tool, missing, forEach, auto.candidates, draft, draftWrap) };
    return { inputs: bound };
}

/**
 * A loop.<var>.<field> binding checked against the item's shape. A fan-out
 * field bound without its envelope is repaired (the measured `loop.r.content`
 * for `loop.r.output.content`); a field the item does not have is only WARNED
 * about here — an integration_action's inputs are not the one binding a
 * data_extraction's source is, and a tool may read a field the curated shape
 * does not list.
 */
function checkLoopInputs(draft, draftWrap, { inputs, forEach, warnings }) {
    if (!forEach) return inputs;
    const prefix = `loop.${forEach.itemVar}.`;
    let out = inputs;
    let res = null;
    for (const [k, b] of Object.entries(inputs)) {
        if (!b || b.kind !== 'ref' || typeof b.path !== 'string' || !b.path.startsWith(prefix)) continue;
        const chk = checkLoopRef(draft, b.path, forEach, draftWrap);
        if (chk.ok && chk.path) {
            out = { ...out, [k]: { ...b, path: chk.path } };
            warnings.push(`input "${k}": ${chk.note}`);
        } else if (!chk.ok) {
            res = res || fieldsAtRef(draft, forEach.overRef, draftWrap);
            const phrase = describeItem(res);
            const dym = chk.suggestions && chk.suggestions.length ? ` Did you mean ${chk.suggestions.join(' or ')}?` : '';
            if (phrase) warnings.push(`input "${k}" reads ${b.path} but ${phrase} — it will be empty at run time.${dym}`);
            else if (chk.message) warnings.push(`input "${k}": ${chk.message}`);
        }
    }
    return out;
}

/**
 * Hallucinated-param check: a bound input the tool doesn't declare is silently
 * ignored at run time, so it is a warning (not a reject: catalog inputSchemas
 * may legitimately under-declare).
 * @param {string} tool @param {Record<string, unknown>} inputs @param {BuilderWrap} draftWrap
 */
function undeclaredInputWarnings(tool, inputs, draftWrap) {
    const declared = draftWrap?._inputSchemasByTool?.[tool]?.properties;
    if (!declared || typeof declared !== 'object') return [];
    return Object.keys(inputs || {}).filter(k => !(k in declared))
        .map(k => `input "${k}" is not declared on ${tool} (declared: ${Object.keys(declared).join(', ')}) — it will likely be ignored at runtime`);
}

/**
 * A second identical call on one linear path. Mutually exclusive paths are NOT
 * duplicates: the same action on a condition's `then` and `else`, or on two
 * switch cases, is a normal shape — only one of them ever runs — so the check
 * skips an append that is explicitly a branch or hangs off a brancher (which
 * auto-assigns then/else). It only runs when the call carries inputs: a
 * parameterless action is a stub shape (and a legitimate one — "list my rooms"
 * twice is odd but not wrong), whereas every real duplicate observed in builds
 * carried the same bound inputs. A re-read after a step that changed something
 * is not a duplicate: the guard looks at the graph between the two calls.
 * @param {Parameters<typeof findDuplicateAction>[0]} draft @param {ActionArgs} args @param {Record<string, unknown>} inputs
 */
function duplicateRefusal(draft, args, inputs) {
    const anchor = args.afterStepId ? (draft.steps || []).find(x => x && x.id === args.afterStepId) : null;
    const onOwnBranch = !!args.branch || !!args.caseName
        || (anchor && (anchor.type === 'condition' || anchor.type === 'guard' || anchor.type === 'switch'));
    const hasInputs = inputs && Object.keys(inputs).length > 0;
    if (onOwnBranch || !hasInputs) return null;
    const dup = findDuplicateAction(draft, args.tool, inputs, { anchorId: args.afterStepId || (draft.trigger ? lastStepId(draft) : null) });
    if (!dup) return null;
    return { error: `This draft already has step "${dup.id}" calling ${args.tool} with identical inputs, and nothing between the two changes anything — adding it again would run the same call twice. Reference "${dup.id}" downstream (steps.${dup.id}.output.…) instead. A re-read after a step that writes is allowed: append it after that step (afterStepId).` };
}

/**
 * The tool's gates and the inputs' bindings, in order: availability, inspect,
 * the binding check (a suggested path is never auto-applied to an action that
 * changes data), forEach and its loop variables. Every server-side repair
 * lands as a sentence on the success result.
 * @returns {{ refusal: any } | { inputs: any, forEach: any, warnings: string[] }}
 */
function gateAndBind(draft, args, draftWrap, toolNotes) {
    const unknown = unknownToolError(args.tool, draftWrap, { label: typeof args.label === 'string' ? args.label : null });
    if (unknown) return { refusal: unknown };
    const gate = inspectGateError(args.tool, args.inputs, draftWrap);
    if (gate) return { refusal: gate };
    const bindings = validateAndFixBindings(args.inputs || {}, draft, { draftWrap });
    if (bindings.error) return { refusal: { error: bindings.error, ...(bindings._suggestedPatch && !isSideEffect(args.tool) ? { _suggestedPatch: bindings._suggestedPatch } : {}) } };
    const { forEach, error: feErr, notes: feNotes } = sanitizeForEach(args.forEach, draft, draftWrap);
    if (feErr) return { refusal: { error: feErr } };
    const loopErr = unboundLoopVarError(bindings.inputs, forEach);
    if (loopErr) return { refusal: loopErr };
    const warnings = [...toolNotes, ...(bindings.notes || []), ...(feNotes || [])].filter(Boolean);
    return { inputs: bindings.inputs, forEach, warnings };
}

function applyAddAction(draft, rawArgs, draftWrap) {
    const asDatatable = datatableStepFromActionArgs(rawArgs || {});
    if (asDatatable) return addAsDatatable(draft, asDatatable, draftWrap);
    const { args, notes } = resolveActionTool(rawArgs || {}, draftWrap);
    const bound = gateAndBind(draft, args, draftWrap, notes);
    if ('refusal' in bound) return bound.refusal;
    const { forEach, warnings } = bound;
    const required = bindRequiredInputs(draft, args, draftWrap, bound);
    if ('refusal' in required) return required.refusal;
    const inputs = checkLoopInputs(draft, draftWrap, { inputs: required.inputs, forEach, warnings });
    warnings.push(...undeclaredInputWarnings(args.tool, inputs, draftWrap));
    const dup = duplicateRefusal(draft, args, inputs);
    if (dup) return dup;
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

/**
 * @typedef {import('../draftGraph').DraftGraph} DraftGraph
 * @typedef {import('../refCheck').BuilderWrap} BuilderWrap
 * @typedef {{ tool?: string, inputs?: import('./inputBindings').Inputs, forEach?: import('./inputBindings').ForEachSpec, label?: string, afterStepId?: string,
 *   branch?: string, caseName?: string, splice?: boolean, datatableId?: string, datatableKey?: string,
 *   type?: unknown }} ActionArgs
 */
