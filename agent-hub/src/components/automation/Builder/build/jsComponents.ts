import type { ComponentType, ReactNode, RefAttributes } from 'react';
import type { AddStepPayload, AddStepOptions, Position } from './addStepModel';
import type { BuilderMessage, BuilderPlan, BuilderProposal } from './buildTabTypes';
import InputAreaJs from '../../../chat/InputArea';
import CanvasPlanPanelJs from '../CanvasPlanPanel';
import { AssistantFieldProvider as AssistantFieldProviderJs } from '../chat/AssistantFieldContext';
import AssistantWelcomeJs from '../chat/AssistantWelcome';
import AutomationSummaryJs from '../chat/AutomationSummary';
import MessageBubbleJs from '../chat/MessageBubble';
import PlanReviewJs from '../chat/PlanReview';
import ProposalCardJs from '../chat/ProposalCard';
import RunProgressBannerJs from '../chat/RunProgressBanner';
import WorkModePickerJs from '../chat/WorkModePicker';
import DiagramPaneJs from '../DiagramPane';
import AddStepMenuJs from '../flow/AddStepMenu';
import type { FlowDefinition, FlowStep, RunStepRow } from '../flow/types';
import FlowletsPanelJs from '../FlowletsPanel';
import FormRunOverlayJs from '../FormRunOverlay';
import NodeDetailViewJs from '../NodeDetailView';
import type { RunIdentity } from '../flow/useFailedRunBanner';

type Callback<A extends unknown[] = []> = ((...args: A) => void) | null;

/** What BuildTab asks of the canvas through its ref. */
export interface DiagramHandle {
    getCenter?: () => Position | null;
    focusStep?: (stepId: string) => void;
}

/** The canvas props BuildTab passes (DiagramPane documents each one). */
export interface DiagramPaneProps {
    definition?: FlowDefinition | null;
    catalog?: unknown;
    editable?: boolean;
    runSteps?: RunStepRow[];
    replayStepId?: string | null;
    formUrl?: string | null;
    onOpenFormOverlay?: Callback;
    onNodeClick?: Callback<[id: string]>;
    onNodeExpand?: Callback<[id: string]>;
    validation?: unknown;
    structuralEditsBlocked?: boolean;
    buildCue?: unknown;
    cameraInsetLeft?: number;
    ribbonRootRef?: unknown;
    onDefinitionChange?: Callback<[def: FlowDefinition]>;
    onStepAdded?: Callback<[payload: AddStepPayload, source?: FlowStep | null]>;
    onRequestAddNode?: Callback<[req: { sourceId: string; position: Position | null; sourceHandle?: string | null }]>;
    onRequestOpenPalette?: Callback;
    onAddTrigger?: Callback<[payload: AddStepPayload | null]>;
    onOpenAssistant?: Callback;
    onAskAssistant?: Callback<[stepId?: string, field?: unknown]>;
    editingStepId?: string | null;
    onRequestAddAfter?: Callback<[nodeId: string | null]>;
    onRequestInsertOnEdge?: Callback<[req: {
        sourceId: string; targetId: string; position?: Position | null; sourceHandle?: string | null;
        label?: string | null; caseName?: string | null;
    }]>;
    onDropStep?: Callback<[payload: AddStepPayload, target?: AddStepOptions]>;
    onExecuteStep?: (...args: never[]) => unknown;
    executingStepId?: string | null;
    runInFlight?: boolean;
    runIdentity?: RunIdentity | null;
    onDiagnose?: Callback;
    realOutputById?: unknown;
    autoMapEnabled?: boolean;
    onAutoMapped?: Callback<[id: string, count: number, forEachEnabled: boolean]>;
    onOpenLayer?: Callback<[key: string]>;
    layerSummaries?: Record<string, string>;
    highlightedStepId?: string | null;
    sidecar?: unknown;
    shiftById?: unknown;
    onToggleInline?: unknown;
    onExpandAllFlowlets?: unknown;
    onCollapseAllFlowlets?: unknown;
    layerRefCounts?: unknown;
    flowletsOpen?: boolean;
    onToggleFlowlets?: Callback;
    flowletCount?: number;
    fatalError?: unknown;
    aborted?: boolean;
    onDismissFatal?: Callback;
    onFocusStep?: Callback<[stepId: string]>;
}

export const DiagramPane = DiagramPaneJs as unknown as ComponentType<DiagramPaneProps & RefAttributes<DiagramHandle | null>>;

export const AddStepMenu = AddStepMenuJs as unknown as ComponentType<{
    scope: Record<string, unknown>;
    showSearch?: boolean;
    autoFocus?: boolean;
    onAdd: (payload: AddStepPayload | null) => void;
    onAfterAdd?: () => void;
}>;

export const CanvasPlanPanel = CanvasPlanPanelJs as unknown as ComponentType<{
    todos?: unknown[];
    running?: boolean;
    t: unknown;
    idPrefix?: string;
    style?: Record<string, number | string> | null;
}>;

