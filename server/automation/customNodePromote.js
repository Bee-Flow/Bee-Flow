/**
 * "Make this reusable" — one code step, promoted to a custom node.
 *
 * A code step lives inside one routine: its inputs are bound to that
 * routine's steps, its ceilings are that step's ceilings, and the only way to
 * use it twice is to paste it. Promotion turns it into a Step row
 * (kind='block' — stores/automationStore/steps.js), which is the same
 * contract stepContract.js reads plus the body and the capability manifest
 * customNode.js demands.
 *
 * WHAT THIS PRODUCES, and why each half of it is not optional:
 *
 *   trigger.params   one per key of `step.inputs`. The body's own inputs are
 *                    re-bound to `trigger.output.<name>`, which is how a
 *                    layer reads what its caller passed. A LITERAL input
 *                    becomes a param too, not a constant hidden inside the
 *                    node: a node whose behaviour turns on a number nobody
 *                    can see is the thing promotion exists to end.
 *   callInputs       the ORIGINAL bindings, per param name, for the
 *                    call_block that replaces the step in the routine it came
 *                    from. Promotion that does not hand these back is a
 *                    promotion that silently changes the routine it promoted
 *                    out of: every `steps.x.output.y` the step read would
 *                    have to be retyped by hand, and the first one anybody
 *                    forgets resolves to undefined and writes nothing.
 *   layer_output     one field per DECLARED output, bound to
 *                    `steps.body.output.result.<name>`. execCode writes the
 *                    body's return value to `.output.result` (see
 *                    core/automationRunner/execOutbound.js), so that — not
 *                    `.output.<name>` — is where a returned key really lives.
 *   capabilities     `tool:<name>` per entry of the body's `allowedTools`,
 *                    which is the list codeSandbox gates through
 *                    `bridges.allowedTools`. Derived, never typed: a manifest
 *                    assembled by hand is a promise with no keeper, and
 *                    validateCustomNode refuses the two ways it can drift.
 *
 * WHY THE OUTPUTS CAN BE A REFUSAL. validateCustomNode makes declared outputs
 * MANDATORY (`outputs_missing` / `outputs_empty`), for the reason its header
 * gives: a node is bound to BY FIELD NAME, and one that declares nothing
 * saves, runs green and writes nothing. A code step has no such obligation,
 * so a promotion can be asked to make a node out of a body whose outputs
 * nobody ever declared. There are exactly two honest answers and inventing a
 * field name is neither: read the declaration the step already carries
 * (`outputSchema`), or refuse and say which declaration is missing. A
 * promotion that produced a node failing validateCustomNode would be a bug
 * dressed as a feature — so this module ends by running that contract, and
 * validateDefinition's block scope, over what it just built.
 *
 * THE OUTPUT SHAPE THIS FIXES ON. A custom node's body returns an OBJECT and
 * each declared output is a key of it. That is one rule, and it is the rule
 * customNodeRepair.js verifies by running the body — so "what the node
 * promises" and "what the loop checks" cannot drift into two answers.
 *
 * Pure: no I/O, no DB, no isolate. codeSandbox is required lazily and only
 * for the one refusal that quotes its wording, exactly as customNode.js does
 * it — nothing else here needs the native module.
 */

'use strict';

const { validateCustomNode } = require('./customNode');

// A name that becomes a binding segment: `trigger.output.<param>` going in,
// `steps.body.output.result.<field>` coming out. validate/constants.js owns
// the spelling; a hyphen in one of these makes the path parse as a
// SUBTRACTION, so the value is written and then unreachable.
const { BINDABLE_SEGMENT_RE, RESERVED_PROTO_KEYS } = require('./validate/constants');

// Fixed ids, like the flowlet skeleton's ('trg'/'out'): the node is a fresh
// document, so nothing outside it can name these, and a predictable body id
// is what makes the output bindings below readable to a person.
const TRIGGER_ID = 'trg';
const BODY_ID = 'body';
const OUTPUT_ID = 'out';

// Where execCode puts the body's return value. Spelled once: the binding the
// node hands downstream and the place the runner really writes have to be the
// same string or the node returns undefined for every field it declares.
const BODY_RESULT_PATH = `steps.${BODY_ID}.output.result`;

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * The param type for one original binding.
 *
 * Only a literal (and a template, which is a string by construction) says
 * anything about its own type. A `ref` or an `expr` is answered at run time
 * by a step that has not run, so there is nothing to read and the param falls
 * back to 'string' — the same default sanitizeLayerParams uses. The types are
 * the vocabulary agentCallableTools.paramTypeToJsonSchema already maps.
 */
function paramTypeOf(binding) {
    if (isObject(binding) && typeof binding.kind === 'string') {
        if (binding.kind === 'template') return 'string';
        if (binding.kind !== 'literal') return 'string';
    }
    const v = isObject(binding) && binding.kind === 'literal' ? binding.value : binding;
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (Array.isArray(v)) return 'array';
    if (v && typeof v === 'object') return 'object';
    return 'string';
}

