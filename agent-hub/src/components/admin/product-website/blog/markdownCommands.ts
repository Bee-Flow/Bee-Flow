// Pure text transforms behind the Markdown toolbar. Each takes the textarea
// value and selection and returns the new value and selection, so they are
// unit-tested without a DOM and the editor stays a thin shell around them.

export interface TextState {
    value: string;
    start: number;
    end: number;
}

/** Wrap the selection in `before`/`after` (or unwrap when it already is). */
export function wrapSelection(state: TextState, before: string, after = before, placeholder = ''): TextState {
    const { value, start, end } = state;
    const selected = value.slice(start, end);
    const outerBefore = value.slice(Math.max(0, start - before.length), start);
    const outerAfter = value.slice(end, end + after.length);
    if (selected && outerBefore === before && outerAfter === after) {
        const next = value.slice(0, start - before.length) + selected + value.slice(end + after.length);
        return { value: next, start: start - before.length, end: end - before.length };
    }
    const text = selected || placeholder;
    const next = value.slice(0, start) + before + text + after + value.slice(end);
    return { value: next, start: start + before.length, end: start + before.length + text.length };
}

/** The [lineStart, lineEnd) range covering every line the selection touches. */
function lineRange(value: string, start: number, end: number): [number, number] {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const nl = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
    return [lineStart, nl === -1 ? value.length : nl];
}

/**
 * Toggle a line prefix on every selected line ("## ", "- ", "> ").
 * `numbered` writes "1. ", "2. ", … instead of a fixed prefix. A heading
 * prefix replaces any other heading level already on the line.
 */
export function toggleLinePrefix(state: TextState, prefix: string, { numbered = false } = {}): TextState {
    const { value, start, end } = state;
    const [ls, le] = lineRange(value, start, end);
    const lines = value.slice(ls, le).split('\n');
    const isHeading = /^#{1,6} $/.test(prefix);
    const has = (line: string) => (numbered ? /^\d+\. /.test(line) : line.startsWith(prefix));
    const allHave = lines.every(has);
    const out = lines.map((line, i) => {
        if (allHave) return numbered ? line.replace(/^\d+\. /, '') : line.slice(prefix.length);
        let base = line;
        if (isHeading) base = base.replace(/^#{1,6} /, '');
        if (numbered) base = base.replace(/^\d+\. /, '');
        return `${numbered ? `${i + 1}. ` : prefix}${base}`;
    });
    const replaced = out.join('\n');
    const next = value.slice(0, ls) + replaced + value.slice(le);
    return { value: next, start: ls, end: ls + replaced.length };
}

/** Insert a block (image, rule) on its own line, with blank lines around it. */
export function insertBlock(state: TextState, block: string): TextState {
    const { value, start, end } = state;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const next = `${before}${lead}${block}${trail}${after}`;
    const caret = before.length + lead.length + block.length;
    return { value: next, start: caret, end: caret };
}

/** A link around the selection: [selection](url), with the url selected. */
export function insertLink(state: TextState, url = 'https://', placeholder = 'link text'): TextState {
    const { value, start, end } = state;
    const text = value.slice(start, end) || placeholder;
    const md = `[${text}](${url})`;
    const next = value.slice(0, start) + md + value.slice(end);
    const urlStart = start + text.length + 3;
    return { value: next, start: urlStart, end: urlStart + url.length };
}

/** Image Markdown for an uploaded asset; brackets in the alt text are escaped. */
export function imageMarkdown(url: string, alt = ''): string {
    const safeAlt = alt.replace(/[[\]]/g, '');
    const safeUrl = url.replace(/[()\s]/g, encodeURIComponent);
    return `![${safeAlt}](${safeUrl})`;
}

export function wordCount(markdown: string): number {
    return String(markdown || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[#>*_`~[\]()!-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean).length;
}
