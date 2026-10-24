// @typecheck
/**
 * builder_update_step — recognising a patch that changes the step's TYPE, the
 * replace spec it becomes, and the hint for it. The replace itself runs in
 * updateStep.js (updateAsTypeChange). Moved verbatim out of stepEditing.js.
 */

const { REPLACEABLE_STEP_TYPES } = require('../stepTypeTable');
const { ALIASES: STEP_TYPE_ALIASES, isBuiltinStepType } = require('../../builtinStepTools');

// ── A type change through builder_update_step ──
//
// Measured on a live build: a Nextcloud Tables row step was to become a Bee
// Flow datatable step, and the model sent builder_update_step({patch:{tool:
// "datatable", op, values}}). The allow-list refused "op, values" before the
// unknown-tool check ever ran, and the hint named only builder_replace_step,
// which the small-model menu does not even offer. So the patch performs the
// type change itself, as the same replace (same id, same wiring), and says so.
// Nextcloud Tables and Bee Flow datatables are different systems: a Nextcloud
// `tableId` (often a title like "Facturen") is never read as a Bee Flow table.
const ROW_OP_FOR_TOOL = Object.freeze({
    nextcloud_tables_create_row: 'add_row',
    nextcloud_tables_update_row: 'update_rows',
    nextcloud_tables_list_rows: 'find_rows',
    nextcloud_tables_delete_row: 'delete_rows',
});
// What a step of the new type may take from a patch's `inputs` map. tableId
// and rowId are deliberately absent (see above).
const DATATABLE_LIFT_KEYS = ['op', 'values', 'where', 'matchColumn', 'sort', 'limit', 'datatableId', 'datatableKey'];

const resolvedStepType = (name) => (Object.prototype.hasOwnProperty.call(STEP_TYPE_ALIASES, name) ? STEP_TYPE_ALIASES[name] : name);

/**
 * Does this patch change the step's TYPE? `{newType}` when it does,
 * `{error}` when it asks for a type that cannot be replaced into, null when
 * it is an ordinary patch.
 *   (a) patch.type names another replaceable type;
 *   (b) an integration_action whose patch.tool is a built-in step type
 *       (tool:"datatable"): a type name where a tool belongs. A name the
 *       user's own catalog has stays a tool.
 */
function typeChangeFromPatch(step, patch, draftWrap) {
    if (typeof patch.type === 'string' && patch.type !== step.type) {
        const to = resolvedStepType(patch.type);
        if (to !== step.type && REPLACEABLE_STEP_TYPES.includes(to)) return { newType: to };
        if (to === step.type) return null;
        return { error: `Cannot change a step's type to "${patch.type}". Allowed types: ${REPLACEABLE_STEP_TYPES.join(', ')}.` };
    }
    if (step.type === 'integration_action' && typeof patch.tool === 'string' && isBuiltinStepType(patch.tool)
        && !(draftWrap && draftWrap._inputSchemasByTool && draftWrap._inputSchemasByTool[patch.tool])
        && !(draftWrap && draftWrap._availableToolNames && draftWrap._availableToolNames.has(patch.tool))) {
        const to = resolvedStepType(patch.tool);
        if (to !== 'integration_action' && REPLACEABLE_STEP_TYPES.includes(to)) return { newType: to };
    }
    return null;
}

/** The replace spec for a type change, and the notes about what was read or dropped. */
function specForTypeChange(step, patch, newType) {
    const notes = [];
    /** @type {Record<string, any>} */
    const spec = {};
    for (const [k, v] of Object.entries(patch)) if (!['type', 'tool', 'id', 'inputs'].includes(k)) spec[k] = v;
    const inputs = (patch.inputs && typeof patch.inputs === 'object' && !Array.isArray(patch.inputs)) ? patch.inputs : {};
    if (newType === 'datatable') {
        for (const k of DATATABLE_LIFT_KEYS) if (!(k in spec) && k in inputs) spec[k] = inputs[k];
        if (!('values' in spec) && step.inputs && step.inputs.values && typeof step.inputs.values === 'object' && !Array.isArray(step.inputs.values)) {
            spec.values = step.inputs.values;
            notes.push('The row values of the old step were carried over; their column names are matched against the new table\'s columns.');
        }
        if (!('op' in spec) && step.type === 'integration_action' && ROW_OP_FOR_TOOL[step.tool]) {
            spec.op = ROW_OP_FOR_TOOL[step.tool];
            notes.push(`op was not set: ${step.tool} read as op "${spec.op}".`);
        }
        const dropped = ['tableId', 'rowId'].filter((k) => (step.inputs && k in step.inputs) || k in inputs);
        if (dropped.length) notes.push(`The Nextcloud ${dropped.join(' and ')} of the old step were not carried over: Nextcloud Tables is a different system, and the Bee Flow table comes from datatableId.`);
    } else {
        for (const [k, v] of Object.entries(inputs)) if (!(k in spec)) spec[k] = v;
    }
    for (const k of ['label', 'forEach']) if (!(k in spec) && step[k] !== undefined) spec[k] = step[k];
    return { spec, notes };
}

function typeChangeHint(stepId, newType, draftWrap) {
    const offered = draftWrap && draftWrap._offeredTools;
    const replaceOffered = !(offered instanceof Set) || offered.has('builder_replace_step');
    const fields = newType === 'datatable' ? 'op, datatableId, datatableKey, values' : 'the fields of the new type';
    const call = replaceOffered
        ? `builder_replace_step({stepId:"${stepId}", newType:"${newType}", spec:{${fields}}})`
        : `builder_update_step({stepId:"${stepId}", patch:{type:"${newType}", ${fields}}})`;
    return `Reject reason: type change. Send ${call}.`
        + (newType === 'datatable' ? ' The Bee Flow table id comes from the Datatables block, builder_create_datatable, or the user\'s choice; never from the Nextcloud tableId. Nextcloud Tables and Bee Flow datatables are different systems.' : '');
}

module.exports = {
    ROW_OP_FOR_TOOL,
    DATATABLE_LIFT_KEYS,
    resolvedStepType,
    typeChangeFromPatch,
    specForTypeChange,
    typeChangeHint,
};