/**
 * The output names a code step has already declared, or null when it has
 * declared none.
 *
 * `outputSchema` is read the way modelStepRules.js reads it — properties, or
 * the object itself when someone wrote the shape without the JSON-schema
 * wrapper — so the two never disagree about what a step declares.
 */
function declaredOutputNames(step) {
    if (!isObject(step?.outputSchema)) return null;
    const props = isObject(step.outputSchema.properties) ? step.outputSchema.properties : step.outputSchema;
    const names = Object.keys(props).filter(k => k !== 'type' && k !== 'description' && k !== 'required');
    return names.length ? names : null;
}

/** An issue record in the shape customNode.js uses: `{ code, path, message, hint }`. */
function issue(code, path, message, hint) { return { code, path, message, hint }; }

function refuse(issues) {
    return { ok: false, reason: issues[0].code, issues };
}

/**
 * Promote one code step to a custom-node definition.
 *
 * @param {object}   step        the `code` step, as it is stored in the routine.
 * @param {string[]} [outputs]   the names the body returns, when the author
 *                               named them. Without it the step's own
 *                               `outputSchema` is read, and without that the
 *                               promotion is refused rather than guessed.
 * @param {string}   [label]     the body's label inside the node.
 *
 * @returns {{ ok: true, definition, callInputs, contract, warnings }
 *        | { ok: false, reason, issues }}
 *   `callInputs` is the map a call_block needs to reproduce, in the routine
 *   this came from, exactly what the step did before.
 */
