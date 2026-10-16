// §WS5 — BuildTab body, extracted verbatim from BuilderShell.jsx. The shell
// keeps orchestration state; BuildTab is the build-tab UI (canvas, ribbon,
// chat column, inspector overlay). Its prop list is fully explicit
// (build/buildTabTypes.ts); what it computes lives in build/useBuildTabModel.ts
// and the pieces it draws in build/.
import { useEffect, useState } from 'react';
import AssistantColumn from './build/AssistantColumn';
import BuildDiagramColumn from './build/BuildCanvas';
import type { BuildTabProps } from './build/buildTabTypes';
import { AutomationSummary } from './build/jsComponents';
import useBuildTabModel from './build/useBuildTabModel';
import type { BuildTabModel } from './build/useBuildTabModel';
import BuilderHeader from './BuilderHeader';
import AddStepRibbon from './flow/AddStepRibbon';

/**
 * Build tab body — extracted so BuilderShell stays compact and the
 * floating validation pill, focus-mode toggle, and inspector overlay
 * have a clear scope.
 *
 * Owns the slide-in NodePalette state because three different events
 * open it (auto on empty draft, FAB click, edge-end-drop) and they all
 * need to round-trip through the same handler that runs
 * `applyAddNode(definition, payload, position, sourceId)`.
 */
export default function BuildTab(props: BuildTabProps) {
    const { state, mode = 'automation', readOnly = false, headerProps = null } = props;
    const m = useBuildTabModel(props);

    // The assistant is summonable: shown only when opened, and never in step
    // mode (v1 Steps are built visually — no AI chat).
    const showChat = props.assistantOpen && mode !== 'step' && !readOnly;
    const [reviewOpen, setReviewOpen] = useState(false);
    const [previewOpen, setPreviewOpen] = useState(false);
    const reviewPlanId = state.reviewPlan?.id;
    useEffect(() => { if (reviewPlanId && ['review', 'paused'].includes(state.reviewPlan?.status || '')) setReviewOpen(true); }, [reviewPlanId, state.reviewPlan?.status]);
    useEffect(() => { if (!state.proposal) setPreviewOpen(false); }, [state.proposal]);

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Command bar: back · Build▾ · ribbon tabs · title · run · assistant
                — one Word-style row (tabs left, title to their right). */}
            {headerProps && (
                <BuilderHeader {...headerProps} flush infoSlot={<BuildSummary p={props} />} />
            )}
            {/* The ribbon STAYS while the drawer is open: it is how a step gets
                added, and closing the editor to add one was the wrong trade
                (2026-09-03). Collapsed it is one 48px row; the drawer caps
                itself at calc(100% - 200px) and the canvas row keeps a 220px
                minimum, so nothing is squeezed out. */}
            {!readOnly && <BuildRibbon p={props} m={m} />}
            <div className="flex flex-1 min-h-0">
                {showChat && (
                    <AssistantColumn
                        state={state}
                        chatWidth={props.chatWidth}
                        scopedDef={props.scopedDef}
                        flatDef={m.flowlets.flatDef}
                        ndvStep={m.drawer.ndvStep}
                        stepById={props.stepById}
                        assistantContext={props.assistantContext || null}
                        setAssistantOpen={props.setAssistantOpen}
                        reviewOpen={reviewOpen}
                        setReviewOpen={setReviewOpen}
                        onApprovePlan={props.onApprovePlan}
                        onApplyProposal={props.onApplyProposal}
                        onDiscardProposal={props.onDiscardProposal}
                        applyingProposal={!!props.applyingProposal}
                        onPreviewProposal={() => setPreviewOpen(true)}
                        realOutputById={m.realOutputById}
                        liveRunFocus={m.run.liveRunFocus}
                        onFocusStep={(id) => { props.openNdv(id); m.diagramRef.current?.focusStep?.(id); }}
                        messagesContainerRef={props.messagesContainerRef}
                        messagesBodyRef={props.messagesBodyRef}
                        messagesEndRef={props.messagesEndRef}
                        onMessagesScroll={props.onMessagesScroll}
                        composer={composerProps(props, m)}
                    />
                )}
                {showChat && (
                    <div
                        onMouseDown={props.onChatResizeStart}
                        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--accent)]/40 active:bg-[var(--accent)]/60 transition-colors z-10"
                    />
                )}
                <BuildDiagramColumn
                    p={props}
                    m={m}
                    reviewOpen={reviewOpen}
                    setReviewOpen={setReviewOpen}
                    previewOpen={previewOpen}
                    setPreviewOpen={setPreviewOpen}
                />
            </div>
        </div>
    );
}

/** The header's "what this does" summary, of the flowlet when scoped into one. */
function BuildSummary({ p }: { p: BuildTabProps }) {
    const { scopeKey, rootDef, state } = p;
    const layer = scopeKey ? rootDef?.layers?.[scopeKey] : null;
    return (
        <AutomationSummary
            label={layer ? 'What this flowlet does' : 'What this automation does'}
            text={layer
                ? ((layer.description as string) || '')
                : (state.summary || (rootDef?.description as string) || '')}
        />
    );
}

/**
 * Office-style "Add step" ribbon — the active tab's category groups, with
 * undo/redo at the start and Search/auto-map at the end.
 */
function BuildRibbon({ p, m }: { p: BuildTabProps; m: BuildTabModel }) {
    const running = !!p.state.running;
    return (
        <AddStepRibbon
            scope={m.paletteScope}
            hasTrigger={!!p.scopedDef?.trigger}
            disabled={running}
            // Presenting: inert but not dimmed, apps tab up, panel open: the
            // AI is dealing cards from it. `disabled` stays for the no-trigger
            // branch, which has no cards to deal.
            presenting={running}
            rootRef={m.ribbonRootRef}
            // The no-trigger row seeds the trigger through the palette path;
            // every step goes after the anchor.
            onAddNode={p.scopedDef?.trigger ? m.surfaces.handleRibbonAdd : m.surfaces.handleAddNode}
            anchor={m.surfaces.ribbonAnchorStep}
            usageVersion={m.smart.usageTick}
        />
    );
}

function composerProps(p: BuildTabProps, m: BuildTabModel) {
    return {
        state: p.state,
        flatDef: m.flowlets.flatDef,
        chatInput: p.chatInput,
        setChatInput: p.setChatInput,
        onSend: p.onSend,
        onStopBuild: p.onStopBuild,
        applyingProposal: !!p.applyingProposal,
        workMode: p.workMode ?? 'approve',
        setWorkMode: p.setWorkMode,
        alwaysPlanLarge: p.alwaysPlanLarge ?? true,
        setAlwaysPlanLarge: p.setAlwaysPlanLarge,
        assistantContext: p.assistantContext || null,
        onClearAssistantContext: p.onClearAssistantContext,
        onAskAssistant: p.onAskAssistant,
        modelTiers: p.modelTiers,
        selectedTier: p.selectedTier,
        setSelectedTier: p.setSelectedTier,
        user: p.user,
    };
}
