import type { ComponentType, ReactNode, RefAttributes } from 'react';
import type { AssistantField } from '../useBuilderShellState';
import type { AddStepPayload, AddStepOptions, Position } from './addStepModel';
import type { BuilderMessage } from './buildTabTypes';
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
    onAskAssistant?: Callback<[stepId?: string, field?: AssistantField | null]>;
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
    aborted?: Record<string, unknown> | boolean | null;
    onDismissFatal?: Callback;
    onFocusStep?: Callback<[stepId: string]>;
}

export const DiagramPane = DiagramPaneJs as unknown as ComponentType<DiagramPaneProps & RefAttributes<DiagramHandle | null>>;

export const AddStepMenu = AddStepMenuJs;

export const CanvasPlanPanel = CanvasPlanPanelJs;

export const AutomationSummary = AutomationSummaryJs;

/** The ask-the-assistant-about-this-field hook the step drawer's fields read. */
export const AssistantFieldProvider = AssistantFieldProviderJs;

export const FlowletsPanel = FlowletsPanelJs;

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

export const AssistantWelcome = AssistantWelcomeJs;

export const MessageBubble = MessageBubbleJs;

export const ProposalCard = ProposalCardJs;

export const PlanReview = PlanReviewJs;

export const RunProgressBanner = RunProgressBannerJs;

export const WorkModePicker = WorkModePickerJs;

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
