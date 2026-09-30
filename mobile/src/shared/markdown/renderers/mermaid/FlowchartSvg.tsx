/**
 * A laid-out flowchart as one react-native-svg drawing, bottom up: subgraph
 * panels with their titles, then the links (curved, dotted or thick, with
 * their ends and labels on the Mermaid label background), then the nodes.
 * The drawing keeps its own coordinates in a viewBox, so the same picture
 * fits a message's width or fills the full-screen viewer.
 */

import React from 'react';
import Svg, { Circle, G, Line, Path, Polygon, Rect } from 'react-native-svg';

import { CentredLines } from './CentredLines';
import { basisPath, endMark, trimForEnd } from './edgePath';
import { GROUP_TITLE_ROOM, textBox, type FlowLayout, type LaidEdge } from './flowchartLayout';
import { FlowNodeShape } from './FlowNodeShape';
import { MERMAID_THEME } from './mermaidTheme';

const LINE = MERMAID_THEME.lineColor;

function edgeLine(edge: LaidEdge) {
    if (edge.line === 'invisible' || edge.points.length < 2) return null;
    const n = edge.points.length;
    let points = trimForEnd(edge.points, edge.end);
    points = [...trimForEnd([...points].reverse(), edge.start)].reverse();
    const marks = [
        endMark(edge.end, edge.points[n - 2]!, edge.points[n - 1]!),
        endMark(edge.start, edge.points[1]!, edge.points[0]!),
    ];
    return (
        <G>
            <Path
                d={basisPath(points)}
                stroke={LINE}
                strokeWidth={edge.line === 'thick' ? 3.5 : 1.5}
                strokeDasharray={edge.line === 'dotted' ? '3,3' : undefined}
                fill="none"
            />
            {marks.map((mark, i) => {
                if (!mark) return null;
                if (mark.kind === 'arrow') return <Polygon key={i} points={mark.points} fill={LINE} />;
                if (mark.kind === 'circle') return <Circle key={i} cx={mark.cx} cy={mark.cy} r={mark.r} fill={LINE} />;
                return mark.lines.map(([a, b], j) => <Line key={`${i}.${j}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={LINE} strokeWidth={2} />);
            })}
        </G>
    );
}

function edgeLabel(edge: LaidEdge) {
    if (!edge.labelAt || !edge.labelLines.length) return null;
    const box = textBox(edge.labelLines);
    const w = box.w + 8;
    const h = box.h + 2;
    const { x, y } = edge.labelAt;
    return (
        <G>
            <Rect x={x - w / 2} y={y - h / 2} width={w} height={h} fill={MERMAID_THEME.edgeLabelBackground} rx={2} />
            <CentredLines x={x} y={y} lines={edge.labelLines} color={MERMAID_THEME.nodeTextColor} />
        </G>
    );
}

export function FlowchartSvg({ layout, width, height, label }: { layout: FlowLayout; width: number; height: number; label: string }) {
    return (
        <Svg
            width={width}
            height={height}
            viewBox={`0 0 ${Math.max(1, layout.width)} ${Math.max(1, layout.height)}`}
            accessible
            accessibilityRole="image"
            accessibilityLabel={label}
        >
            {layout.groups.map((g) => (
                <G key={g.id}>
                    <Rect
                        x={g.x - g.width / 2}
                        y={g.y - g.height / 2}
                        width={g.width}
                        height={g.height}
                        fill={MERMAID_THEME.clusterBkg}
                        stroke={MERMAID_THEME.clusterBorder}
                        strokeWidth={1}
                    />
                    <CentredLines x={g.x} y={g.y - g.height / 2 + GROUP_TITLE_ROOM / 2} lines={[g.title]} color={MERMAID_THEME.titleColor} />
                </G>
            ))}
            {layout.edges.map((edge, i) => (
                <G key={`e${i}`}>{edgeLine(edge)}</G>
            ))}
            {layout.edges.map((edge, i) => (
                <G key={`l${i}`}>{edgeLabel(edge)}</G>
            ))}
            {layout.nodes.map((node) => (
                <FlowNodeShape key={node.id} node={node} />
            ))}
        </Svg>
    );
}
