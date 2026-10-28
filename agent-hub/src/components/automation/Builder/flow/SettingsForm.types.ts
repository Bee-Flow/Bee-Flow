import type { UpstreamNode, UpstreamDefinition, Group } from '../mapping/upstream/upstream.types';
import type { StepIssues } from './nodes/nodeProps';
import type { FormRecord } from './settings/formState/types';
import type { OnFocusField } from '../mapping/focusField.types';
import type { ActionCatalog } from './settings/actionEditors/integrationActionFields';
import type { TriggerFieldsProps, TriggerAutomation } from './settings/triggerEditors.types';
import type { ReactNode } from 'react';
import type { TimelineStep } from '@/components/admin/Studio/Executions/RunStepTimeline';
import type { ModelTierConfig } from '@/hooks/useModelTierSelection';
import type { BlockCatalogEntry } from './settings/actionEditors/flowletCallFields';
import type { FlowEdge } from './types';
import type { OnRenameField } from './settings/fieldDesigner.types';
import type { FormEditorContext } from './settings/FormPageEditor';
import type { InsertUpstreamStep } from './settings/RouteAssist.types';
import type { RouteFollow, WholeRun } from './settings/SourceNotices';

/**
 * Per-step-type form-based editor. Each subcomponent owns its own draft
 * state, computes a patch on Save, and dispatches via `onPatch(patch)`
 * which the inspector merges onto the existing step. Reset reverts to
 * whatever is currently persisted in the step.
 *
 * Field coverage by type:
 *   trigger             — label, kind, schedule (cron/tz), Gmail mail.new filter
 *   integration_action  — label, inputs (key/kind/value editor), tool (read-only)
 *   ai_step             — label, prompt, systemPrompt, modelTier, allowTools, inputs
 *   condition           — label, expr
 *   loop                — label, overRef, itemVar, maxIterations
 *   code                — label, code source
 *   notification        — label, title, body
 *
 * Validation banner + Save/Reset live at the bottom of the form so every
 * type shares the same chrome.
 */
export interface SettingsFormProps {
    step: UpstreamNode & { type: string; appId?: string };
    stepIssues: StepIssues;
    saveError?: string | null;
    onPatch: (patch: FormRecord) => unknown;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    catalog?: ActionCatalog | null;
    rootDefinition?: UpstreamDefinition | null;
    onTestSubmit?: TriggerFieldsProps['onTestSubmit'];
    footerLeft?: ReactNode;
    onExpandOnCanvas?: ((stepId: string) => void) | null;
    runStep?: Pick<TimelineStep, 'status' | 'errorInfo'> | null;
    modelTiers: Record<string, ModelTierConfig>;
    saving?: boolean;
    groups?: Group[];
    automation?: TriggerAutomation | null;
    blocksCatalog?: BlockCatalogEntry[] | null;
    wiredCaseNames?: Set<string> | null;
    stepEdges?: FlowEdge[] | null;
    isSecondaryTrigger?: boolean;
    onRenameField?: OnRenameField | null;
    formEditor?: FormEditorContext | null;
    onInsertUpstreamStep?: InsertUpstreamStep | null;
    routeFollow?: RouteFollow | null;
    wholeRun?: WholeRun | null;
    compactFooter?: boolean;
}