function promoteCodeStep({ step, outputs = null, label = null } = {}) {
    if (!isObject(step) || step.type !== 'code') {
        return refuse([issue('not_a_code_step', '', 'Only a code step can be promoted to a custom node.', 'Reusable versions of the other step types are built as a building block: in Automations, use the arrow next to + and choose New building block.')]);
    }
    if (typeof step.code !== 'string' || !step.code.trim()) {
        return refuse([issue('body_empty', 'code', 'This code step has no code to promote.', 'Write the body first — a custom node is a body plus the contract around it.')]);
    }

    // ── forEach: the fan-out cannot come along ──────────────────────────
    //
    // A call_block is not in validate/stepRules/iterationRules' FOREACH_ALLOWED,
    // so the step that replaces this one CANNOT run once per item. Carrying
    // the forEach into the node instead would move the iteration inside the
    // contract and leave the body's `loop.<itemVar>` references bound to a
    // loop that no longer exists — inputs resolving to undefined, on a node
    // that saves and runs green. Say so instead.
    //
    // The same holds for the v2 `repeat` (step.repeat = { over, max }): code is
    // in FOREACH_ALLOWED, and "Koppelingen bijwerken" turns every legacy
    // forEach code step into one. The call step could not repeat, and its
    // `take: 'each'` picks would sit outside any repeat.
    const fansOut = (step.forEach ?? null) !== null || (step.repeat ?? null) !== null;
    if (fansOut) {
        const field = (step.repeat ?? null) !== null ? 'repeat' : 'forEach';
        return refuse([issue('for_each_unsupported', field, 'A code step that runs once per item cannot be promoted as-is: the call step that replaces it cannot fan out.', 'Promote the body without running it once per item and put the call inside a loop step over the same list, binding each item to a node input.')]);
    }

    // ── secretKeys: a step that can never run must not become a node ────
    if (step.inputs !== undefined && step.inputs !== null && !isObject(step.inputs)) {
        return refuse([issue('inputs_shape', 'inputs', 'This code step\'s `inputs` is not a map of { name: binding }, so its parameters cannot be read.', 'Fix the step\'s inputs in the builder and promote it again.')]);
    }
    const inputs = isObject(step.inputs) ? step.inputs : {};
    const declaredSecretKeys = Array.isArray(inputs.secretKeys?.value) ? inputs.secretKeys.value
        : Array.isArray(inputs.secretKeys) ? inputs.secretKeys
            : [];
    if (declaredSecretKeys.length > 0) {
        // The same two shapes execCode reads, and the same one wording — see
        // the codeSandbox header for why there is exactly one. Required here
        // rather than at the top because it pulls in isolated-vm and this
        // branch is the only reader.
        const { SECRETS_NOT_CONFIGURED_MESSAGE } = require('./codeSandbox');
        return refuse([issue('secret_keys_unsupported', 'inputs.secretKeys', `This code step declares secretKeys (${declaredSecretKeys.join(', ')}), but ${SECRETS_NOT_CONFIGURED_MESSAGE}`, 'Remove secretKeys and pass the value in as a node input — promoting a step that cannot run would hand the palette a node that fails on its first call.')]);
    }

    // ── allowedTools: the manifest is DERIVED from it ───────────────────
    //
    // A bare string here is `new Set('gmail_send')` in execCode — a set of
    // CHARACTERS, so every call comes back "not allowed for this step". A
    // manifest derived from that is a list of single letters, and it would be
    // stored, shipped and shown. Refuse rather than derive from nonsense.
    if (step.allowedTools !== undefined && step.allowedTools !== null
        && (!Array.isArray(step.allowedTools) || step.allowedTools.some(t => typeof t !== 'string' || !t.trim()))) {
        return refuse([issue('allowed_tools_shape', 'allowedTools', 'This code step\'s `allowedTools` is not a list of tool names, so the node\'s capabilities cannot be derived from it.', 'Set it to the tools the body reaches through ctx.integrations.<tool>(args), or [] for code that calls none.')]);
    }
    const toolNames = [...new Set((step.allowedTools || []).map(t => t.trim()))].sort();

    // ── the params ──────────────────────────────────────────────────────
    const issues = [];
    const params = [];
    const callInputs = {};
    const bodyInputs = {};
    for (const name of Object.keys(inputs)) {
        if (RESERVED_PROTO_KEYS.has(name) || !BINDABLE_SEGMENT_RE.test(name)) {
            // Inside the node the body reads `trigger.output.<name>`. A name
            // the grammar cannot address makes that path mean something else,
            // so the input is declared, passed, and never arrives.
            issues.push(issue('input_name_unbindable', `inputs.${name}`, `The input "${name}" cannot become a node parameter: trigger.output.${name} does not mean this input to the expression grammar.`, 'Rename it to letters, digits and underscores (no hyphens, spaces or dots) in the code step first, then promote it.'));
            continue;
        }
        params.push({ name, type: paramTypeOf(inputs[name]), required: true });
        callInputs[name] = inputs[name];
        bodyInputs[name] = { kind: 'ref', path: `trigger.output.${name}` };
    }

    // ── the outputs — the mandate. See the module header. ───────────────
    const names = Array.isArray(outputs) && outputs.length
        ? outputs.map(n => (typeof n === 'string' ? n.trim() : n))
        : declaredOutputNames(step);
    if (!names || !names.length) {
        issues.push(issue('outputs_undeclared', 'outputSchema', 'This code step does not declare what it returns, so the node would have no outputs to bind to.', 'Name each value the body returns — an outputSchema on the code step, or the output names given to the promotion. A node that declares nothing binds to nothing and writes nothing downstream.'));
    } else {
        for (const n of names) {
            if (typeof n !== 'string' || !n.trim()) {
                issues.push(issue('output_name_invalid', 'outputs', `${JSON.stringify(n)} is not an output name.`, 'Give each output a name: the body returns an object and each declared output is one of its keys.'));
            } else if (RESERVED_PROTO_KEYS.has(n) || !BINDABLE_SEGMENT_RE.test(n)) {
                issues.push(issue('output_name_unbindable', 'outputs', `The output "${n}" cannot be bound downstream: steps.<id>.output.${n} does not mean this field to the expression grammar.`, 'Rename it to letters, digits and underscores (no hyphens, spaces or dots).'));
            }
        }
    }
    if (issues.length) return refuse(issues);

    const fields = {};
    for (const n of [...new Set(names)]) fields[n] = { kind: 'ref', path: `${BODY_RESULT_PATH}.${n}` };

    const body = {
        id: BODY_ID,
        type: 'code',
        ...(label || step.label ? { label: (label || step.label) } : {}),
        code: step.code,
        inputs: bodyInputs,
        allowedTools: toolNames,
        // Carried, never re-defaulted: a body that needed eight seconds of
        // wall clock inside the routine needs them inside the node too, and a
        // promotion that quietly hands it the 5s default is a step that is
        // simply not what its author thinks it is.
        ...(isObject(step.limits) ? { limits: { ...step.limits } } : {}),
        ...(isObject(step.outputSchema) ? { outputSchema: step.outputSchema } : {}),
    };

    const definition = {
        schemaVersion: 2,
        trigger: { id: TRIGGER_ID, type: 'trigger', kind: 'layer_input', params },
        steps: [body, { id: OUTPUT_ID, type: 'layer_output', fields, label: 'Return' }],
        edges: [{ from: TRIGGER_ID, to: BODY_ID }, { from: BODY_ID, to: OUTPUT_ID }],
        capabilities: toolNames.map(t => `tool:${t}`),
    };

    // ── the self-check ──────────────────────────────────────────────────
    //
    // Both contracts the node will be held to, run here, on the thing that is
    // about to be stored. A promotion that produces a node failing its own
    // contract is the bug and not the feature: the alternative is a row in
    // the Steps tab that the save path refuses and nobody can fix, because
    // the author never typed any of it.
    const contractIssues = validateCustomNode(definition);
    if (contractIssues.length) {
        return refuse(contractIssues.map(i => issue(`node_${i.code}`, i.path, i.message, i.hint)));
    }
    const { validateDefinition } = require('./validate');
    const v = validateDefinition(definition, { scope: 'block' });
    if (!v.ok) {
        return refuse((v.errors || []).map(e => issue(`definition_${e.code}`, e.path || '', e.message, e.hint)));
    }

    return {
        ok: true,
        definition,
        callInputs,
        contract: { params, outputFields: Object.keys(fields), capabilities: definition.capabilities },
        warnings: v.warnings || [],
    };
}

module.exports = {
    promoteCodeStep,
    declaredOutputNames,
    paramTypeOf,
    TRIGGER_ID, BODY_ID, OUTPUT_ID, BODY_RESULT_PATH,
};
