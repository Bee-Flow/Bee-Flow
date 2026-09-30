/**
 * A parsed flowchart, laid out by dagre — the layout engine Mermaid itself
 * uses for flowcharts, already in this app for the flow editor — with
 * Mermaid's spacing (50px between nodes and between ranks). Node and label
 * sizes are estimated from their text, as nothing is measured before it is
 * drawn: 14px text, wrapped near 24 characters, padded as Mermaid pads.
 */

import { graphlib, layout } from '@dagrejs/dagre';

import type { NodeShape } from './flowchartNodes';
import type { FlowEdge, FlowNode, Flowchart } from './flowchartParser';
import { MERMAID_FONT_SIZE, MERMAID_NODE_PADDING } from './mermaidTheme';

export const LINE_HEIGHT = 19;
const CHAR_WIDTH = MERMAID_FONT_SIZE * 0.56;
const WRAP_AT = 24;
export const GROUP_TITLE_ROOM = 24;

export interface Point {
    x: number;
    y: number;
}

export interface LaidNode extends FlowNode {
    x: number;
    y: number;
    width: number;
    height: number;
    lines: string[];
}

export interface LaidEdge extends FlowEdge {
    points: Point[];
    labelAt: Point | null;
    labelLines: string[];
}

export interface LaidGroup {
    id: string;
    title: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface FlowLayout {
    width: number;
    height: number;
    nodes: LaidNode[];
    edges: LaidEdge[];
    groups: LaidGroup[];
}

/** A label cut into lines: its own breaks first, then words wrapped near WRAP_AT characters. */
export function wrapLabel(label: string): string[] {
    const out: string[] = [];
    for (const line of label.split('\n')) {
        let current = '';
        for (const word of line.split(/\s+/).filter(Boolean)) {
            if (current && current.length + 1 + word.length > WRAP_AT) {
                out.push(current);
                current = word;
            } else current = current ? `${current} ${word}` : word;
        }
        out.push(current);
    }
    return out.length ? out : [''];
}

/** The size a few lines of 14px label text take. */
export function textBox(lines: readonly string[]): { w: number; h: number } {
    return { w: Math.max(...lines.map((l) => l.length), 1) * CHAR_WIDTH, h: lines.length * LINE_HEIGHT };
}

/** The node's box for its shape, as Mermaid sizes it around the text. */
export function nodeSize(shape: NodeShape, lines: readonly string[]): { width: number; height: number } {
    const { w, h } = textBox(lines);
    const pad = MERMAID_NODE_PADDING;
    switch (shape) {
        case 'circle':
        case 'doublecircle': {
            const d = Math.max(w, h) + pad * 2 + (shape === 'doublecircle' ? 10 : 0);
            return { width: d, height: d };
        }
        case 'rhombus': {
            const s = w + h + pad;
            return { width: s, height: s };
        }
        case 'hexagon':
            return { width: w + h + pad * 2, height: h + pad * 1.4 };
        case 'cylinder':
            return { width: w + pad * 2, height: h + pad * 1.4 + 16 };
        case 'parallelogram':
        case 'parallelogram-alt':
        case 'trapezoid':
        case 'trapezoid-alt':
            return { width: w + h + pad * 2, height: h + pad * 1.4 };
        default:
            return { width: w + pad * 2, height: h + pad * 1.4 };
    }
}

export function layoutFlowchart(chart: Flowchart): FlowLayout {
    const g = new graphlib.Graph({ compound: true, multigraph: true });
    g.setGraph({ rankdir: chart.direction, nodesep: 50, ranksep: 50, marginx: 8, marginy: 8 + GROUP_TITLE_ROOM });
    g.setDefaultEdgeLabel(() => ({}));
    const lines = new Map(chart.nodes.map((n) => [n.id, wrapLabel(n.label)]));
    for (const node of chart.nodes) g.setNode(node.id, nodeSize(node.shape, lines.get(node.id) ?? ['']));
    for (const group of chart.groups) g.setNode(group.id, {});
    for (const group of chart.groups) {
        if (group.parent) g.setParent(group.id, group.parent);
        for (const id of group.nodes) if (g.hasNode(id)) g.setParent(id, group.id);
    }
    const edges = chart.edges.filter((e) => lines.has(e.from) && lines.has(e.to));
    edges.forEach((edge, i) => {
        const labelLines = edge.label ? wrapLabel(edge.label) : [];
        const box = labelLines.length ? textBox(labelLines) : { w: 0, h: 0 };
        g.setEdge(edge.from, edge.to, { width: box.w + 8, height: box.h, labelpos: 'c' }, String(i));
    });
    layout(g);

    const nodes = chart.nodes.map((node) => {
        const n = g.node(node.id);
        return { ...node, x: n.x, y: n.y, width: n.width, height: n.height, lines: lines.get(node.id) ?? [''] };
    });
    const laidEdges = edges.map((edge, i) => {
        const e = g.edge({ v: edge.from, w: edge.to, name: String(i) });
        const labelLines = edge.label ? wrapLabel(edge.label) : [];
        const labelAt = labelLines.length && e.x !== undefined && e.y !== undefined ? { x: e.x, y: e.y } : null;
        return { ...edge, points: (e.points ?? []).map((p: Point) => ({ x: p.x, y: p.y })), labelAt, labelLines };
    });
    const groups = chart.groups.map((group) => {
        const n = g.node(group.id);
        return { id: group.id, title: group.title, x: n.x, y: n.y - GROUP_TITLE_ROOM / 2, width: n.width, height: n.height + GROUP_TITLE_ROOM };
    });
    const graph = g.graph();
    return { width: graph.width ?? 0, height: graph.height ?? 0, nodes, edges: laidEdges, groups };
}
