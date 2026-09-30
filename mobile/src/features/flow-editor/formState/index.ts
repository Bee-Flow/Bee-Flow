/**
 * The node editor's form state: `extractFormState(step)` → the draft a form
 * edits, and `buildPatch(step, draft)` → only the fields that CHANGED, ready to
 * merge into the step. Port of agent-hub `Builder/flow/settings/formState.js`,
 * split per step family (triggerStep, aiStep, actionSteps, documentSteps,
 * flowSteps, dataSteps, extraction, approvalStep); pinned by
 * formState.lockstep.test.ts.
 */

import { extractIntegration, extractCode, extractHttp, extractNotification, patchCode, patchHttp, patchIntegration, patchNotification } from './actionSteps';
import { extractAiStep, patchAiStep } from './aiStep';
import { extractApproval, patchApproval } from './approvalStep';
import { applyRetryPatch, normalizeRetry, RETRY_FORM_TYPES } from './common';
import {
    extractAggregate, extractDatatable, extractDateTime, extractDedupe, extractKnowledgeWrite, extractLimit, extractParseJson,
    extractSet, extractSummarize, patchAggregate, patchDatatable, patchDateTime, patchDedupe, patchKnowledgeWrite, patchLimit,
    patchParseJson, patchSet, patchSummarize,
} from './dataSteps';
import {
    extractFillDocument, extractGenerateDocument, extractPresentation, extractSlide, patchFillDocument, patchGenerateDocument,
    patchPresentation, patchSlide,
} from './documentSteps';
import { extractDataExtraction, patchDataExtraction } from './extraction';
import {
    extractCallInputs, extractFormPage, extractLayerOutput, extractLoop, extractPrivacy, extractReturnToApp, extractRoute,
    extractStopError, extractWait, patchCallInputs, patchFormPage, patchLayerOutput, patchLoop, patchPrivacy, patchReturnToApp,
    patchRoute, patchStopError, patchWait,
} from './flowSteps';
import { deepEqual } from './read';
import { extractTrigger, patchTrigger } from './triggerStep';
import type { Extractor, FormDraft, Patcher, Step, StepPatch } from './types';
import { defaultTriggerLabel } from '../model/triggerLabels';

/** Step type → [extractor, patcher]. A type missing here edits only label and icon. */
const FAMILIES: Record<string, [Extractor, Patcher]> = {
    trigger: [extractTrigger, patchTrigger],
    ai_step: [extractAiStep, patchAiStep],
    integration_action: [extractIntegration, patchIntegration],
    // If / Switch / Filter are ONE node (routeModel); guard / tokenize / untokenize too (privacyModel).
    condition: [extractRoute, patchRoute],
    switch: [extractRoute, patchRoute],
    filter: [extractRoute, patchRoute],
    guard: [extractPrivacy, patchPrivacy],
    tokenize: [extractPrivacy, patchPrivacy],
    untokenize: [extractPrivacy, patchPrivacy],
    loop: [extractLoop, patchLoop],
    code: [extractCode, patchCode],
    notification: [extractNotification, patchNotification],
    http_request: [extractHttp, patchHttp],
    generate_document: [extractGenerateDocument, patchGenerateDocument],
    slide: [extractSlide, patchSlide],
    presentation: [extractPresentation, patchPresentation],
    fill_document: [extractFillDocument, patchFillDocument],
    data_extraction: [extractDataExtraction, patchDataExtraction],
    call_layer: [extractCallInputs, patchCallInputs],
    call_block: [extractCallInputs, patchCallInputs],
    layer_output: [extractLayerOutput, patchLayerOutput],
    set: [extractSet, patchSet],
    parse_json: [extractParseJson, patchParseJson],
    datetime: [extractDateTime, patchDateTime],
    wait: [extractWait, patchWait],
    approval: [extractApproval, patchApproval],
    stop_error: [extractStopError, patchStopError],
    return_to_app: [extractReturnToApp, patchReturnToApp],
    form_page: [extractFormPage, patchFormPage],
    limit: [extractLimit, patchLimit],
    dedupe: [extractDedupe, patchDedupe],
    aggregate: [extractAggregate, patchAggregate],
    summarize: [extractSummarize, patchSummarize],
    datatable: [extractDatatable, patchDatatable],
    knowledge_write: [extractKnowledgeWrite, patchKnowledgeWrite],
};

/** The step types with a family of their own (the lockstep test holds this to the web). */
export const FORM_STEP_TYPES: readonly string[] = Object.keys(FAMILIES);

function family(type: unknown): [Extractor, Patcher] | undefined {
    const key = String(type);
    return Object.hasOwn(FAMILIES, key) ? FAMILIES[key] : undefined;
}

/**
 * Step → the draft its form edits. `retry` is present as a KEY for the types
 * whose retry row the editor offers (null = off), because that presence is
 * what decides whether the row is offered at all.
 */
export function extractFormState(step: Step | null | undefined): FormDraft {
    if (!step) return {};
    const base: FormDraft = { label: step.label || '', icon: step.icon || '' };
    const f = family(step.type);
    const state = f ? f[0](step, base) : base;
    if (RETRY_FORM_TYPES.has(String(step.type))) state.retry = normalizeRetry(step.retry) || null;
    return state;
}

/**
 * Label and icon. A hand-set value locks it against AI auto-naming — but only
 * when it changed in this edit, and a trigger label that is exactly the kind's
 * generated name never counts as hand-picked (BFSF-339).
 */
function namePatch(step: Step, draft: FormDraft): StepPatch {
    const patch: StepPatch = { label: draft.label || null, icon: draft.icon || null };
    if ((draft.label || '') !== (step.label || '')) patch.labelManual = draft.label ? true : null;
    if ((draft.icon || '') !== (step.icon || '')) patch.iconManual = draft.icon ? true : null;
    if (step.type === 'trigger' && draft.label && draft.label === defaultTriggerLabel(draft.kind || 'manual')) {
        patch.labelManual = null;
    }
    return patch;
}

// Meta flags (not on the step): kept whenever set, never diffed.
const META_KEYS = new Set(['labelManual', 'iconManual']);

/**
 * The draft → only the step fields that ACTUALLY CHANGED. Sending every field
 * would clobber a concurrent AI-builder edit to one the user never touched.
 */
export function buildPatch(step: Step, draft: FormDraft): StepPatch {
    const patch = namePatch(step, draft);
    family(step.type)?.[1](patch, step, draft);
    if (RETRY_FORM_TYPES.has(String(step.type))) applyRetryPatch(patch, step, draft);
    const changed: StepPatch = {};
    for (const k of Object.keys(patch)) {
        if (META_KEYS.has(k) || !deepEqual(patch[k], step[k])) changed[k] = patch[k];
    }
    return changed;
}

export * from './approvalStages';
export * from './common';
export * from './outputSchema';
export * from './extraction';
export { AI_STEP_AGENT_PERMISSION_KEYS, MAX_AI_STEP_SKILL_IDS, readAgentPermissions, readSkillIds } from './aiStep';
export { carryPendingRows } from './pendingRows';
export { sanitizeOperations, sanitizeParseJsonFields } from './operations';
export { deepEqual } from './read';
export { matchCounts, suggestOutputs, type MatchCounts, type Suggestion } from './routeIntents';
export type { IntentField } from './routeIntentFields';
export type { FormDraft, StepPatch } from './types';
