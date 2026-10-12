/**
 * Builder tools — the per-type apply* step builders: every builder_add_<type>
 * implementation, its input sanitizers, and the ADD_FOR_TYPE map that
 * builder_replace_step / builder_add_steps reuse so a swapped or batched step
 * inherits every per-type validation and clamp. Required from within
 * automation/builderTools/ and the ../builderTools facade.
 *
 * This file is the ENTRY POINT of the folder: it wires the modules below and
 * re-exports exactly the surface stepBuilders.js had as one file, so
 * `require('./stepBuilders')` keeps resolving to the same thing.
 *
 *   triggerApply.js        builder_set_trigger → draft.trigger
 *   toolResolution.js      which catalog tool the model meant, and may this user run it
 *   inputBindings.js       required inputs: what the draft binds itself, and the refusal when it cannot
 *   actionStep.js          integration_action
 *   aiStep.js              ai_step, its agent/skill/permission block, the model-tier gate
 *   flowSteps.js           condition, switch, guard, tokenize, loop, wait, form_page, stop_error
 *   dataSteps.js           set + the five list ops, datetime, code, the retired parse_json rows
 *   flattenStep.js         flatten: one row per item of a list inside a list
 *   documentSteps.js       generate_document, fill_document, slide, presentation
 *   dataExtractionStep.js  data_extraction, and every vocabulary it arrives in
 *   datatableStep.js       datatable reads and writes
 *   outboundSteps.js       http_request, notification, knowledge_write
 *   noteStep.js            the free-floating canvas note
 */

const { applyAddApproval } = require('../approval');
const { REPLACEABLE_STEP_TYPES } = require('../stepTypeTable');
const { applyAddCallLayer } = require('../layers');
const { applyTrigger } = require('./triggerApply');
const { resolveToolName, unknownToolError, findDuplicateAction } = require('./toolResolution');
const {
    autoBindRequiredInputs, requiredInputError, fileLocationField, bindingToTemplate,
} = require('./inputBindings');
const { applyAddAction } = require('./actionStep');
const { applyAddFlatten } = require('./flattenStep');
const {
    modelTierGateError, sanitizeAgentId, sanitizeSkillIds, sanitizeAgentPermissions,
    sanitizeDisabledAgentSkillIds, agentPermissionsBlock, applyAddAi,
} = require('./aiStep');
const {
    applyAddCondition, applyAddGuard, applyAddTokenize, applyAddUntokenize, applyAddLoop, applyAddSwitch,
    applyAddWait, applyAddFormPage, applyAddStopError, sanitizeSwitchCases,
} = require('./flowSteps');
const {
    sanitizeSetOperations, applyAddSet, sanitizeParseJsonFieldRows, PARSE_JSON_RETIRED_MSG,
    applyAddDateTime, applyAddCode, applyAddFilter, applyAddLimit, applyAddDedupe,
    applyAddAggregate, applyAddSummarize, applyAddArrayOp,
} = require('./dataSteps');
const {
    applyAddGenerateDocument, applyAddFillDocument, clampDocumentTtl, deckLookFields,
    slideVisualFields, applyAddSlide, applyAddPresentation,
} = require('./documentSteps');
const {
    sanitizeDataExtractionFields, sanitizeDataExtractionSource, deriveDataExtractionSource,
    loopItemSourceError, applyAddDataExtraction, unwrapDataExtractionInputs,
    translateDataExtractionVocabulary,
} = require('./dataExtractionStep');
const {
    sanitizeDatatableBindings, sanitizeDatatableCursor, DATATABLE_WRITE_OPS, readOnlyTableError, coerceSortList,
    resolveDatatableColumns, checkExtractionFieldRefs, applyAddDatatable,
} = require('./datatableStep');
const {
    normalizeAskOnce, normalizeCacheInto, applyAddHttpRequest, applyAddNotification,
    applyAddKnowledgeWrite,
} = require('./outboundSteps');
const { sanitizeNoteSize, applyAddNote, NOTE_MAX_TEXT_LENGTH, NOTE_COLOR_KEYS } = require('./noteStep');

