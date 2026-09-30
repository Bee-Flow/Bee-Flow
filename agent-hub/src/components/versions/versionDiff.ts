// Compare two states of a notebook or document with the editor's own diff
// (editor/diff: block-level with word-level inside changed blocks), and shape
// the answer for the three renderings: inline, side by side, only changes.
//
// The diff's answer is read defensively: every field is checked before use,
// so a block the compare view does not know renders as its text rather than
// breaking the panel.

import { diffHtml, diffMarkdown } from '../../editor/diff';
import type { VersionContent } from '../../api/queries/versions';

/** An editor AST node, as far as the compare view reads it. */
export interface AstNode {
    type: string;
    attrs?: Record<string, unknown>;
    content?: AstNode[];
    marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
    text?: string;
}

export type WordOp = 'equal' | 'insert' | 'delete';
export interface DiffWord { op: WordOp; text: string }

export type BlockOp = 'equal' | 'insert' | 'delete' | 'modify';
export interface DiffBlock {
    op: BlockOp;
    before: AstNode | null;
    after: AstNode | null;
    words: DiffWord[] | null;
    formatOnly: boolean;
}

export interface VersionDiff {
    blocks: DiffBlock[];
    stats: { wordsAdded: number; wordsRemoved: number; blocksChanged: number };
    /** Too large to compare block by block: only the counts are known. */
    truncated: boolean;
}

const BLOCK_OPS = new Set<BlockOp>(['equal', 'insert', 'delete', 'modify']);
const WORD_OPS = new Set<WordOp>(['equal', 'insert', 'delete']);

const isNode = (v: unknown): v is AstNode => !!v && typeof v === 'object' && typeof (v as AstNode).type === 'string';
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

function toWords(raw: unknown): DiffWord[] | null {
    if (!Array.isArray(raw)) return null;
    return raw
        .filter((w) => w && typeof w === 'object' && WORD_OPS.has((w as DiffWord).op) && typeof (w as DiffWord).text === 'string')
        .map((w) => ({ op: (w as DiffWord).op, text: (w as DiffWord).text }));
}

/** The diff module's answer, with every field checked. */
export function normalizeDiff(raw: unknown): VersionDiff {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { blocks?: unknown; stats?: Record<string, unknown>; truncated?: unknown };
    const blocks: DiffBlock[] = (Array.isArray(r.blocks) ? r.blocks : [])
        .filter((b) => b && typeof b === 'object' && BLOCK_OPS.has((b as DiffBlock).op))
        .map((b) => {
            const x = b as Record<string, unknown>;
            return {
                op: x.op as BlockOp,
                before: isNode(x.before) ? x.before : null,
                after: isNode(x.after) ? x.after : null,
                words: toWords(x.words),
                formatOnly: x.formatOnly === true,
            };
        });
    const s = r.stats || {};
    return {
        blocks,
        stats: { wordsAdded: count(s.wordsAdded), wordsRemoved: count(s.wordsRemoved), blocksChanged: count(s.blocksChanged) },
        truncated: r.truncated === true,
    };
}

/**
 * The diff from `from` to `to`. Markdown when both sides have it (the
 * notebook source), HTML otherwise.
 */
export function diffVersions(from: VersionContent, to: VersionContent): VersionDiff {
    if (from.markdown !== null && to.markdown !== null && (from.markdown || to.markdown)) {
        return normalizeDiff(diffMarkdown(from.markdown, to.markdown));
    }
    return normalizeDiff(diffHtml(from.html || '', to.html || ''));
}

export const isChange = (b: DiffBlock): boolean => b.op !== 'equal';

// ── Only changes ────────────────────────────────────────────────────────

export type FoldedEntry =
    | { kind: 'block'; index: number; block: DiffBlock }
    | { kind: 'gap'; from: number; to: number; count: number };

/**
 * The blocks with runs of unchanged ones folded into gaps, keeping `context`
 * unchanged blocks on each side of a change. No change at all folds
 * everything into one gap.
 */
export function foldUnchanged(blocks: DiffBlock[], context = 1): FoldedEntry[] {
    const keep = new Array<boolean>(blocks.length).fill(false);
    blocks.forEach((b, i) => {
        if (!isChange(b)) return;
        for (let j = Math.max(0, i - context); j <= Math.min(blocks.length - 1, i + context); j += 1) keep[j] = true;
    });
    const out: FoldedEntry[] = [];
    let gapStart = -1;
    const closeGap = (end: number) => {
        if (gapStart >= 0) out.push({ kind: 'gap', from: gapStart, to: end - 1, count: end - gapStart });
        gapStart = -1;
    };
    blocks.forEach((block, index) => {
        if (keep[index]) {
            closeGap(index);
            out.push({ kind: 'block', index, block });
        } else if (gapStart < 0) {
            gapStart = index;
        }
    });
    closeGap(blocks.length);
    return out;
}

/** Plain text of a node, for labels and fallbacks. */
export function textOf(node: AstNode | null | undefined): string {
    if (!node) return '';
    if (typeof node.text === 'string') return node.text;
    return (node.content || []).map(textOf).join(node.type === 'tableRow' ? ' | ' : '');
}
