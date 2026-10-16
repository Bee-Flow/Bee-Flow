// The assistant column of the build tab: header, message thread and composer.
// Split out of BuildTab without a change in behaviour.
import { Sparkles, X } from 'lucide-react';
import type { ReactNode, RefObject, UIEvent } from 'react';
import { isWaitingForFirstToken } from './buildTabTypes';
import type { AssistantContext, BuilderTabState } from './buildTabTypes';
import {
    AssistantWelcome, InputArea, MessageBubble, ProposalCard, WorkModePicker,
} from './jsComponents';
import { useTranslation } from '../../../../hooks/useTranslation';
import BuilderWaitingCard from '../chat/BuilderWaitingCard';
import PlanInlineCard from '../chat/PlanInlineCard';
import QuestionsCard from '../chat/QuestionsCard';
import { webSearchUnavailableHint } from '../chat/webSearchStatus';
import { WORK_MODES } from '../chat/WorkModePicker';
import { isWorkModeShortcut, nextWorkMode } from '../chat/workModeShortcut';
import type { LiveRunFocus } from '../chat/toolCallDisplay';
import type { OutputLookup } from '../chat/ProposalCard';
import type { FlowDefinition, FlowStep } from '../flow/types';

type SendFn = (text: string, attachments?: unknown[], opts?: { answers?: unknown }) => unknown;

export interface AssistantColumnProps {
    state: BuilderTabState;
    chatWidth: number;
    scopedDef: FlowDefinition | null;
    flatDef: FlowDefinition | null;
    ndvStep: FlowStep | null;
    stepById: (id: string | undefined) => FlowStep | null;
    assistantContext: AssistantContext | null;
    onClearAssistantContext?: (() => void) | null;
    onAskAssistant?: ((stepId?: string, field?: unknown) => void) | null;
    setAssistantOpen: (open: boolean) => void;
    reviewOpen: boolean;
    setReviewOpen: (open: boolean) => void;
    onApprovePlan?: ((pauseAfterStep: boolean) => void) | null;
    onApplyProposal: (excluded: Set<string>) => void;
    onDiscardProposal?: () => void;
    applyingProposal: boolean;
    onPreviewProposal: () => void;
    realOutputById: OutputLookup | null;
    liveRunFocus: LiveRunFocus | null;
    onFocusStep: (id: string) => void;
    messagesContainerRef: RefObject<HTMLDivElement | null>;
    messagesBodyRef?: RefObject<HTMLDivElement | null> | null;
    messagesEndRef: RefObject<HTMLDivElement | null>;
    onMessagesScroll?: (event: UIEvent<HTMLDivElement>) => void;
    composer: AssistantComposerProps;
}

/** The chat column. Collapses entirely when the assistant is closed. */
export default function AssistantColumn(p: AssistantColumnProps) {
    const { t } = useTranslation();
    const { state } = p;
    const approve = (pauseAfterStep: boolean) => { p.setReviewOpen(false); p.onApprovePlan?.(pauseAfterStep); };
    return (
        <div
            style={{ width: p.chatWidth }}
            className="@container/assistant flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--border-default)] flex-shrink-0 min-w-[240px] max-w-[600px]"
            data-popover-boundary
            data-surface="subtle"
        >
            <div className="flex items-center justify-between gap-2 px-3 h-12 bg-[var(--bg-card)] border-b border-[var(--border-default)]">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="w-7 h-7 rounded-lg bg-[color-mix(in_srgb,var(--type-ai)_14%,transparent)] text-[var(--type-ai)] flex items-center justify-center flex-shrink-0">
                        <Sparkles size={14} />
                    </span>
                    <span className="text-sm font-semibold text-[var(--text-primary)] truncate">{t('automations.assistant.title', 'Assistant')}</span>
                    {state.reviewPlan && <button type="button" onClick={() => p.setReviewOpen(!p.reviewOpen)} aria-pressed={p.reviewOpen} className="rounded-md px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">{t('automations.assistant.plan', 'Plan')} v{state.reviewPlan.version}</button>}
                </div>
                <button
                    onClick={() => p.setAssistantOpen(false)}
                    title={t('automations.assistant.close', 'Close the assistant')}
                    aria-label={t('automations.assistant.close', 'Close the assistant')}
                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
                >
                    <X size={15} />
                </button>
            </div>
            <div ref={p.messagesContainerRef} onScroll={p.onMessagesScroll} className="flex-1 overflow-y-auto px-4 py-4 custom-scrollbar">
                {state.messages.length === 0 && (
                    <AssistantWelcome
                        triggerKind={p.scopedDef?.trigger?.kind}
                        definition={p.scopedDef}
                        selectedStep={p.ndvStep || p.stepById(p.assistantContext?.id)}
                        onPick={(text) => p.composer.setChatInput(text)}
                    />
                )}
                <div ref={p.messagesBodyRef} className="flex flex-col gap-4 w-full max-w-[900px] mx-auto">
                    {state.messages.map((m, i) => (
                        <MessageBubble
                            key={i}
                            msg={m}
                            onFocusStep={p.onFocusStep}
                            // Only the message being streamed — a run belongs
                            // to the turn that started it.
                            liveRun={i === state.messages.length - 1 ? p.liveRunFocus : null}
                        />
                    ))}
                    {/* Before anything has streamed in — on a local model,
                        minutes — the column shows what HAS happened and how
                        long this usually takes, instead of a bare "Thinking…"
                        that read as a hang. */}
                    {isWaitingForFirstToken(state) && (
                        <BuilderWaitingCard />
                    )}
                    {/* No `running` here: the questions event arrives while the stream is still closing (the turn ends right after the call), and a card mounted greyed-out and disabled read as unusable. Sending aborts what is left of that stream. */}
                    <QuestionsCard key={state.reviewQuestions?.[0]?.id || 'questions'} questions={state.reviewQuestions} onAnswer={(text, answers) => p.composer.onSend(text, [], { answers })} />
                    {!state.reviewQuestions?.length && <PlanInlineCard plan={state.reviewPlan} running={state.running} onOpen={() => p.setReviewOpen(true)} onApprove={approve} />}
                    <ProposalCard key={state.proposal?.id || 'preview'} realOutputById={p.realOutputById} proposal={state.proposal} running={state.running} applying={p.applyingProposal} onApply={p.onApplyProposal} onDiscard={p.onDiscardProposal} onPreview={p.onPreviewProposal} />
                    <div ref={p.messagesEndRef} />
                </div>
            </div>
            <AssistantComposer {...p.composer} />
        </div>
    );
}