// The apply* builder of every type the builder can create. Reused by
// builder_replace_step and builder_add_steps so a swapped or batched step inherits
// every per-type validation/clamp.
const BUILDERS = {
    integration_action: applyAddAction, ai_step: applyAddAi, condition: applyAddCondition,
    guard: applyAddGuard, tokenize: applyAddTokenize, untokenize: applyAddUntokenize,
    switch: applyAddSwitch, code: applyAddCode, notification: applyAddNotification, set: applyAddSet,
    http_request: applyAddHttpRequest,
    generate_document: applyAddGenerateDocument,
    fill_document: applyAddFillDocument,
    slide: applyAddSlide,
    presentation: applyAddPresentation,
    data_extraction: applyAddDataExtraction,
    datetime: applyAddDateTime, wait: applyAddWait, stop_error: applyAddStopError, form_page: applyAddFormPage,
    approval: applyAddApproval,
    filter: applyAddFilter, limit: applyAddLimit, dedupe: applyAddDedupe,
    aggregate: applyAddAggregate, summarize: applyAddSummarize, call_layer: applyAddCallLayer, loop: applyAddLoop,
    datatable: applyAddDatatable,
    knowledge_write: applyAddKnowledgeWrite,
    flatten: applyAddFlatten,
};

// Map a step type to its builder — DRIVEN BY the step-type table
// (stepTypeTable.js), the same list the batch/replace enums and the prompt read.
// A type in the table without a builder, or a builder the table does not list,
// stops the server at load: the lists cannot drift apart silently any more.
const ADD_FOR_TYPE = {};
for (const type of REPLACEABLE_STEP_TYPES) {
    if (!BUILDERS[type]) throw new Error(`stepTypeTable lists "${type}" as creatable but stepBuilders has no builder for it`);
    ADD_FOR_TYPE[type] = BUILDERS[type];
}
for (const type of Object.keys(BUILDERS)) {
    if (!REPLACEABLE_STEP_TYPES.includes(type)) throw new Error(`stepBuilders has a builder for "${type}" that stepTypeTable does not list`);
}

module.exports = {
    agentPermissionsBlock,
    sanitizeDisabledAgentSkillIds,
    unknownToolError,
    applyTrigger,
    applyAddDatatable,
    applyAddKnowledgeWrite,
    bindingToTemplate,
    sanitizeDatatableBindings,
    sanitizeDatatableCursor,
    coerceSortList,
    resolveDatatableColumns,
    checkExtractionFieldRefs,
    readOnlyTableError,
    DATATABLE_WRITE_OPS,
    modelTierGateError,
    sanitizeAgentId,
    sanitizeSkillIds,
    sanitizeAgentPermissions,
    applyAddAction,
    // builder_add_steps pre-checks an in-turn duplicate with it (addSteps.js).
    findDuplicateAction,
    autoBindRequiredInputs,
    requiredInputError,
    applyAddAi,
    applyAddCondition,
    applyAddGuard,
    applyAddTokenize,
    applyAddUntokenize,
    applyAddLoop,
    applyAddCode,
    applyAddNotification,
    applyAddHttpRequest,
    applyAddFillDocument,
    applyAddSlide,
    applyAddPresentation,
    slideVisualFields,
    deckLookFields,
    normalizeAskOnce,
    normalizeCacheInto,
    applyAddGenerateDocument,
    clampDocumentTtl,
    applyAddDataExtraction,
    sanitizeDataExtractionFields,
    sanitizeDataExtractionSource,
    unwrapDataExtractionInputs,
    translateDataExtractionVocabulary,
    deriveDataExtractionSource,
    loopItemSourceError,
    resolveToolName,
    fileLocationField,
    sanitizeSetOperations,
    applyAddSet,
    sanitizeParseJsonFieldRows,
    PARSE_JSON_RETIRED_MSG,
    applyAddDateTime,
    applyAddWait,
    applyAddFormPage,
    applyAddStopError,
    applyAddSwitch,
    sanitizeSwitchCases,
    applyAddFilter,
    applyAddLimit,
    applyAddDedupe,
    applyAddAggregate,
    applyAddSummarize,
    applyAddArrayOp,
    applyAddNote,
    NOTE_MAX_TEXT_LENGTH,
    NOTE_COLOR_KEYS,
    sanitizeNoteSize,
    ADD_FOR_TYPE,
};
