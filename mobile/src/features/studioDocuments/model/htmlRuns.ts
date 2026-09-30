/**
 * The document body as editable text runs — the native form of the web's
 * "Edit text" mode, where a person clicks any text on the sheet and types
 * while the layout stays exactly as designed.
 *
 * A run is one stretch of text between two tags. Editing replaces ONLY the
 * characters of that run (re-escaped), so every tag, attribute, section
 * marker and style in the body survives byte for byte: the phone can change
 * the words of an invoice without ever being able to break its layout. Text
 * inside <style>, <script>, <textarea>, <title> and comments is not a run.
 *
 * A run that is nothing but template control markers (`{{#each lines}}`,
 * `{{/if}}`, `{{else}}`) is flagged `marker`: it is structure, not prose, and
 * the editor shows it read-only.
 */

export type RunBlock = 'heading' | 'paragraph' | 'listItem' | 'cell' | 'header' | 'footer' | 'text';

export interface TextRun {
    /** Position among the body's runs; stable for as long as the body is. */
    index: number;
    /** Offsets of the raw run in the body. */
    start: number;
    end: number;
    /** The decoded text without its surrounding whitespace. */
    text: string;
    block: RunBlock;
    /** The nearest block element's tag (h1, p, td, …), or '' at the top level. */
    tag: string;
    /** The enclosing `data-doc-section`, if any. */
    section: string | null;
    marker: boolean;
}

const RAW_TEXT = new Set(['style', 'script', 'textarea', 'title']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Block elements by tag name (a Map: the tags are data, not labels). */
const BLOCKS = new Map<string, RunBlock>([
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((h): [string, RunBlock] => [h, 'heading']),
    ['p', 'paragraph'],
    ['li', 'listItem'],
    ['td', 'cell'],
    ['th', 'cell'],
    ['header', 'header'],
    ['footer', 'footer'],
]);
const MARKERS = /^(?:\{\{\s*(?:[#/][^{}]*|else)\s*\}\}\s*)+$/;

interface OpenTag {
    name: string;
    section: string | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(raw: string): string {
    return raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
        const lower = name.toLowerCase();
        if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
        if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
        return ENTITIES[lower] ?? whole;
    });
}

export function escapeText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tagName(tag: string): string {
    const m = /^<\/?\s*([a-zA-Z][\w:-]*)/.exec(tag);
    return m ? (m[1] as string).toLowerCase() : '';
}

function sectionAttr(tag: string): string | null {
    const m = /\sdata-doc-section\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/** Where a comment starting at `at` ends. */
function commentEnd(html: string, at: number): number {
    const close = html.indexOf('-->', at + 4);
    return close === -1 ? html.length : close + 3;
}

/** An opening tag: a raw-text element skips to its closing tag; others are pushed unless void. */
function openTag(html: string, tag: string, end: number, stack: OpenTag[]): number {
    const name = tagName(tag);
    if (RAW_TEXT.has(name)) {
        const closing = html.toLowerCase().indexOf(`</${name}`, end);
        return closing === -1 ? html.length : closing;
    }
    if (!VOID.has(name) && !tag.endsWith('/>')) {
        const parent = stack[stack.length - 1];
        stack.push({ name, section: sectionAttr(tag) ?? parent?.section ?? null });
    }
    return end;
}

/** Where the markup starting at `at` ends: a comment, a raw-text element or a tag. */
function skipMarkup(html: string, at: number, stack: OpenTag[]): number {
    if (html.startsWith('<!--', at)) return commentEnd(html, at);
    const close = html.indexOf('>', at);
    const end = close === -1 ? html.length : close + 1;
    const tag = html.slice(at, end);
    const name = tagName(tag);
    if (!name || tag.startsWith('<!') || tag.startsWith('<?')) return end;
    if (!tag.startsWith('</')) return openTag(html, tag, end, stack);
    const found = stack.map((t) => t.name).lastIndexOf(name);
    if (found !== -1) stack.length = found;
    return end;
}

function blockOf(stack: OpenTag[]): { block: RunBlock; tag: string } {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
        const name = (stack[i] as OpenTag).name;
        const block = BLOCKS.get(name);
        if (block) return { block, tag: name };
    }
    return { block: 'text', tag: '' };
}

/** Every editable stretch of text in a body, in document order. */
export function textRuns(html: string): TextRun[] {
    const runs: TextRun[] = [];
    const stack: OpenTag[] = [];
    let at = 0;
    while (at < html.length) {
        if (html[at] === '<' && /[a-zA-Z/!?]/.test(html[at + 1] ?? '')) {
            at = skipMarkup(html, at, stack);
            continue;
        }
        const next = html.indexOf('<', at + 1);
        const end = next === -1 ? html.length : next;
        const text = decodeEntities(html.slice(at, end)).trim();
        if (text) {
            runs.push({
                index: runs.length,
                start: at,
                end,
                text,
                ...blockOf(stack),
                section: stack[stack.length - 1]?.section ?? null,
                marker: MARKERS.test(text),
            });
        }
        at = end;
    }
    return runs;
}

/**
 * The body with some runs rewritten. The whitespace around each run is kept,
 * an unchanged run keeps its original bytes (entities and all), and runs are
 * rewritten from the end so earlier offsets stay valid.
 */
export function applyRunEdits(html: string, runs: readonly TextRun[], edits: ReadonlyMap<number, string>): string {
    let out = html;
    for (let i = runs.length - 1; i >= 0; i -= 1) {
        const run = runs[i] as TextRun;
        const next = edits.get(run.index);
        if (next === undefined || next === run.text) continue;
        const raw = html.slice(run.start, run.end);
        // trimStart/trimEnd strip exactly what \s matches, in linear time. A
        // /\s*$/ scan retries from every whitespace position and goes
        // quadratic on a long stretch of spaces inside a run.
        const lead = raw.slice(0, raw.length - raw.trimStart().length);
        const trail = raw.slice(raw.trimEnd().length);
        out =out.slice(0, run.start) + lead + escapeText(next) + trail + out.slice(run.end);
    }
    return out;
}
