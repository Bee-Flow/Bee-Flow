/**
 * Everything inside the world view, in paint order: the lines, the nodes
 * (an open loop's box before its body), the buttons over them, and a drag in
 * flight — only what lies in the patch of world the camera says is worth
 * mounting (the screen plus half a screen around it), so a 150-step routine
 * mounts the thirty-odd nodes near the screen, not all of them. The node
 * being dragged always stays mounted: its gesture lives on it.
 */

import React, { useMemo } from 'react';

import { useThemedStyles } from '@/core/theme/ThemeProvider';
import type { FlowDefinition } from '@/features/flow-editor/model';

import { AddSpotButton } from './AddSpotButton';
import { CanvasNode, type NodeState } from './CanvasNode';
import { makeCanvasStyles } from './canvasStyles';
import { DragOverlay } from './DragOverlay';
import { EdgeControls } from './EdgeControls';
import { EdgeLayer } from './EdgeLayer';
import { LoopToggle } from './LoopToggle';
import { type CanvasMode } from './overlay';
import { PortTarget } from './PortTarget';
import type { Scene, SceneNode } from './scene';
import type { PendingLine } from './useCanvasEditing';
import { intersects, type Lod, type Rect } from './viewport';
import { cardModel, type CardContext, type CardModel } from '../outline/cardModel';

export interface SceneLayersProps {
    scene: Scene;
    definition: FlowDefinition;
    card: CardContext;
    frame: Rect;
    /** The patch of world to mount; null mounts nothing (no layout yet). */
    rect: Rect | null;
    lod: Lod;
    res: number;
    mode: CanvasMode;
    locked: boolean;
    pending: PendingLine | null;
    dragging: string | null;
    stateOf: (key: string) => NodeState;
}

function cardsFor(scene: Scene, definition: FlowDefinition, ctx: CardContext): Map<string, CardModel | null> {
    const out = new Map<string, CardModel | null>();
    for (const n of scene.nodes) out.set(n.key, n.kind === 'entry' || n.kind === 'note' ? null : cardModel(definition, n.key, ctx));
    return out;
}

const isLoop = (n: SceneNode) => n.node.type === 'loop' && (n.kind === 'container' || n.kind === 'step');

/** Connect mode's targets: every port of every top-level node. */
function PortTargets({ nodes, cards, frame, pending }: { nodes: SceneNode[]; cards: Map<string, CardModel | null>; frame: Rect; pending: PendingLine | null }) {
    const styles = useThemedStyles(makeCanvasStyles);
    return (
        <>
            {nodes.filter((n) => n.parent === null).flatMap((n) => n.ports.map((p) => (
                <PortTarget
                    key={`${n.key}|${p.id}`}
                    node={n}
                    name={cards.get(n.key)?.name ?? n.nodeId}
                    port={p}
                    frame={frame}
                    picked={pending?.key === n.key && pending.port.id === p.id}
                    styles={styles}
                />
            )))}
        </>
    );
}

export function SceneLayers(props: SceneLayersProps) {
    const { scene, definition, card, frame, rect, lod, res, mode, locked, pending, dragging, stateOf } = props;
    const cards = useMemo(() => cardsFor(scene, definition, card), [scene, definition, card]);
    const inView = (r: Rect) => rect !== null && intersects(r, rect);
    const nodes = scene.nodes.filter((n) => inView(n) || n.key === dragging);
    const edges = scene.edges.filter((e) => inView(e.geometry.bbox));
    const touching = dragging ? scene.edges.filter((e) => e.from === dragging || e.to === dragging) : [];
    const hidden = new Set(touching.map((e) => e.id));
    const editable = !locked && lod === 'card';
    const draggedNode = dragging ? (scene.byKey.get(dragging) ?? null) : null;
    return (
        <>
            <EdgeLayer edges={edges} frame={frame} res={res} runByStep={card.runByStep} hidden={hidden} />
            {nodes.map((n) => (
                <CanvasNode key={n.key} node={n} card={cards.get(n.key) ?? null} frame={frame} lod={lod} state={stateOf(n.key)} />
            ))}
            {lod === 'card'
                ? edges.map((e) => <EdgeControls key={e.id} edge={e} frame={frame} mode={mode} editable={!locked} />)
                : null}
            {editable && mode === 'edit'
                ? scene.adds.filter((a) => inView({ x: a.x - 20, y: a.y - 20, width: 40, height: 40 })).map((a) => <AddSpotButton key={a.key} spot={a} frame={frame} />)
                : null}
            {lod === 'card' ? nodes.filter(isLoop).map((n) => <LoopToggle key={`loop:${n.key}`} node={n} frame={frame} />) : null}
            {mode === 'connect' && !locked ? <PortTargets nodes={nodes} cards={cards} frame={frame} pending={pending} /> : null}
            <DragOverlay node={draggedNode} card={dragging ? (cards.get(dragging) ?? null) : null} edges={touching} frame={frame} lod={lod} />
        </>
    );
}
