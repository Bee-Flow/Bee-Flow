/**
 * The build screen's Canvas tab: the automation as the web's DiagramPane draws
 * it, for a finger. Pan with one finger (a flick glides on), pinch to zoom
 * (25%–200%, around the fingers), double-tap to zoom in; one small bar in the
 * top right holds the zoom (tap it to fit), Add, Connect and ⋯.
 *
 *   nodes     where they were put (or laid out in rows when some were not),
 *             cards from 60% up and family tiles below; a loop opens in
 *             place to show its body, chained as the engine runs it
 *   lines     curves between ports, a chip where the port does not name the
 *             branch, a "+" on each that inserts a step into exactly that
 *             line (the same picker and insert as the Steps outline)
 *   edits     tap opens a step, hold opens its menu, hold and drag moves it;
 *             connect mode draws a line by tapping its two ends and removes
 *             one with its "×"; Arrange re-lays everything out — each one
 *             undoable edit on the automation's draft
 *
 * Everything the canvas computes is pure (scene.ts, viewport.ts, connect.ts,
 * moves.ts); this file wires the draft, the camera and the layers together.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue } from 'react-native-reanimated';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import type { Catalog } from '@/features/flow-editor/bindings';
import { useDraftState } from '@/features/flow-editor/hooks';
import type { FlowDefinition } from '@/features/flow-editor/model';
import type { AddTarget } from '@/features/flow-editor/model/outline';
import type { DraftStore } from '@/features/flow-editor/state';
import { EmptyState } from '@/shared/ui';

import { CanvasControls, CONTROLS_INSET } from './CanvasControls';
import { CanvasRuntimeProvider, useStableActions, type DragState } from './CanvasRuntime';
import { boxAt, makeCanvasStyles } from './canvasStyles';
import { ConnectBanner } from './ConnectBanner';
import { buildScene } from './scene';
import { SceneLayers } from './SceneLayers';
import { useCanvasCamera } from './useCanvasCamera';
import { useCanvasEditing } from './useCanvasEditing';
import { worldFrame } from './viewport';
import type { CardContext } from '../outline/cardModel';

export interface CanvasViewProps {
    /** The open automation's draft (FlowDraft.store). */
    store: DraftStore;
    /** Open a step's editor, by its address. */
    onOpenStep: (address: string) => void;
    /** The cards' words: step numbers, names the catalog knows, the last test run, the findings. */
    card?: CardContext;
    /** A step's menu (the outline card's), by its address. */
    onMenu?: (address: string) => void;
    /** Ask for a step to put at `target` (the step picker). */
    onAdd?: (target: AddTarget) => void;
    /** For auto-mapping a step's inputs when a line is drawn into it. */
    catalog?: Catalog | null;
}

export function CanvasView({ store, onOpenStep, card, onMenu, onAdd, catalog = null }: CanvasViewProps) {
    const t = useTranslation();
    const definition = useDraftState(store, (s) => s.definition);
    if (!definition) return null;
    if (!definition.trigger && definition.steps.length === 0) {
        return (
            <EmptyState
                icon="Workflow"
                title={t('automations.canvas.empty_title', 'What does this automation start with?')}
                message={t('automations.canvas.empty_static', 'Start with a trigger.')}
                actionLabel={t('mobile.flow.add_trigger', 'Add a trigger')}
                onAction={() => onAdd?.({ kind: 'root' })}
            />
        );
    }
    return (
        <Canvas store={store} definition={definition} onOpenStep={onOpenStep} card={card ?? { t }} onMenu={onMenu} onAdd={onAdd} catalog={catalog} />
    );
}

type CanvasProps = CanvasViewProps & { definition: FlowDefinition; card: CardContext };

/**
 * When exactly one node appears (a step added, a delete undone), glide to it
 * if it landed off screen — an added step that nobody can see looks like a
 * tap that did nothing. Several at once (a loop opened, a build) move nothing.
 */
function useFollowNewNode(nodes: ReturnType<typeof buildScene>['nodes'], focus: (rect: { x: number; y: number; width: number; height: number }) => void) {
    const known = useRef<ReadonlySet<string> | null>(null);
    useEffect(() => {
        const before = known.current;
        known.current = new Set(nodes.map((n) => n.key));
        if (!before) return;
        const added = nodes.filter((n) => !before.has(n.key) && n.kind !== 'entry');
        if (added.length === 1 && added[0]) focus(added[0]);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- react to the nodes, not to a new focus function
    }, [nodes]);
}

/** What floats over the canvas and a fit keeps the flow clear of: the controls, and the findings pill below. */
const INSETS = { top: CONTROLS_INSET, bottom: 64 };

function Canvas({ store, definition, onOpenStep, card, onMenu, onAdd, catalog = null }: CanvasProps) {
    const styles = useThemedStyles(makeCanvasStyles);
    const locked = useDraftState(store, (s) => s.locked);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const scene = useMemo(() => buildScene(definition, expanded), [definition, expanded]);
    // The same frame object while its numbers stay the same: a new one re-places every node.
    const { x, y, width, height } = worldFrame(scene.bounds);
    const frame = useMemo(() => ({ x, y, width, height }), [x, y, width, height]);
    const camera = useCanvasCamera(scene.bounds, frame, INSETS);
    useFollowNewNode(scene.nodes, camera.focus);
    const editing = useCanvasEditing({ store, definition, scene, catalog, locked, onOpenStep, onMenu, onAdd, setExpanded });
    const drag = useSharedValue<DragState>({ key: '', dx: 0, dy: 0 });
    const actions = useStableActions(editing.actions);
    const canDrag = !locked && editing.mode === 'edit';
    const runtime = useMemo(() => ({ actions, drag, scale: camera.scale, canDrag }), [actions, drag, camera.scale, canDrag]);
    return (
        <CanvasRuntimeProvider value={runtime}>
            <View style={styles.frame}>
                <GestureDetector gesture={camera.gesture}>
                    <View style={styles.fill} onLayout={camera.onLayout} collapsable={false} testID="canvas">
                        <Animated.View style={[styles.world, boxAt(frame, frame), camera.worldStyle]}>
                            <SceneLayers
                                scene={scene}
                                definition={definition}
                                card={card}
                                frame={frame}
                                rect={camera.view.rect ?? camera.initialRect}
                                lod={camera.view.lod}
                                res={camera.view.res}
                                mode={editing.mode}
                                locked={locked}
                                pending={editing.pending}
                                dragging={editing.dragging}
                                stateOf={editing.stateOf}
                            />
                        </Animated.View>
                    </View>
                </GestureDetector>
                {/* Siblings of the gesture area, not children: a quick second tap on a
                    button must press it, not count as the canvas's double-tap. */}
                <CanvasControls
                    scale={camera.scale}
                    mode={editing.mode}
                    locked={locked}
                    onZoom={camera.zoomBy}
                    onZoomTo={camera.zoomTo}
                    onFit={camera.fit}
                    onFitReadable={camera.fitReadable}
                    onAdd={() => onAdd?.({ kind: 'root' })}
                    onMode={editing.setMode}
                    onArrange={(mode) => {
                        if (editing.arrange(mode, camera.size)) camera.fitNext();
                    }}
                />
                {editing.mode === 'connect' ? <ConnectBanner picking={!!editing.pending} onDone={() => editing.setMode('edit')} /> : null}
            </View>
        </CanvasRuntimeProvider>
    );
}
