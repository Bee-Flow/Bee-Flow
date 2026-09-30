/**
 * A flowchart node reference: its id, and optionally its shape and label —
 * `A`, `A[Text]`, `B(Round)`, `C{Decision?}`, `D(("Circle"))` and the rest of
 * Mermaid's bracket shapes — read from the start of a statement.
 */

import { decodeEntities } from '@/shared/markdown/parse/entities';

export type NodeShape =
    | 'rect'
    | 'round'
    | 'stadium'
    | 'subroutine'
    | 'cylinder'
    | 'circle'
    | 'doublecircle'
    | 'asymmetric'
    | 'rhombus'
    | 'hexagon'
    | 'parallelogram'
    | 'parallelogram-alt'
    | 'trapezoid'
    | 'trapezoid-alt';

/** Openers, longest first, each with the closers it may end with. */
const SHAPES: readonly { open: string; close: readonly [string, NodeShape][] }[] = [
    { open: '(((', close: [[')))', 'doublecircle']] },
    { open: '((', close: [['))', 'circle']] },
    { open: '([', close: [['])', 'stadium']] },
    { open: '[[', close: [[']]', 'subroutine']] },
    { open: '[(', close: [[')]', 'cylinder']] },
    { open: '[/', close: [['/]', 'parallelogram'], ['\\]', 'trapezoid']] },
    { open: '[\\', close: [['\\]', 'parallelogram-alt'], ['/]', 'trapezoid-alt']] },
    { open: '{{', close: [['}}', 'hexagon']] },
    { open: '{', close: [['}', 'rhombus']] },
    { open: '(', close: [[')', 'round']] },
    { open: '[', close: [[']', 'rect']] },
    { open: '>', close: [[']', 'asymmetric']] },
];

const ID = /^[\w$À-￿]+/;
const CLASS_SUFFIX = /^:::[\w-]+/;

/** A label as Mermaid shows it: unquoted, `<br>` as a line break, entities decoded. */
export function cleanLabel(raw: string): string {
    let text = raw.trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
    if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1);
    text = text.replace(/<br\s*\/?>/gi, '\n').replace(/#(quot|amp|lt|gt|nbsp);/g, '&$1;');
    return decodeEntities(text.replace(/fa:fa-[\w-]+\s*/g, '')).trim();
}

/** The end of a bracketed label: past a quoted string, the first closer that fits. */
function findClose(src: string, from: number, closers: readonly [string, NodeShape][]): { at: number; close: string; shape: NodeShape } | null {
    let i = from;
    if (src[i] === '"') {
        const endQuote = src.indexOf('"', i + 1);
        if (endQuote < 0) return null;
        i = endQuote + 1;
    }
    let best: { at: number; close: string; shape: NodeShape } | null = null;
    for (const [close, shape] of closers) {
        const at = src.indexOf(close, i);
        if (at >= 0 && (!best || at < best.at)) best = { at, close, shape };
    }
    return best;
}

export interface NodeRef {
    id: string;
    /** null when the reference names the node without (re)defining it. */
    label: string | null;
    shape: NodeShape | null;
    /** How much of the source the reference took. */
    length: number;
}

export function readNode(src: string): NodeRef | null {
    const id = ID.exec(src)?.[0];
    if (!id) return null;
    let i = id.length;
    const cls = CLASS_SUFFIX.exec(src.slice(i));
    if (cls) i += cls[0].length;
    const spec = SHAPES.find((s) => src.startsWith(s.open, i));
    if (!spec) return { id, label: null, shape: null, length: i };
    const found = findClose(src, i + spec.open.length, spec.close);
    if (!found) return null;
    const label = cleanLabel(src.slice(i + spec.open.length, found.at));
    let end = found.at + found.close.length;
    const after = CLASS_SUFFIX.exec(src.slice(end));
    if (after) end += after[0].length;
    return { id, label, shape: found.shape, length: end };
}
