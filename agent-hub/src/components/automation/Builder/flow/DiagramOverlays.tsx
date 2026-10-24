import { MiniMap, Panel } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import { Layers } from 'lucide-react';
import React from 'react';

import useTranslation from '../../../../hooks/useTranslation';
import FloatingValidationPill from '../FloatingValidationPill';
import ArrangeMenu from './ArrangeMenu';
import CanvasLegend, { LegendToggle } from './CanvasLegend';
import CanvasSouthBar from './CanvasSouthBar';
import CanvasZoomStack from './CanvasZoomStack';
import FlowSummaryChip from './FlowSummaryChip';
import LineColorPanel from './LineColorPanel';
import { miniMapColor } from './nodeTypeColors';
import type { EdgeColorMode } from './useEdgeColorMode';
import type { DiagramDefinition, StepId } from './diagramPaneTypes';
import type { RunIdentity } from './useFailedRunBanner';

// The overlay pieces are untyped .jsx components; their props pass through
// exactly as DiagramPane handed them before the split.
export interface DiagramOverlaysProps {
    definition: DiagramDefinition;
    // south-west
    allowEdgeEdits: boolean | undefined;
    handleArrange: (mode: string) => void;
    structuralEditsBlocked: boolean;
    reducedMotion: boolean;
    resumeFollow: () => void;
    fitCanvasFully: () => void;
    presenter: boolean;
    togglePresenter: () => void;
    shortCanvas: boolean;
    onToggleFlowlets: (() => void) | null;
    flowletsOpen: boolean;
    flowletCount: number;
    // south
    runFocus: any;
    onDismissRunBanner: () => void;
    runIdentity: RunIdentity | null;
    focusRunStep: () => void;
    formUrl: string | null;
    onOpenFormOverlay: (() => void) | null;
    selectedCount: number;
    selectionInDrawer: boolean;
    deleteSelection: () => void;
    clearSelection: () => void;
    interactive: boolean;
    editable: boolean;
    buildCue: any;
    following: boolean | undefined;
    // north-west
    editingStepId: StepId | null;
    stepNumberById: Map<StepId, number | string>;
    fatalError: any;
    validation: any;
    aborted: any;
    onDismissFatal: any;
    onFocusStep: any;
    // north-east + minimap
    edgeColorMode: EdgeColorMode;
    setEdgeColorMode: (mode: EdgeColorMode) => void;
    onDefinitionChange: any;
    hasPiiData: boolean;
    legendOpen: boolean;
    toggleLegend: () => void;
    typeGroupById: Map<StepId, string | null>;
}

/**
 * The canvas's overlay zones (design 1a), drawn inside <ReactFlow>: the
 * south-west zoom stack + Flowlets + Arrange, the south bar, the north-west
 * summary/validation chips, the north-east lines lens + legend, and the
 * south-east minimap. A short canvas keeps only the furniture that serves the
 * step being edited (see `shortCanvas` in DiagramPane).
 */
