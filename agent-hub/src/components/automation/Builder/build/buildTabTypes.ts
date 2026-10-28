/**
 * The builder state as BuildTab and its pieces read it. Only the members read
 * here are named; BuilderShell owns the full shape.
 */
import type { MouseEvent, RefObject, UIEvent } from 'react';
import type { BuilderMessage as StreamMessage, DryRun } from '@/hooks/builderStream';
import type { FlowletAgentState } from '@/hooks/useFlowletAgentStream';
import type { BuilderWebSearchStatus } from '@/hooks/useAutomationBuilderStream';
import type { PlanTodo } from '../BuilderPlanChecklist';
import type { BuilderHeaderProps } from '../BuilderHeader';
import type { BuilderSendOptions } from '../builderSend';
import type { AssistantField } from '../useBuilderShellState';
import type { ReviewPlan } from '../chat/PlanReview';
import type { PendingTable } from '../chat/pendingTables';
import type { FormDef } from '@/components/forms/PublicFormRenderer.types';
import type { FlowDefinition, FlowStep, RunStepRow } from '../flow/types';

/** One message of the builder chat: the stream hook's shape, plus the tool calls this builder adds to it. */
export type BuilderMessage = StreamMessage & { toolCalls?: unknown[] | null };

/** The plan the agent wrote, as the review overlay and the inline card read it. */
interface BuilderPlan extends ReviewPlan {
    [key: string]: unknown;
}

/** A proposal waiting for Apply / Discard. */
export interface BuilderProposal {
    id?: string;
    definition?: FlowDefinition;
    pendingDatatables?: PendingTable[];
    [key: string]: unknown;
}

export interface BuilderTabState {
    messages: BuilderMessage[];
    running?: boolean;
    steps?: RunStepRow[];
    summary?: string;
    todos?: PlanTodo[];
    reviewPlan?: BuilderPlan | null;
    reviewQuestions?: unknown[] | null;
    proposal?: BuilderProposal | null;
    webSearch?: BuilderWebSearchStatus | null;
    turn?: { firstEventAt?: unknown } | null;
    dryRun?: (DryRun & { isTest?: boolean; startedAt?: string | number | null }) | null;
    dryRunSeq?: unknown;
    pendingExternalDraft?: unknown;
    validation?: unknown;
    executingStepId?: string | null;
    aborted?: Record<string, unknown> | boolean | null;
    automationId?: string | null;
    error?: unknown;
}

/** The step a chat mention or the assistant's context points at. */
export interface AssistantContext {
    id: string;
    label: string | undefined;
}

/**
 * The silence before the first token. The waiting card shows while the turn
 * has produced NOTHING yet: the "nothing streamed" test of the old bare
 * "Thinking…" line, plus the turn's own `firstEventAt`, which the stream hook
 * stamps on the first reasoning / text / tool event. Either is enough to drop
 * the card — once anything lands, the thinking block and the activity list
 * render the live state instead.
 */
export function isWaitingForFirstToken(state: BuilderTabState): boolean {
    const tailMsg = state.messages[state.messages.length - 1];
    const nothingStreamedYet = !(tailMsg && tailMsg.role === 'assistant'
        && ((tailMsg.content && tailMsg.content.length)
            || (tailMsg.thinkingParts && tailMsg.thinkingParts.length)
            || (tailMsg.toolCalls && tailMsg.toolCalls.length)));
    return !!state.running && !state.turn?.firstEventAt && nothingStreamedYet;
}

type Fn<A extends unknown[] = [], R = void> = ((...args: A) => R) | null;

/** BuildTab's props, as BuilderShell hands them down. */
export interface BuildTabProps {
    headerProps?: BuilderHeaderProps | null;
    mode?: string;
    /** An automation managed by a Solution stage: the canvas shows, nothing edits. */
    readOnly?: boolean;
    assistantOpen: boolean;
    setAssistantOpen: (open: boolean) => void;
    alwaysPlanLarge?: boolean;
    setAlwaysPlanLarge?: Fn<[boolean]>;
    workMode?: string;
    setWorkMode?: Fn<[string]>;
    assistantContext?: AssistantContext | null;
    onClearAssistantContext?: Fn;
    onAskAssistant?: Fn<[stepId?: string, field?: AssistantField | null]>;
    onApplyProposal: (excluded: Set<string>) => void;
    onDiscardProposal?: () => void;
    onApprovePlan?: Fn<[pauseAfterStep: boolean]>;
    onRejectPlan?: Fn;
    /** An Apply in flight. */
    applyingProposal?: boolean;
    /** Bumped by the shell after Apply created tables (refetch the catalog). */
    catalogNonce?: number;
    chatWidth: number;
    onChatResizeStart: (event: MouseEvent<HTMLElement>) => void;
    /** The form-test overlay: `{ form, runId }` while open. */
    formTest?: { form?: FormDef; runId?: string | null } | null;
    onFormTestRun: (answers: Record<string, unknown>) => Promise<{ run?: { id?: string }; id?: string } | null | undefined>;
    onCloseFormTest: (e?: MouseEvent<HTMLButtonElement>) => void;
    /** (runId) — open that form overlay attached to a run parked on a page. */
    onOpenFormOverlay?: Fn<[runId: string]>;
    /** (runId) — open that run in Runs (the failed-run banner's "View run"). */
    onOpenRun?: Fn<[runId: string]>;
    state: BuilderTabState;
    automation?: { id?: string | null; [key: string]: unknown } | null;
    rootDef: FlowDefinition | null;
    scopedDef: FlowDefinition | null;
    scopeKey: string | null;
    setScopeKey?: Fn<[key: string | null]>;
    onVisualEditRoot?: Fn<[def: FlowDefinition]>;
    chatInput: string;
    setChatInput: (text: string) => void;
    modelTiers: unknown;
    selectedTier: unknown;
    setSelectedTier: unknown;
    user: unknown;
    onSend: (text: string, attachments?: unknown[], opts?: BuilderSendOptions) => unknown;
    onStopBuild?: Fn;
    messagesContainerRef: RefObject<HTMLDivElement | null>;
    messagesBodyRef?: RefObject<HTMLDivElement | null> | null;
    messagesEndRef: RefObject<HTMLDivElement | null>;
    onMessagesScroll?: (event: UIEvent<HTMLDivElement>) => void;
    ndvStepId: string | null;
    ndvDensity?: string;
    setNdvDensity?: Fn<[density: string]>;
    ndvMode?: string | null;
    onNdvModeChange?: Fn<[mode: string]>;
    openNdv: (id: string, density?: string) => void;
    closeNdv: () => void;
    stepById: (id: string | undefined) => FlowStep | null;
    runStepById: (id: string) => RunStepRow | null;
    onSaveStep: (graph: FlowDefinition, layerPatches?: Record<string, FlowDefinition>) => unknown;
    onVisualEdit?: Fn<[def: FlowDefinition]>;
    onExecuteStep: (...args: never[]) => unknown;
    onRetryFromStep: (...args: never[]) => unknown;
    onStopRun?: Fn<[runId: string], unknown>;
    pollRunProgress?: Fn<[runId: string], unknown>;
    fatalError: unknown;
    onDismissFatal: () => void;
    onDiagnose?: Fn;
    acceptExternalDraft?: Fn;
    dismissExternalDraft?: Fn;
    onBuildLayer?: Fn<[text: string], Promise<boolean>>;
    onRefineLayer?: Fn<[key: string, text: string], Promise<boolean>>;
    layerAgentState?: FlowletAgentState | null;
}
