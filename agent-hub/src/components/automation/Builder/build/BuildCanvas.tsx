// The build tab's diagram column: the canvas with its furniture, the flowlets
// drawer, the step drawer and the form-test overlay. Split out of BuildTab
// without a change in behaviour.
import { Suspense } from 'react';
import { lazyWithI18n } from '../../../../utils/lazyWithReload';
import { runIdentityOf } from './runIdentity';
import { autoMapToastMessage } from './addStepModel';
import type { BuildTabProps } from './buildTabTypes';
import { AssistantLauncher, ContextAddPopover, ExternalDraftBanner, ProposalPreviewOverlay } from './CanvasOverlays';
import {
    AssistantFieldProvider, CanvasPlanPanel, DiagramPane, FlowletsPanel, NodeDetailView, PlanReview, RunProgressBanner,
} from './jsComponents';
import type { DiagramPaneProps } from './jsComponents';
import type { BuildTabModel } from './useBuildTabModel';
import { toast } from '../../../shared/Toast';
import type { CatalogTable } from '../chat/pendingTables';

// The form-test overlay (with the scenario picker) opens on demand.
const FormRunOverlay = lazyWithI18n(() => import('../FormRunOverlay'));

// The plan panel floats over the canvas's left edge: 240 px wide, 12 px clear
// of the edge, and the build camera frames in what is left of the canvas.
const PLAN_PANEL_INSET_PX = 264;

interface ColumnProps {
    p: BuildTabProps;
    m: BuildTabModel;
    reviewOpen: boolean;
    setReviewOpen: (open: boolean) => void;
    previewOpen: boolean;
    setPreviewOpen: (open: boolean) => void;
}

/**
 * Diagram column — fills remaining width and (most of) the height. The
 * add-step ribbon lives in the bar above; the canvas takes this row.
 */
export default function BuildDiagramColumn({ p, m, reviewOpen, setReviewOpen, previewOpen, setPreviewOpen }: ColumnProps) {
    const { state, setAssistantOpen, setWorkMode, setChatInput } = p;
    const { t } = m;
    const ndvStep = m.drawer.ndvStep;
    return (
        <div className="flex-1 min-w-0 flex flex-col relative bg-[var(--bg-primary)]">
            {reviewOpen && state.reviewPlan && <PlanReview plan={state.reviewPlan} running={state.running} onReject={p.onRejectPlan} onApprove={pauseAfterStep => { setReviewOpen(false); p.onApprovePlan?.(pauseAfterStep); }} onClose={() => setReviewOpen(false)} onComment={(section, index, line) => {
                setAssistantOpen(true);
                setWorkMode?.('plan');
                setChatInput(t('automations.assistant.plan_comment_prompt', 'Comment on plan v{version}, {section} {n}: "{line}" — ', { version: state.reviewPlan?.version, section, n: index + 1, line }));
            }} />}
            {previewOpen && state.proposal && (
                <ProposalPreviewOverlay
                    proposal={state.proposal}
                    catalog={m.catalog as { datatables?: CatalogTable[] } | null}
                    running={state.running}
                    onReview={() => { setPreviewOpen(false); setAssistantOpen(true); }}
                    onClose={() => setPreviewOpen(false)}
                />
            )}
            {!!state.pendingExternalDraft && (
                <ExternalDraftBanner onAccept={p.acceptExternalDraft} onDismiss={p.dismissExternalDraft} />
            )}
            <div className="flex-1 min-h-0 flex relative" style={ndvStep ? { minHeight: 220 } : undefined}>
                <CanvasRow p={p} m={m} />
                {m.manager.layersOpen && <FlowletsDrawer p={p} m={m} />}
            </div>
            {/* The step editor — a bottom drawer under the canvas (design 1h).
                A flex sibling of the canvas row, so the canvas shrinks by
                itself; no portal, no backdrop. */}
            {ndvStep && <StepDrawer p={p} m={m} />}
            {p.formTest && (
                <Suspense fallback={null}>
                <FormRunOverlay
                    automationId={state.automationId || p.automation?.id}
                    form={p.formTest.form}
                    runId={p.formTest.runId}
                    onStartRun={p.onFormTestRun}
                    onClose={p.onCloseFormTest}
                />
                </Suspense>
            )}
        </div>
    );
}

/**
 * Canvas + its canvas-anchored overlays live in a relative wrapper so the
 * pinned dock (right sibling) shrinks the canvas instead of being overlapped
 * by the FAB/pill. The full-height right drawers (palette/flowlets) sit
 * OUTSIDE this wrapper, anchored to the row, so they hide off the true screen
 * edge.
 */
