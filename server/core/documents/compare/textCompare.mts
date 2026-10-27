/**
 * What changed between two text documents (a page, a designed document, or a
 * presentation outline read as text), block by block.
 *
 * This is the editor's own diff (agent-hub src/editor/diff, bundled for the
 * server as core/markdown/editorCollab.cjs): the same alignment, pairing and
 * word diff Version history shows, so an app and the Documents editor never
 * disagree about what changed. Both sides become editor ASTs first, which is
 * also what lets a page be compared with a presentation outline (Markdown).
 *
 * The answer carries the blocks as AST nodes; the app runtime draws them
 * with the version-compare renderer (components/versions/DiffBlockView).
 * Above the diff's block limit (DOCUMENT_COMPARE_MAX_TEXT_BLOCKS, ./limits.mts)
 * only the counts come back (`truncated`).
 */

import { createRequire } from 'node:module';
import { compareLimits } from './limits.mts';

const nodeRequire = createRequire(import.meta.url);

export type AstNode = { type: string; attrs?: Record<string, unknown>; content?: AstNode[]; marks?: unknown[]; text?: string };
export interface TextDiffBlock {
    op: 'equal' | 'insert' | 'delete' | 'modify';
    before?: AstNode;
    after?: AstNode;
    words?: Array<{ op: 'equal' | 'insert' | 'delete'; text: string }>;
    formatOnly?: boolean;
}
export interface TextCompareResult {
    family: 'text';
    blocks: TextDiffBlock[];
    truncated: boolean;
    summary: { changed: number; added: number; removed: number; unchanged: number; wordsAdded: number; wordsRemoved: number };
}

/** One side: HTML (a page or designed document) or Markdown (a presentation outline). */
export type TextSource = { html: string } | { markdown: string };

interface EditorBundle {
    htmlToAst: (html: string, parser: unknown) => AstNode;
    markdownToAst: (md: string) => AstNode;
    diffDocs: (a: AstNode, b: AstNode, opts?: { maxBlocks?: number }) => {
        blocks: TextDiffBlock[];
        stats: { wordsAdded: number; wordsRemoved: number; blocksChanged: number };
        truncated?: boolean;
    };
}

let bundle: EditorBundle | null = null;
function editor(): EditorBundle {
    bundle ||= nodeRequire('../../markdown/editorCollab.cjs') as EditorBundle;
    return bundle;
}

let parser: unknown = null;
function domParser(): unknown {
    if (!parser) {
        const { JSDOM } = nodeRequire('jsdom') as { JSDOM: new (html: string) => { window: { DOMParser: unknown } } };
        parser = new JSDOM('').window.DOMParser;
    }
    return parser;
}


function astOf(source: TextSource): AstNode {
    if ('markdown' in source) return editor().markdownToAst(source.markdown || '');
    return editor().htmlToAst(source.html || '', domParser());
}

export function compareText(left: TextSource, right: TextSource): TextCompareResult {
    const out = editor().diffDocs(astOf(left), astOf(right), { maxBlocks: compareLimits().maxTextBlocks });
    const blocks = Array.isArray(out.blocks) ? out.blocks : [];
    const count = (op: TextDiffBlock['op']) => blocks.filter((b) => b.op === op).length;
    return {
        family: 'text',
        blocks,
        truncated: out.truncated === true,
        summary: {
            changed: out.truncated ? Number(out.stats?.blocksChanged) || 0 : count('modify'),
            added: count('insert'),
            removed: count('delete'),
            unchanged: count('equal'),
            wordsAdded: Number(out.stats?.wordsAdded) || 0,
            wordsRemoved: Number(out.stats?.wordsRemoved) || 0,
        },
    };
}
