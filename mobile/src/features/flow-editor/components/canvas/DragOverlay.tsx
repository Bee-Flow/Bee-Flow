/**
 * A node being dragged: its ghost follows the finger on the UI thread, and
 * each of its lines becomes a straight rubber band from its other end — a
 * thin view turned to the right angle, because an Svg redrawn every frame
 * would allocate a new bitmap every frame. On release the edit lands, the
 * scene redraws the real curves, and this goes away.
 */

import React from 'react';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { useThemedStyles } from '@/core/theme/ThemeProvider';

import { useCanvasRuntime } from './CanvasRuntime';
import { boxAt, makeCanvasStyles } from './canvasStyles';
import { segmentFrame } from './edgePath';
import { NodeFace } from './NodeFaces';
import type { SceneNode } from './scene';
import type { SceneEdge } from './sceneEdges';
import type { Lod, Rect } from './viewport';
import type { CardModel } from '../outline/cardModel';

function RubberBand({ edge, dragged, frame }: { edge: SceneEdge; dragged: string; frame: Rect }) {
    const styles = useThemedStyles(makeCanvasStyles);
    const { drag } = useCanvasRuntime();
    const { sx, sy, tx, ty } = edge.ends;
    const fromMoves = edge.from === dragged;
    const toMoves = edge.to === dragged;
    const fx = frame.x;
    const fy = frame.y;
    const band = useAnimatedStyle(() => {
        const d = drag.value;
        const f = segmentFrame(sx - fx + (fromMoves ? d.dx : 0), sy - fy + (fromMoves ? d.dy : 0), tx - fx + (toMoves ? d.dx : 0), ty - fy + (toMoves ? d.dy : 0));
        return { left: f.left, top: f.top - 1, width: f.width, transform: [{ rotate: `${f.angle}rad` }] };
    });
    return <Animated.View pointerEvents="none" style={[styles.rubber, band]} />;
}

function Ghost({ node, card, frame, lod }: { node: SceneNode; card: CardModel | null; frame: Rect; lod: Lod }) {
    const styles = useThemedStyles(makeCanvasStyles);
    const { drag } = useCanvasRuntime();
    const follow = useAnimatedStyle(() => ({ transform: [{ translateX: drag.value.dx }, { translateY: drag.value.dy }] }));
    return (
        <Animated.View pointerEvents="none" style={[styles.abs, boxAt(frame, node), styles.lifted, follow]}>
            <NodeFace node={node} card={card} lod={lod} />
        </Animated.View>
    );
}

export interface DragOverlayProps {
    node: SceneNode | null;
    card: CardModel | null;
    /** The lines that touch it. */
    edges: readonly SceneEdge[];
    frame: Rect;
    lod: Lod;
}

export function DragOverlay({ node, card, edges, frame, lod }: DragOverlayProps) {
    if (!node) return null;
    return (
        <>
            {edges.map((e) => (
                <RubberBand key={e.id} edge={e} dragged={node.key} frame={frame} />
            ))}
            <Ghost node={node} card={card} frame={frame} lod={lod} />
        </>
    );
}
