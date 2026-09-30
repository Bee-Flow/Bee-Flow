/**
 * The lines. Each is its own small <Svg>, the size of the box the line
 * occupies: Android draws an Svg into a bitmap as big as its box, so one Svg
 * for the whole canvas would be hundreds of megabytes on a long routine,
 * while a line between neighbours is a few hundred kilobytes. Each is
 * memoised on its path and ink, so an edit elsewhere never redraws it, and
 * drawn at the zoom's resolution within a per-line pixel budget
 * (edgePath.edgeResolution) — a returning line that spans the canvas is
 * drawn coarser rather than allocating a screen-sized bitmap.
 *
 * Lines never take touches; their chips and "+" are the overlay's.
 */

import React, { memo } from 'react';
import { PixelRatio, View } from 'react-native';
import { Path, Svg } from 'react-native-svg';

import { useThemedStyles } from '@/core/theme/ThemeProvider';

import { boxAt, makeCanvasStyles, scaledBox } from './canvasStyles';
import { edgeInk, identityColor, type RunRowLike } from './edgeColors';
import { edgeResolution, type EdgeGeometry } from './edgePath';
import type { SceneEdge } from './sceneEdges';
import type { Rect } from './viewport';

interface LineProps {
    geometry: EdgeGeometry;
    frame: Rect;
    color: string;
    width: number;
    dashed: boolean;
    res: number;
}

function EdgeLineView({ geometry, frame, color, width, dashed, res }: LineProps) {
    const styles = useThemedStyles(makeCanvasStyles);
    const { bbox } = geometry;
    const r = edgeResolution(bbox, res, PixelRatio.get());
    return (
        <View pointerEvents="none" style={[styles.abs, boxAt(frame, bbox)]}>
            <View style={[styles.abs, scaledBox(bbox, r)]}>
                <Svg width={bbox.width * r} height={bbox.height * r} viewBox={`${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`}>
                    <Path d={geometry.d} stroke={color} strokeWidth={width} fill="none" strokeDasharray={dashed ? '6 5' : undefined} />
                    <Path d={geometry.arrow} fill={color} />
                </Svg>
            </View>
        </View>
    );
}

const EdgeLine = memo(
    EdgeLineView,
    (a, b) => a.geometry.d === b.geometry.d && a.color === b.color && a.width === b.width && a.dashed === b.dashed && a.res === b.res
        && a.frame.x === b.frame.x && a.frame.y === b.frame.y,
);

export interface EdgeLayerProps {
    edges: readonly SceneEdge[];
    frame: Rect;
    /** The zoom's line resolution. */
    res: number;
    /** The last test run, by step id: a failed step's line is red, a travelled one green. */
    runByStep?: ReadonlyMap<string, RunRowLike> | null;
    /** Lines the drag draws as rubber bands instead. */
    hidden?: ReadonlySet<string> | null;
}

export function EdgeLayer({ edges, frame, res, runByStep = null, hidden = null }: EdgeLayerProps) {
    const styles = useThemedStyles(makeCanvasStyles);
    return (
        <>
            {edges.map((e) => {
                if (hidden?.has(e.id)) return null;
                const ink = edgeInk(identityColor({ color: e.defColor, caseIndex: e.caseIndex }), runByStep?.get(e.from), runByStep?.get(e.to));
                return (
                    <EdgeLine
                        key={e.id}
                        geometry={e.geometry}
                        frame={frame}
                        color={ink.color ?? styles.line.color}
                        width={ink.width}
                        dashed={e.geometry.backward}
                        res={res}
                    />
                );
            })}
        </>
    );
}
