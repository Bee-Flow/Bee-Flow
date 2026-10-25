// @typecheck strict
/**
 * Builder tools — §A in-place editing: builder_update_step(s) patching with
 * the per-type field allow-list, builder_replace_step type swaps and
 * builder_remove_step with edge reconnection. Reuses the add-path sanitizers
 * so a patched step is byte-identical to a freshly-added one. Required from
 * within automation/builderTools/ and the ../builderTools facade.
 *
 * This file is the ENTRY POINT of the folder: it re-exports exactly the
 * surface stepEditing.js had as one file.
 *
 *   stepEditing/patchFields.js          PATCHABLE_FIELDS and the special key lists
 *   stepEditing/normalizePatchField.js  a patched value → the shape the add path writes
 *   stepEditing/typeChange.js           a patch that changes the step's type
 *   stepEditing/updateStep.js           builder_update_step(s): the orchestration
 *   stepEditing/patchGuards/            position/wiring, fill-only, datatable,
 *                                       data_extraction and binding-map passes
 *   stepEditing/replaceStep.js          builder_replace_step
 *   stepEditing/removeStep.js           builder_remove_step, findDanglingRefs
 */

const cycleDeps = require('./stepEditing/cycleDeps');

// The names the split modules read through cycleDeps. Getters, so each one is
// resolved when a module reads it (at call time), never captured here while
// the import cycle is still loading: stepBuilders/index, inspection and
// documentDiscovery may be half-initialised when this barrel first loads.
// documentDiscovery stays a function, the lazy require the single file had.
Object.defineProperties(cycleDeps, {
    ADD_FOR_TYPE: { enumerable: true, get: () => require('./stepBuilders').ADD_FOR_TYPE },
    modelTierGateError: { enumerable: true, get: () => require('./stepBuilders').modelTierGateError },
    sanitizeAgentId: { enumerable: true, get: () => require('./stepBuilders').sanitizeAgentId },
    sanitizeSkillIds: { enumerable: true, get: () => require('./stepBuilders').sanitizeSkillIds },
    sanitizeAgentPermissions: { enumerable: true, get: () => require('./stepBuilders').sanitizeAgentPermissions },
    sanitizeDisabledAgentSkillIds: { enumerable: true, get: () => require('./stepBuilders').sanitizeDisabledAgentSkillIds },
    agentPermissionsBlock: { enumerable: true, get: () => require('./stepBuilders').agentPermissionsBlock },
    inspectGateError: { enumerable: true, get: () => require('./inspection').inspectGateError },
    documentDiscovery: { enumerable: true, value: () => require('../../core/documents/documentDiscovery') },
});

const { PATCHABLE_FIELDS } = require('./stepEditing/patchFields');
const { applyUpdateStep, applyUpdateSteps } = require('./stepEditing/updateStep');
const { applyReplaceStep } = require('./stepEditing/replaceStep');
const { applyRemoveStep, findDanglingRefs } = require('./stepEditing/removeStep');

module.exports = {
    PATCHABLE_FIELDS,
    applyUpdateStep,
    applyUpdateSteps,
    applyReplaceStep,
    applyRemoveStep,
    findDanglingRefs,
};
