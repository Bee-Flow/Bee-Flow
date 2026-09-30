/**
 * One flowchart node in its Mermaid shape — box, rounded box, stadium,
 * subroutine, cylinder, circle, double circle, flag, diamond, hexagon,
 * parallelogram, trapezoid — filled and outlined in the web's Mermaid theme,
 * with its label centred line by line.
 */

import React from 'react';
import { Circle, G, Path, Polygon, Rect } from 'react-native-svg';

import { CentredLines } from './CentredLines';
import type { LaidNode } from './flowchartLayout';
import { MERMAID_THEME } from './mermaidTheme';

const FILL = MERMAID_THEME.mainBkg;
const STROKE = MERMAID_THEME.nodeBorder;

function pts(list: [number, number][]): string {
    return list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

interface Box {
    l: number;
    t: number;
    w: number;
    h: number;
}

/** A polygon's corners for the angular shapes, around a box at (l, t) of w × h. */
function corners(shape: LaidNode['shape'], { l, t, w, h }: Box): [number, number][] | null {
    const r = l + w;
    const b = t + h;
    const s = h / 2;
    switch (shape) {
        case 'rhombus':
            return [[l + w / 2, t], [r, t + h / 2], [l + w / 2, b], [l, t + h / 2]];
        case 'hexagon':
            return [[l + s / 2, t], [r - s / 2, t], [r, t + s], [r - s / 2, b], [l + s / 2, b], [l, t + s]];
        case 'asymmetric':
            return [[l, t], [r, t], [r, b], [l, b], [l + s / 2, t + s]];
        case 'parallelogram':
            return [[l + s / 2, t], [r, t], [r - s / 2, b], [l, b]];
        case 'parallelogram-alt':
            return [[l, t], [r - s / 2, t], [r, b], [l + s / 2, b]];
        case 'trapezoid':
            return [[l + s / 2, t], [r - s / 2, t], [r, b], [l, b]];
        case 'trapezoid-alt':
            return [[l, t], [r, t], [r - s / 2, b], [l + s / 2, b]];
        default:
            return null;
    }
}

/** The node's outline, drawn for its shape. */
function outline(node: LaidNode) {
    const { x, y, width: w, height: h, shape } = node;
    const l = x - w / 2;
    const t = y - h / 2;
    const polygon = corners(shape, { l, t, w, h });
    if (polygon) return <Polygon points={pts(polygon)} fill={FILL} stroke={STROKE} strokeWidth={1} />;
    if (shape === 'circle' || shape === 'doublecircle') {
        return (
            <G>
                <Circle cx={x} cy={y} r={w / 2} fill={FILL} stroke={STROKE} strokeWidth={1} />
                {shape === 'doublecircle' ? <Circle cx={x} cy={y} r={w / 2 - 5} fill="none" stroke={STROKE} strokeWidth={1} /> : null}
            </G>
        );
    }
    if (shape === 'cylinder') {
        const ry = 8;
        const body = `M${l},${t + ry} a${w / 2},${ry} 0 0 0 ${w},0 a${w / 2},${ry} 0 0 0 ${-w},0 l0,${h - 2 * ry} a${w / 2},${ry} 0 0 0 ${w},0 l0,${-(h - 2 * ry)}`;
        return <Path d={body} fill={FILL} stroke={STROKE} strokeWidth={1} />;
    }
    const rx = shape === 'round' ? 5 : shape === 'stadium' ? h / 2 : 0;
    return (
        <G>
            <Rect x={l} y={t} width={w} height={h} rx={rx} fill={FILL} stroke={STROKE} strokeWidth={1} />
            {shape === 'subroutine' ? (
                <Path d={`M${l + 8},${t} v${h} M${l + w - 8},${t} v${h}`} stroke={STROKE} strokeWidth={1} />
            ) : null}
        </G>
    );
}

export function FlowNodeShape({ node }: { node: LaidNode }) {
    return (
        <G>
            {outline(node)}
            <CentredLines x={node.x} y={node.y + (node.shape === 'cylinder' ? 4 : 0)} lines={node.lines} color={MERMAID_THEME.nodeTextColor} />
        </G>
    );
}
