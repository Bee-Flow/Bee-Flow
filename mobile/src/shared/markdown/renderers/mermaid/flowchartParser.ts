/**
 * Mermaid flowcharts (`graph TD` / `flowchart LR`), parsed without Mermaid.
 *
 * Mermaid needs a browser DOM to lay anything out, so the phone reads the
 * flowchart language itself — the kind of diagram models draw most — and
 * leaves every other kind (sequence, gantt, class, state, pie, …) to the code
 * block. Covered: the four directions; every node shape Mermaid names with
 * brackets; quoted and multi-line labels; solid, dotted, thick and invisible
 * links with arrow, circle and cross ends, of any length, labelled with
 * `|text|` or `-- text -->`; `&` fan-in and fan-out; chains (`A --> B --> C`);
 * and subgraphs. Styling statements (classDef, class, style, linkStyle, click)
 * are skipped: the phone paints every diagram in the web's Mermaid theme.
 *
 * A statement the parser cannot read is skipped rather than failing the
 * whole diagram; a source with no flowchart header, or nothing drawable in
 * it, is not a flowchart (null).
 */

import { cleanLabel, readNode, type NodeShape } from './flowchartNodes';

export type Direction = 'TB' | 'BT' | 'LR' | 'RL';
export type LineStyle = 'solid' | 'dotted' | 'thick' | 'invisible';
export type EdgeEnd = 'none' | 'arrow' | 'circle' | 'cross';

export interface FlowNode {
    id: string;
    label: string;
    shape: NodeShape;
}

export interface FlowEdge {
    from: string;
    to: string;
    label: string;
    line: LineStyle;
    start: EdgeEnd;
    end: EdgeEnd;
}

export interface FlowGroup {
    id: string;
    title: string;
    nodes: string[];
    parent: string | null;
}

export interface Flowchart {
    direction: Direction;
    nodes: FlowNode[];
    edges: FlowEdge[];
    groups: FlowGroup[];
}

