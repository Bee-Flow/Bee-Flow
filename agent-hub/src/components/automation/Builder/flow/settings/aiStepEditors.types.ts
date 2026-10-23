import type { FormRecord } from './formState/types';
import type { SetField } from './agentStep/useAgentStepState';
import type { ModelTierConfig } from '../../../../../hooks/useModelTierSelection';
import type { Group } from '../../mapping/upstream/upstream.types';
import type { OnFocusField } from '../../mapping/focusField.types';
import type { ActionCatalog } from './actionEditors/integrationActionFields';
import type { TimelineStep } from '../../../../admin/Studio/Executions/RunStepTimeline';
import type { StepIssues } from './../nodes/nodeProps';

export interface AiStepFieldsProps {
    draft: FormRecord;
    set: SetField;
    modelTiers?: Record<string, ModelTierConfig>;
    groups?: Group[];
    onFocusField: OnFocusField | null;
    catalog?: ActionCatalog | null;
    previewSample?: unknown;
    errorSections?: Set<string>;
    runStep?: Pick<TimelineStep, 'status' | 'errorInfo'> | null;
    stepIssues?: StepIssues | null;
}

/**
 * Tool selector for the AI step. Mirrors the agent editor's app picker but at
 * per-tool granularity: the user picks individual catalog actions, stored as
 * `tools` (function names). `allowTools` is derived from the selection.
 *
 * Legacy steps carry `allowTools: true` with no `tools` array — that means
 * "every permitted tool". We surface that as an "All available tools" state and
 * only convert it to an explicit list once the user opens the picker.
 */
export interface AiStepToolSelectProps {
    draft: FormRecord;
    set: SetField;
    catalog?: ActionCatalog | null;
}

/**
 * Knowledge Base grounding picker for the ai_step (BFSF-410) — a checkbox list
 * over GET /api/kb, same data source and interaction as App Studio's
 * KbMultiSelect (AiActionEditors.jsx), reimplemented locally rather than
 * imported: that one is styled with App Studio's FormField/INPUT_CLS, and the
 * automation Builder has its own FormRow/formPrimitives chrome the rest of this
 * file already uses — a straight import would mix two design systems on one
 * node. The runtime authority is server-side (execAiStep re-checks every id
 * against the running user/org before ever searching it); this list is
 * advisory — it shows every KB the /api/kb endpoint already scopes to the
 * signed-in user, same as every other KB picker in the product.
 *
 * `?context=ai_step` (K5) narrows it further, to the bases whose owner made
 * them available to AUTOMATIONS. Without it the picker offers bases that
 * activation will refuse — and the refusal arrives days later, on the step
 * that was supposed to go live, rather than here where the choice was made.
 * A base that never expressed a context still appears: a missing value means
 * everywhere, or this would empty the picker on every install predating the
 * column.
 */
export interface KnowledgeBaseRow {
    id: string;
    name?: string;
}

export interface AiStepKbSelectProps {
    draft: FormRecord;
    set: SetField;
}