export default function DiagramOverlays(p: DiagramOverlaysProps) {
    const { t } = useTranslation();
    const { definition, allowEdgeEdits, handleArrange, shortCanvas, editingStepId } = p;
    const AnyZoomStack = CanvasZoomStack;
    const AnySouthBar = CanvasSouthBar;
    const AnyPill = FloatingValidationPill;
    const AnyLinePanel = LineColorPanel;
    return (
        <>
            {/* South-west zone (design 1a): the zoom stack — with "Wrap to fit"
                in it, the same kind of one-press act as fitView — then the
                Flowlets drawer and the Arrange menu. All one Panel, so they
                can never drift apart or overlap the minimap. The fit counts
                each piece on its own (`data-furniture-parts`): the tall
                stack and the short buttons are not one tall block. */}
            <Panel position="bottom-left">
                <div className="flex items-end gap-2" data-furniture-parts>
                    {/* Fit hands the camera back to the film only while there is
                        one to follow; otherwise — and under reduced motion — it
                        is the canvas's own fit, clear of the furniture. */}
                    <AnyZoomStack
                        onWrapToFit={allowEdgeEdits ? () => handleArrange('serpentine') : null}
                        onFit={p.structuralEditsBlocked && !p.reducedMotion ? p.resumeFollow : p.fitCanvasFully}
                        presenter={p.presenter}
                        onTogglePresenter={p.togglePresenter}
                        compact={shortCanvas}
                    />
                    {p.onToggleFlowlets && !shortCanvas && (
                        <button
                            type="button"
                            data-layers-toggle
                            onClick={p.onToggleFlowlets}
                            aria-pressed={!!p.flowletsOpen}
                            title={t('automations.diagram_pane.flowlets_manage_reusable_sub_flows', 'Flowlets — manage reusable sub-flows')}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-[6px] rounded-lg border border-[var(--border-default)] shadow-sm text-[12px] font-medium text-[var(--text-primary)] transition ${
                                p.flowletsOpen ? 'bg-[var(--bg-tertiary)]' : 'bg-[var(--bg-card)] hover:bg-[var(--bg-tertiary)]'
                            }`}
                        >
                            <Layers size={14} /> {t('automations.canvas.flowlets', 'Flowlets')}
                            {p.flowletCount > 0 && <span className="text-[var(--text-tertiary)]">{p.flowletCount}</span>}
                        </button>
                    )}
                    {allowEdgeEdits && !shortCanvas && <ArrangeMenu onArrange={handleArrange} />}
                </div>
            </Panel>
            {/* South edge: run banner OR build banner OR selection bar OR
                gesture hint — one at a time, by precedence, so nothing
                stacks. The build banner is also the lock notice while the
                AI holds structural edits. Capped so it never runs under
                the zoom stack or the minimap. */}
            <Panel position="bottom-center" style={{ maxWidth: 'calc(100% - 440px)' }}>
                <AnySouthBar
                    runFocus={p.runFocus}
                    onDismissRun={p.onDismissRunBanner}
                    runIdentity={p.runIdentity}
                    onShowRun={p.focusRunStep}
                    formUrl={p.formUrl}
                    onOpenFormOverlay={p.onOpenFormOverlay}
                    selectedCount={p.selectedCount}
                    selectionInDrawer={p.selectionInDrawer}
                    onDeleteSelection={p.deleteSelection}
                    onClearSelection={p.clearSelection}
                    structuralEditsBlocked={p.structuralEditsBlocked}
                    interactive={p.interactive}
                    editable={p.editable}
                    buildCue={p.buildCue}
                    /* Under reduced motion the camera is never taken from
                       the build, so there is never anything to hand back. */
                    following={p.reducedMotion || p.following}
                    onFollow={p.resumeFollow}
                />
            </Panel>
            {/* North-west zone: what the canvas holds, and what is wrong with
                it. The validation chip used to float bottom-right, on top of
                the minimap. */}
            <Panel position="top-left">
                <div className="flex items-center gap-1.5">
                    {editingStepId ? (!shortCanvas && (
                        <div className="px-2.5 py-[5px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] text-[12px] text-[var(--text-secondary)] shadow-sm whitespace-nowrap" data-testid="editing-chip">
                            {t('automations.canvas.editing_chip', 'Step {n} of {total} · Esc closes · Alt+←/→ previous/next', {
                                n: p.stepNumberById.get(editingStepId) ?? '?',
                                total: [...p.stepNumberById.values()].filter(v => typeof v === 'number').length,
                            })}
                        </div>
                    )) : (
                        <FlowSummaryChip definition={definition} />
                    )}
                    <AnyPill
                        fatalError={p.fatalError}
                        validation={p.validation}
                        aborted={p.aborted}
                        onDismissFatal={p.onDismissFatal}
                        def={definition}
                        onFocusStep={p.onFocusStep}
                    />
                </div>
            </Panel>
            {/* "Colour lines by" + the rules panel behind it — mode is a
                per-user lens; the colour RULES (pin a case colour, remap a
                PII group) edit the definition. Shown wherever connections
                are; rule editing only on an editable canvas. */}
            {/* North-east zone: the "Lines" lens (where there are lines) and
                the legend behind the help button. */}
            {!shortCanvas && (
                <Panel position="top-right">
                    <div className="flex flex-col items-end gap-1.5">
                        <div className="flex items-start gap-1.5">
                            {(definition.edges || []).length > 0 && (
                                <AnyLinePanel
                                    mode={p.edgeColorMode}
                                    onModeChange={p.setEdgeColorMode}
                                    definition={definition}
                                    editable={allowEdgeEdits}
                                    onDefinitionChange={p.onDefinitionChange}
                                    hasPiiData={p.hasPiiData}
                                />
                            )}
                            <LegendToggle open={p.legendOpen} onToggle={p.toggleLegend} />
                        </div>
                        {p.legendOpen && <CanvasLegend />}
                    </div>
                </Panel>
            )}
            {!shortCanvas && <MiniMap
                pannable
                zoomable
                // South-east zone: 160×96 (design 1a).
                style={{ width: 160, height: 96, borderRadius: 10 }}
                // The same family/status vocabulary the cards paint with
                // (flow/nodeTypeColors.js), so the map agrees with the canvas.
                nodeColor={(n: Node) => ((n.type === 'row_label' || n.type === 'ai_tool' || n.type === 'ghost_step')
                    ? 'transparent'
                    : miniMapColor(p.typeGroupById.get(n.id) || null, (n.data as any)?.runStep?.status || null))}
                maskColor="rgba(0,0,0,0.04)"
            />}
        </>
    );
}
