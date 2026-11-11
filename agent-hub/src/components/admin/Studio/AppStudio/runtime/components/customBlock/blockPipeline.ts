import {
    buildFrameDocument, canonicalTemplate, domToTree, renderBlock, sanitizeTree, serializeFrameBody,
} from '@shared/blockTemplate/index.mjs';
import { sanitizeBlockCssClient } from './blockCss';

/**
 * App Studio runtime: one custom block, from its stored value to the document of its frame.
 *
 * Nothing here trusts what it is handed. The template may come from this server's
 * canonicalizer, from an import that never passed it, or from the editor's unsaved draft, so
 * every time a block is drawn:
 *
 *   1. the strict reader and the allow-list (the server's save path, the same code) give the
 *      canonical template;
 *   2. the browser's own INERT reader (DOMParser: nothing in it runs or loads) reads that text,
 *      and its tree goes through the allow-list AGAIN, so whatever the browser makes of the
 *      text, only vocabulary is left;
 *   3. the formulas, repeats and conditions are drawn against the block's inputs; a value is
 *      always text;
 *   4. the result is written as markup by the one writer that escapes everything and knows
 *      the same lists, and wrapped in the frame document with its own policy.
 *
 * The frame has no script and asks for no address, so it does not need the network at all.
 */

export interface BlockValue {
    template?: unknown;
    css?: unknown;
    inputs?: unknown;
    events?: unknown;
}

interface BlockFrameInput {
    block: BlockValue | null | undefined;
    /** The resolved inputs, by name: all a formula sees. */
    scope: Record<string, unknown>;
    /** The event names a control may raise on this page (wired, and the page lets actions run). */
    events: readonly string[];
    theme: Record<string, unknown>;
    dark: boolean;
    lang: string;
}

export interface BlockEmit { event: string; value: unknown }
export interface BlockFinding { line: number; code: string; message: string }

interface BlockFrame {
    /** The frame's whole document (`srcdoc`). */
    doc: string;
    /** What each numbered control raises; the frame holds the number only. */
    emits: BlockEmit[];
    /** Formulas that failed while drawing. */
    problems: string[];
    /** What the allow-list left out of the template, with its line. */
    findings: BlockFinding[];
    /** What the stylesheet sanitiser left out. */
    cssRemoved: string[];
    empty: boolean;
}

/** The browser's inert reading of a template text, as a tree (nothing runs, nothing loads). */
function readInert(template: string) {
    const parsed = new DOMParser().parseFromString(template, 'text/html');
    return domToTree(parsed.body as never);
}

export function buildBlockFrame(input: BlockFrameInput): BlockFrame {
    const block = input.block && typeof input.block === 'object' ? input.block : {};
    const canonical = canonicalTemplate(block.template);
    const clean = sanitizeTree(readInert(canonical.template));
    const drawn = renderBlock(clean.nodes, { scope: input.scope, events: input.events });
    const css = sanitizeBlockCssClient(block.css);
    return {
        doc: buildFrameDocument({ body: serializeFrameBody(drawn.nodes), css: css.css, theme: input.theme, lang: input.lang, dark: input.dark }),
        emits: drawn.emits,
        problems: drawn.problems,
        findings: canonical.findings,
        cssRemoved: css.removed,
        empty: !canonical.template.trim(),
    };
}

/** The entries of a `{ name: value }` map of a block, or none when it is not one. */
export function blockEntries(map: unknown): Array<[string, unknown]> {
    return map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map as Record<string, unknown>) : [];
}