const HEADER = /^(?:graph|flowchart)(?:\s+(TB|TD|BT|LR|RL))?\s*;?$/i;
const SKIPPED = /^(?:classDef|class|style|linkStyle|click|accTitle|accDescr|direction)\b/;
const SUBGRAPH = /^subgraph\s+(.+)$/;
/** `subgraph id [Title]` (or `id["Title"]`); a bare `subgraph Title` is its own id. */
const SUBGRAPH_TITLED = /^([^\s[]+)\s*\[(.*)\]$/;
/** `-- text -->`, `== text ==>`, `-. text .->`: a link with its words between its two halves. */
const TEXT_LINK = /^(<)?(--|==|-\.)[ \t]+(.*?)[ \t]+(-{2,}>|-{3,}|={2,}>|={3,}|\.-+>|\.-+|-{2,}[ox]|={2,}[ox])/;
/** A link without inline words: `-->`, `---`, `-.->`, `==>`, `<-->`, `--o`, `~~~`, … */
const LINK = /^(<|o|x)?(-\.+-|-{2,}|={2,}|~{3,})(>|o|x)?/;
const PIPE_LABEL = /^\s*\|([^|]*)\|/;

const END_OF: Record<string, EdgeEnd> = { '>': 'arrow', '<': 'arrow', o: 'circle', x: 'cross' };

function lineOf(body: string): LineStyle {
    if (body.startsWith('~')) return 'invisible';
    if (body.startsWith('=')) return 'thick';
    return body.includes('.') ? 'dotted' : 'solid';
}

interface Link {
    length: number;
    label: string;
    line: LineStyle;
    start: EdgeEnd;
    end: EdgeEnd;
}

function readLink(src: string): Link | null {
    const text = TEXT_LINK.exec(src);
    if (text) {
        const closing = text[4] as string;
        const tail = closing.slice(-1);
        return {
            length: text[0].length,
            label: (text[3] as string).trim(),
            line: lineOf(`${text[2]}${closing}`),
            start: text[1] ? 'arrow' : 'none',
            end: END_OF[tail] ?? 'none',
        };
    }
    const link = LINK.exec(src);
    if (!link) return null;
    const pipe = PIPE_LABEL.exec(src.slice(link[0].length));
    return {
        length: link[0].length + (pipe ? pipe[0].length : 0),
        label: pipe ? (pipe[1] as string).trim() : '',
        line: lineOf(link[2] as string),
        start: link[1] ? (END_OF[link[1]] ?? 'none') : 'none',
        end: link[3] ? (END_OF[link[3]] ?? 'none') : 'none',
    };
}

/** Statements: one per line, and `;` separates statements on a line (outside brackets and quotes). */
export function statements(body: string): string[] {
    const out: string[] = [];
    for (const line of body.split('\n')) {
        let depth = 0;
        let quoted = false;
        let current = '';
        for (const c of line) {
            if (c === '"') quoted = !quoted;
            else if (!quoted && '[({'.includes(c)) depth += 1;
            else if (!quoted && '])}'.includes(c)) depth = Math.max(0, depth - 1);
            if (c === ';' && !quoted && depth === 0) {
                out.push(current.trim());
                current = '';
            } else current += c;
        }
        out.push(current.trim());
    }
    return out.filter((s) => s && !s.startsWith('%%'));
}

class Builder {
    nodes = new Map<string, FlowNode>();
    edges: FlowEdge[] = [];
    groups: FlowGroup[] = [];
    open: FlowGroup[] = [];

    node(id: string, label: string | null, shape: NodeShape | null): void {
        const known = this.nodes.get(id);
        if (!known) this.nodes.set(id, { id, label: label ?? id, shape: shape ?? 'rect' });
        else if (label !== null) this.nodes.set(id, { id, label, shape: shape ?? known.shape });
        const group = this.open[this.open.length - 1];
        if (group && !group.nodes.includes(id) && !this.open.some((g) => g.id === id)) group.nodes.push(id);
    }

    subgraph(spec: string): void {
        const text = spec.trim();
        const titled = SUBGRAPH_TITLED.exec(text);
        const id = titled ? (titled[1] as string) : text.replace(/^"|"$/g, '');
        const title = cleanLabel(titled ? (titled[2] as string) : text);
        const group: FlowGroup = { id, title, nodes: [], parent: this.open[this.open.length - 1]?.id ?? null };
        this.groups.push(group);
        this.open.push(group);
    }

    /** `A & B --> C --> D`: node groups joined by links, every pair across a link connected. */
    chain(statement: string): boolean {
        let rest = statement;
        let previous: string[] | null = null;
        let pending: Link | null = null;
        for (;;) {
            const group: string[] = [];
            for (;;) {
                const node = readNode(rest.trimStart());
                if (!node) return false;
                this.node(node.id, node.label, node.shape);
                group.push(node.id);
                rest = rest.trimStart().slice(node.length).trimStart();
                if (!rest.startsWith('&')) break;
                rest = rest.slice(1);
            }
            if (previous && pending) this.connect(previous, group, pending);
            if (!rest) return true;
            pending = readLink(rest);
            if (!pending) return false;
            rest = rest.slice(pending.length);
            previous = group;
        }
    }

    connect(from: string[], to: string[], link: Link): void {
        for (const a of from) for (const b of to) this.edges.push({ from: a, to: b, label: link.label, line: link.line, start: link.start, end: link.end });
    }
}

function direction(raw: string | undefined): Direction {
    const d = (raw ?? 'TB').toUpperCase();
    return d === 'TD' ? 'TB' : (d as Direction);
}

export function readFlowchart(source: string): Flowchart | null {
    const lines = statements(source.replace(/%%\{[\s\S]*?\}%%/g, ''));
    const header = HEADER.exec(lines[0] ?? '');
    if (!header) return null;
    const b = new Builder();
    for (const statement of lines.slice(1)) {
        if (SKIPPED.test(statement)) continue;
        const sub = SUBGRAPH.exec(statement);
        if (sub) b.subgraph(sub[1] as string);
        else if (statement === 'end') b.open.pop();
        else b.chain(statement);
    }
    if (!b.nodes.size) return null;
    const groups = b.groups.filter((g) => g.nodes.length || b.groups.some((c) => c.parent === g.id));
    for (const g of groups) b.nodes.delete(g.id);
    return { direction: direction(header[1]), nodes: [...b.nodes.values()], edges: b.edges, groups };
}
