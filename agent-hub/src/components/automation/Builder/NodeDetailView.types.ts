import type { ComponentProps } from 'react';
import type ApprovalActionBar from './approvals/ApprovalActionBar';
import type { UpstreamNode, UpstreamDefinition } from './mapping/upstream/upstream.types';
import type { RunStepRow } from './flow/types';
import type { BlockCatalogEntry } from './flow/settings/actionEditors/flowletCallFields';
import type { PlacedStep } from './flow/settings/routeHandoff';
import type { ModelTierConfig } from '../../../hooks/useModelTierSelection';
import type { FormDensity, FormMode } from './flow/settings/formDensity';
import type { TriggerAutomation } from './flow/settings/triggerEditors.types';
import type { Validation } from './flow/matchValidationToStep';
import type { ToolCatalog } from './useNodeDetailData';
import type { NextSuggestion } from './output/UsedBy';

/** What a settings field hands back when it takes focus: where a click in the Incoming tree inserts. */
export interface FocusedField {
    label?: string;
    insert?: (path: string, opts?: { raw?: boolean; }) => void;
}

export type ApprovalDecl = { fields?: ComponentProps<typeof ApprovalActionBar>['fields']; };

export interface NodeDetailViewProps {
    step: UpstreamNode | null;
    runStep: RunStepRow | null;
    definition: UpstreamDefinition | null;
    rootDefinition?: UpstreamDefinition | null;
    blocksCatalog?: BlockCatalogEntry[];
    onSaveStep: ((next: unknown) => Promise<unknown> | unknown) | null;
    onRenameBinding?: ((base: string, from: string, to: string) => number | undefined) | null;
    onInsertStepBefore?: ((stepId: string, step: PlacedStep) => boolean | void) | null;
    modelTiers?: Record<string, ModelTierConfig>;
    onExecuteStep?: (stepId: string, opts?: { mode?: string; triggerPayload?: Record<string, unknown>; openForm?: boolean; }) => unknown;
    onRetryFromStep?: ((stepId: string) => void) | null;
    onDensityChange?: ((density: FormDensity) => void) | null;
    mode?: FormMode | null;
    onModeChange?: ((mode: FormMode) => void) | null;
    automation?: TriggerAutomation | null;
    realOutputById?: ReadonlyMap<string, unknown> | null;
    onExpandOnCanvas?: ((stepId: string) => void) | null;
    runSteps?: RunStepRow[];
    onFollowRoute?: ((routeId: string, stepIds: string[]) => void) | null;
    validation: Validation | null;
    runInFlight?: boolean;
    executingStep?: boolean;
    onClose: () => void;
    density?: FormDensity;
    onDeleteStep?: ((id: string) => void) | null;
    onDuplicateStep?: ((id: string) => void) | null;
    catalog?: ToolCatalog | null;
    onNavigate?: ((stepId: string) => void) | null;
    onAddAfterStep?: ((stepId: string, suggestion: NextSuggestion) => void) | null;
}

export type { RunStepRow } from './flow/types';
export type { PlacedStep } from './flow/settings/routeHandoff';
export type { BlockCatalogEntry } from './flow/settings/actionEditors/flowletCallFields';
export type { TriggerAutomation } from './flow/settings/triggerEditors.types';
export type { Group, UpstreamDefinition, UpstreamNode } from './mapping/upstream/upstream.types';
export type { ModelTierConfig } from '../../../hooks/useModelTierSelection';
export type { Validation } from './flow/matchValidationToStep';
export type { ToolCatalog } from './useNodeDetailData';
export type { NextSuggestion } from './output/UsedBy';