function CanvasRow({ p, m }: { p: BuildTabProps; m: BuildTabModel }) {
    const { state, mode = 'automation', readOnly = false } = p;
    const showChat = p.assistantOpen && mode !== 'step' && !readOnly;
    // The plan exists only once the agent has written one — so this is "while
    // it builds", and it stays readable for a moment after the turn ends.
    const hasPlan = Array.isArray(state.todos) && state.todos.length > 0;
    return (
        <div className="relative flex-1 min-w-0">
            {!showChat && mode !== 'step' && !readOnly && (
                <AssistantLauncher running={state.running} onOpen={() => p.setAssistantOpen(true)} />
            )}
            {/* The plan, ON the canvas (owner, 2026-09-16). Canvas furniture
                like the zoom stack and the south bar: it floats at the left
                edge and the camera keeps its strip free (cameraInsetLeft), so
                a card never lands behind it. */}
            {hasPlan && (
                <CanvasPlanPanel
                    todos={state.todos}
                    running={state.running}
                    t={m.t}
                    idPrefix="builder"
                    style={{ top: 56 }}
                />
            )}
            <DiagramPane
                // Remount per scope: fitView re-runs on the new graph and the
                // drag-mirror state can't leak across scopes.
                key={p.scopeKey || 'root'}
                ref={m.diagramRef}
                {...canvasPaneProps(p, m)}
                cameraInsetLeft={hasPlan ? PLAN_PANEL_INSET_PX : 0}
            />
            {m.run.liveRunInFlight && (
                <RunProgressBanner
                    run={state.dryRun}
                    steps={state.steps}
                    onStop={() => { if (state.dryRun?.id) p.onStopRun?.(state.dryRun.id); }}
                />
            )}
            {/* The validation chip and the Flowlets button live in the
                canvas's own overlay zones (DiagramPane: north-west and
                south-west). The new node lands at palette.position. */}
            {m.ctx.palette.open && !readOnly && (
                <ContextAddPopover scope={m.contextScope} onAdd={m.surfaces.handleAddNode} onClose={m.ctx.closePalette} />
            )}
        </div>
    );
}

/** Everything the canvas is handed, apart from its key, ref and camera inset. */
function canvasPaneProps(p: BuildTabProps, m: BuildTabModel): DiagramPaneProps {
    return { ...canvasEditProps(p, m), ...canvasRunProps(p, m), ...canvasFlowletProps(p, m) };
}

/** The run drawn on the canvas, and what the canvas can do about it. */
function canvasRunProps(p: BuildTabProps, m: BuildTabModel): DiagramPaneProps {
    const { state, onOpenFormOverlay } = p;
    const dryRunId = state.dryRun?.id;
    return {
        runSteps: m.run.replaySteps,
        replayStepId: m.run.replayStepId,
        formUrl: m.waitingFormUrl,
        onOpenFormOverlay: onOpenFormOverlay && dryRunId ? () => onOpenFormOverlay(dryRunId) : null,
        onExecuteStep: p.onExecuteStep,
        executingStepId: state.executingStepId,
        runInFlight: m.run.liveRunInFlight,
        runIdentity: runIdentityOf(state.dryRun, p.onOpenRun || null),
        onDiagnose: p.scopedDef?.trigger?.kind === 'app_event' ? p.onDiagnose : null,
        fatalError: p.fatalError,
        aborted: state.aborted,
        onDismissFatal: p.onDismissFatal,
    };
}

/** The flowlets: drawn open on the canvas, opened as a scope, or managed. */
function canvasFlowletProps(p: BuildTabProps, m: BuildTabModel): DiagramPaneProps {
    const { flowlets, manager } = m;
    return {
        onOpenLayer: (k) => p.setScopeKey?.(k),
        layerSummaries: m.layerSummaries,
        sidecar: flowlets.inlineSidecar,
        shiftById: flowlets.inlineShift,
        onToggleInline: flowlets.onToggleInline,
        onExpandAllFlowlets: flowlets.onExpandAllFlowlets,
        onCollapseAllFlowlets: flowlets.onCollapseAllFlowlets,
        layerRefCounts: flowlets.layerRefCounts,
        flowletsOpen: manager.layersOpen,
        onToggleFlowlets: () => manager.setLayersOpen(o => !o),
        flowletCount: Object.keys(p.rootDef?.layers || {}).length,
    };
}

