/**
 * The pure form <-> step-shape helpers of the automation builder's settings
 * panel. No JSX or React. This barrel is the module's public face: every
 * importer reads `./formState`, and the pieces live next to it by
 * responsibility:
 *
 *   extract/   stored step -> form draft, one extractor per step type
 *   patch/     form draft -> patch, one writer per step type
 *   approvalStages, pendingRows, stepOptions, extractionFields,
 *   aiStepAgent, outputSchema, bindings, dataNodeRows, primitives
 *
 * schemaToFields / fieldsToSchema keep their public export (re-exported by
 * SettingsForm for ToolInputForm and tests).
 */
;
export {
    MAX_APPROVAL_STAGES,
    MAX_SEATS_PER_STAGE,
    MAX_TOTAL_STAGE_SEATS,
    MAX_STAGE_NAME_LEN,
    MAX_STAGE_DESCRIPTION_LEN,
    STAGE_RULES,
    
    
    stageSeats,
    totalStageSeats,
    newStageKey,
    sanitizeApprovalStages,
} from './approvalStages';
export { carryPendingRows } from './pendingRows';
export { defaultLabelPlaceholder, extractFormState } from './extract';
export { buildPatch } from './patch';
export {
    FOREACH_FORM_TYPES,
    RETRY_FORM_TYPES,
    
    
    
    
} from './stepOptions';
;
export {
    EXTRACTION_FIELD_TYPES,
    MAX_EXTRACTION_FIELDS,
    MAX_EXTRACTION_INSTRUCTIONS,
    
    emptyExtractionField,
    coerceExtractionName,
    isEmptyExtractionSource,
    
    
} from './extractionFields';
export { deepEqual } from './primitives';
export {
    
    MAX_AI_STEP_SKILL_IDS,
    readAgentPermissions,
    readSkillIds,
} from './aiStepAgent';
export { OUTPUT_FIELD_TYPES, COLUMN_TYPES, schemaToFields, fieldsToSchema } from './outputSchema';