export const AutomationSummary = AutomationSummaryJs as unknown as ComponentType<{ label: string; text: string }>;

/** The ask-the-assistant-about-this-field hook the step drawer's fields read. */
export const AssistantFieldProvider = AssistantFieldProviderJs as unknown as ComponentType<{
    value: ((field: unknown) => void) | null;
    children?: ReactNode;
}>;

export const FlowletsPanel = FlowletsPanelJs as unknown as ComponentType<{
    onClose: () => void;
    rootDef: FlowDefinition | null;
    currentScopeKey?: string | null;
    onOpenLayer: (key: string) => void;
    onRenameLayer: unknown;
    onDeleteLayer: unknown;
    refCountFor: unknown;
    onCreateLayer: unknown;
    aiEnabled?: boolean;
    onToggleAi: unknown;
    onSummarize: unknown;
    summarizingKey?: string | null;
    rootDescription?: string;
    onSummarizeRoot: unknown;
    summarizingRoot?: boolean;
    onBuildLayer?: unknown;
    onRefineLayer?: unknown;
    layerAgentState?: unknown;
}>;

export const FormRunOverlay = FormRunOverlayJs as unknown as ComponentType<{
    automationId?: string | null;
    form?: unknown;
    runId?: string | null;
    onStartRun?: unknown;
    onClose?: unknown;
}>;

export const NodeDetailView = NodeDetailViewJs as unknown as ComponentType<{
    density?: string;
    onDensityChange?: unknown;
    mode?: string | null;
    onModeChange?: unknown;
    step: FlowStep;
    runStep?: RunStepRow | null;
    runSteps?: RunStepRow[];
    realOutputById?: unknown;
    catalog?: unknown;
    definition?: FlowDefinition | null;
    rootDefinition?: FlowDefinition | null;
    automation?: unknown;
    blocksCatalog?: unknown[];
    onSaveStep: (def: FlowDefinition) => unknown;
    onRenameBinding?: unknown;
    onInsertStepBefore?: unknown;
    onFollowRoute?: unknown;
    validation?: unknown;
    modelTiers?: unknown;
    onExecuteStep?: unknown;
    onRetryFromStep?: unknown;
    runInFlight?: boolean;
    executingStep?: boolean;
    onDeleteStep?: unknown;
    onDuplicateStep?: unknown;
    onNavigate?: (id: string) => void;
    onExpandOnCanvas?: unknown;
    onAddAfterStep?: unknown;
    onClose: () => void;
}>;

/**
 * The JavaScript components BuildTab's TypeScript pieces render, with the prop
 * types they are used with. Their `= null` defaults would otherwise type every
 * optional prop as `null` for a TypeScript caller.
 */

export const AssistantWelcome = AssistantWelcomeJs as unknown as ComponentType<{
    triggerKind?: string;
    definition?: FlowDefinition | null;
    selectedStep?: FlowStep | null;
    onPick: (text: string) => void;
}>;

export const MessageBubble = MessageBubbleJs as unknown as ComponentType<{
    msg: BuilderMessage;
    liveRun?: unknown;
    onFocusStep?: ((id: string) => void) | null;
}>;

export const ProposalCard = ProposalCardJs as unknown as ComponentType<{
    proposal?: BuilderProposal | null;
    running?: boolean;
    applying?: boolean;
    onApply?: (() => void) | null;
    onDiscard?: (() => void) | null;
    onPreview: () => void;
    realOutputById: unknown;
}>;

export const PlanReview = PlanReviewJs as unknown as ComponentType<{
    plan: BuilderPlan;
    running?: boolean;
    onApprove: (pauseAfterStep: boolean) => void;
    onComment?: ((section: string, index: number, line: string) => void) | null;
    onClose: () => void;
    onReject?: (() => void) | null;
}>;

export const RunProgressBanner = RunProgressBannerJs as unknown as ComponentType<{
    run: unknown;
    steps?: RunStepRow[];
    onStop: () => void;
}>;

export const WorkModePicker = WorkModePickerJs as unknown as ComponentType<{
    value?: string;
    onChange: (mode: string) => void;
    disabled?: boolean;
    alwaysPlanLarge?: boolean;
    onAlwaysPlanLargeChange?: ((value: boolean) => void) | null;
    anchor?: string;
    planStatus?: string | null;
    planVersion?: number | string | null;
}>;

export const InputArea = InputAreaJs as unknown as ComponentType<{
    compact?: boolean;
    placeholder?: string;
    webSearchUnavailable?: string | null;
    toolbarExtra?: ReactNode;
    onSendMessage: (text: string, ...rest: never[]) => unknown;
    onStopGenerating?: () => void;
    isLoading?: boolean;
    directMode?: boolean;
    modelTiers?: unknown;
    selectedTier?: unknown;
    onTierChange?: unknown;
    input: string;
    setInput: (text: string) => void;
    user?: unknown;
    messages?: BuilderMessage[];
}>;