/** The graph, and every way of editing it from the canvas. */
function canvasEditProps(p: BuildTabProps, m: BuildTabModel): DiagramPaneProps {
    const { state, mode = 'automation', readOnly = false, onAskAssistant } = p;
    const assistantReachable = mode !== 'step' && !readOnly;
    return {
        definition: m.flowlets.flatDef,
        onNodeClick: m.drawer.onNodeClickWrapped,
        onNodeExpand: m.drawer.onNodeExpand,
        validation: state.validation,
        editable: !readOnly,
        structuralEditsBlocked: state.running || readOnly,
        buildCue: m.buildCue,
        ribbonRootRef: m.ribbonRootRef,
        onDefinitionChange: m.flowlets.onVisualEditFlat,
        onStepAdded: m.smart.recordUsage,
        onRequestAddNode: m.ctx.onRequestAddNodeFromEdge,
        // The empty canvas's "Choose a trigger" button. With no trigger yet
        // the picker opens on the seven trigger kinds.
        onRequestOpenPalette: readOnly ? null : () => m.ctx.setPalette({ open: true, position: null, edgeSource: null }),
        // The empty canvas (design 1e): every trigger as a card, and the
        // assistant one click away.
        onAddTrigger: readOnly ? null : m.surfaces.handleAddNode,
        onOpenAssistant: assistantReachable ? () => (onAskAssistant ? onAskAssistant() : p.setAssistantOpen(true)) : null,
        onAskAssistant: assistantReachable ? onAskAssistant : null,
        // Marks the edited card, its source (dashed) and what comes next
        // (dimmed) while the drawer is open.
        editingStepId: m.drawer.ndvStep?.id || null,
        onRequestAddAfter: m.ctx.onRequestAddAfter,
        onRequestInsertOnEdge: m.ctx.onRequestInsertOnEdge,
        onDropStep: m.surfaces.handleDropStep,
        catalog: m.catalog,
        realOutputById: m.realOutputById,
        autoMapEnabled: m.autoMapEnabled,
        onAutoMapped: (_id, count, forEachEnabled) => {
            if (count || forEachEnabled) toast.success(autoMapToastMessage(count, forEachEnabled));
        },
        highlightedStepId: m.highlightedStepId,
        onFocusStep: m.onFocusStep,
    };
}

/** The Flowlets manager drawer, docked to the right of the canvas row. */
function FlowletsDrawer({ p, m }: { p: BuildTabProps; m: BuildTabModel }) {
    const { manager } = m;
    return (
        <FlowletsPanel
            onClose={() => manager.setLayersOpen(false)}
            rootDef={p.rootDef}
            currentScopeKey={p.scopeKey}
            onOpenLayer={(k) => p.setScopeKey?.(k)}
            onRenameLayer={manager.handleRenameLayer}
            onDeleteLayer={manager.handleDeleteLayer}
            refCountFor={manager.refCountFor}
            onCreateLayer={manager.handleCreateLayer}
            aiEnabled={manager.aiSummaryEnabled}
            onToggleAi={manager.toggleAiSummary}
            onSummarize={manager.handleSummarizeLayer}
            summarizingKey={manager.summarizingKey}
            rootDescription={(p.rootDef?.description as string) || ''}
            onSummarizeRoot={manager.handleSummarizeRoot}
            summarizingRoot={manager.summarizingRoot}
            onBuildLayer={p.onBuildLayer}
            onRefineLayer={p.onRefineLayer}
            layerAgentState={p.layerAgentState}
        />
    );
}

/** The step editor for the node open in the drawer. */
function StepDrawer({ p, m }: { p: BuildTabProps; m: BuildTabModel }) {
    const { state, onAskAssistant, ndvDensity = 'full' } = p;
    const { drawer, edits } = m;
    const ndvStep = drawer.ndvStep;
    if (!ndvStep) return null;
    const locked = drawer.editsLocked;
    return (
        <AssistantFieldProvider value={onAskAssistant ? field => onAskAssistant(ndvStep.id, field) : null}>
            <NodeDetailView
                key={ndvStep.id}
                density={ndvDensity}
                onDensityChange={p.setNdvDensity}
                mode={p.ndvMode}
                onModeChange={p.onNdvModeChange}
                step={ndvStep}
                runStep={drawer.ndvRunStep(ndvStep.id)}
                runSteps={state.steps}
                realOutputById={m.realOutputById}
                catalog={m.catalog}
                definition={m.flowlets.flatDef}
                rootDefinition={p.rootDef}
                automation={p.automation}
                blocksCatalog={(m.catalog as { steps?: unknown[] } | null)?.steps || []}
                onSaveStep={edits.onSaveStepFlat}
                onRenameBinding={edits.onRenameBinding}
                onInsertStepBefore={edits.onInsertStepBefore}
                onFollowRoute={locked ? null : edits.onFollowRoute}
                validation={state.validation}
                modelTiers={p.modelTiers}
                onExecuteStep={p.onExecuteStep}
                onRetryFromStep={p.onRetryFromStep}
                runInFlight={m.run.liveRunInFlight}
                executingStep={state.executingStepId === ndvStep.id}
                onDeleteStep={edits.onDeleteStep}
                onDuplicateStep={edits.onDuplicateStep}
                // Page to another node without a round trip through the canvas
                // (BFSF-332). The `key` above remounts the panel, which is what
                // flushes any in-flight autosave.
                onNavigate={(id) => p.openNdv(id, ndvDensity)}
                onExpandOnCanvas={m.flowlets.expandOnCanvas}
                onAddAfterStep={locked ? null : m.surfaces.onAddAfterStep}
                onClose={p.closeNdv}
            />
        </AssistantFieldProvider>
    );
}
