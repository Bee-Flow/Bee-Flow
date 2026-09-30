/**
 * toc.ts — the table of contents: every heading in the document, wherever it
 * sits (top level, inside a quote, a list item or a table cell), in document
 * order, with its level so the outline can indent sub-headings.
 *
 * `itemIndex` is the heading's position in this list; scrollToHeading(index)
 * on the editor ref scrolls to exactly that heading, so a TOC click works
 * without ids in the document.
 */

export interface TocItem {
    id: string;
    level: number;
    textContent: string;
    itemIndex: number;
    isActive: boolean;
    isScrolledOver: boolean;
    path: number[];
}

interface AnyNode { type: string; content?: AnyNode[]; text?: string; attrs?: Record<string, unknown> }

function plainText(n: AnyNode): string {
    let s = '';
    for (const c of n.content || []) {
        if (c.type === 'text') s += c.text || '';
        else if (c.type === 'hardBreak') s += ' ';
    }
    return s.trim();
}

/** Headings in document order, with their paths. */
export function collectHeadings(doc: AnyNode): Array<{ path: number[]; level: number; text: string; node: AnyNode }> {
    const out: Array<{ path: number[]; level: number; text: string; node: AnyNode }> = [];
    const walk = (n: AnyNode, p: number[]) => {
        if (n.type === 'heading') {
            const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
            out.push({ path: p, level, text: plainText(n), node: n });
            return;
        }
        if (n.type === 'paragraph' || n.type === 'codeBlock') return;
        (n.content || []).forEach((c, i) => walk(c, [...p, i]));
    };
    (doc.content || []).forEach((c, i) => walk(c, [i]));
    return out;
}

/** TOC items for the outline panel; `activeIndex` marks the heading being read. */
export function tocItems(doc: AnyNode, activeIndex = -1): TocItem[] {
    return collectHeadings(doc).map((h, i) => ({
        id: `bf-h-${i}`,
        level: h.level,
        textContent: h.text,
        itemIndex: i,
        isActive: i === activeIndex,
        isScrolledOver: activeIndex >= 0 && i < activeIndex,
        path: h.path,
    }));
}

/**
 * The heading being read: the last one whose top is above the reading line
 * (a quarter down the scroll area), or -1 above the first heading.
 */
export function activeHeadingIndex(tops: number[], readingLine: number): number {
    let active = -1;
    for (let i = 0; i < tops.length; i += 1) {
        if (tops[i] <= readingLine) active = i;
        else break;
    }
    return active;
}

/** Cheap signature of the TOC, so an unchanged outline is not re-sent. */
export function tocSignature(items: TocItem[]): string {
    return items.map((i) => `${i.level}:${i.textContent}:${i.isActive ? 1 : 0}`).join('\u0001');
}