export interface AssistantComposerProps {
    state: BuilderTabState;
    flatDef: FlowDefinition | null;
    chatInput: string;
    setChatInput: (text: string) => void;
    onSend: SendFn;
    onStopBuild?: (() => void) | null;
    applyingProposal: boolean;
    workMode: string;
    setWorkMode?: ((mode: string) => void) | null;
    alwaysPlanLarge: boolean;
    setAlwaysPlanLarge?: ((value: boolean) => void) | null;
    assistantContext: AssistantContext | null;
    onClearAssistantContext?: (() => void) | null;
    onAskAssistant?: ((stepId?: string, field?: unknown) => void) | null;
    modelTiers: unknown;
    selectedTier: unknown;
    setSelectedTier: unknown;
    user: unknown;
}

/** The composer under the thread: step context chip, @-mentions and the input. */
function AssistantComposer(p: AssistantComposerProps) {
    const { t } = useTranslation();
    const { state, setWorkMode } = p;
    let toolbarExtra: ReactNode = null;
    if (setWorkMode) {
        toolbarExtra = <WorkModePicker anchor="composer" alwaysPlanLarge={p.alwaysPlanLarge} onAlwaysPlanLargeChange={p.setAlwaysPlanLarge} value={p.workMode} onChange={setWorkMode} disabled={state.running} planStatus={state.reviewPlan?.status} planVersion={state.reviewPlan?.version} />;
    }
    return (
        <div className="w-full flex flex-col flex-shrink-0 p-3" onKeyDownCapture={e => {
            if (isWorkModeShortcut(e.nativeEvent) && setWorkMode && !state.running) {
                e.preventDefault();
                setWorkMode(nextWorkMode(WORK_MODES, p.workMode));
            }
        }}>
            {p.assistantContext && <div className="flex items-center gap-1.5 mb-2 px-2 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[11px] text-[var(--type-ai)]"><Sparkles size={12} /><span className="flex-1 min-w-0 truncate">@{p.assistantContext.label}</span><button type="button" onClick={p.onClearAssistantContext || undefined} aria-label={t('automations.assistant.clear_context', 'Clear step context')}><X size={12} /></button></div>}
            {/(?:^|\s)@[^@\s]*$/.test(p.chatInput) && <StepMentionList {...p} />}
            {p.applyingProposal && <p role="status" className="mb-2 text-[11px] text-[var(--text-tertiary)]">{t('automations.assistant.applying_hint', 'Applying the proposal. You can write again in a moment.')}</p>}
            <InputArea
                compact
                placeholder={t('automations.assistant.placeholder', 'Describe what you want…')}
                webSearchUnavailable={webSearchUnavailableHint(state.webSearch, t)}
                toolbarExtra={toolbarExtra}
                onSendMessage={p.applyingProposal ? () => {} : p.onSend}
                onStopGenerating={p.onStopBuild || undefined}
                isLoading={state.running}
                directMode={true}
                modelTiers={p.modelTiers}
                selectedTier={p.selectedTier}
                onTierChange={p.setSelectedTier}
                input={p.chatInput}
                setInput={p.setChatInput}
                user={p.user}
                messages={state.messages}
            />
        </div>
    );
}

/** The steps an "@…" at the end of the input can mention. */
function StepMentionList({ flatDef, chatInput, setChatInput, assistantContext, onAskAssistant }: AssistantComposerProps) {
    const { t } = useTranslation();
    const query = (chatInput.split('@').at(-1) || '').toLowerCase();
    const steps = [flatDef?.trigger, ...(flatDef?.triggers || []), ...(flatDef?.steps || [])]
        .filter((step): step is FlowStep => !!step)
        .filter(step => (step.label || step.type || step.kind || '').toLowerCase().includes(query));
    const pick = (step: FlowStep) => {
        onAskAssistant?.(step.id);
        setChatInput(chatInput.replace(/@[^@\s]*$/, ''));
    };
    return (
        <div className="mb-2 max-h-44 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-1" role="listbox" aria-label={t('automations.assistant.mention_step', 'Mention a step')}>
            {steps.map(step => <button key={step.id} type="button" role="option" aria-selected={assistantContext?.id === step.id} onClick={() => pick(step)} className="block w-full rounded-lg px-2 py-2 text-left text-xs hover:bg-[var(--bg-secondary)]">@{step.label || step.type || step.kind}</button>)}
        </div>
    );
}
