/**
 * The notes editor's toolbar, as pure text edits: each one takes the text and
 * the selection and answers the new text and where the cursor goes. The
 * syntax is the Markdown the web's `markdownToAst` reads (headings, `**`,
 * `*`, `- `, `1. `, `- [ ] `, `> `).
 */

export type MarkdownFormat = 'heading' | 'bold' | 'italic' | 'bullet' | 'numbered' | 'task' | 'quote';

export interface Selection {
    start: number;
    end: number;
}

export interface Edit {
    text: string;
    selection: Selection;
}

const WRAPS: Partial<Record<MarkdownFormat, string>> = { bold: '**', italic: '*' };
const PREFIXES: Partial<Record<MarkdownFormat, string>> = {
    heading: '## ',
    bullet: '- ',
    numbered: '1. ',
    task: '- [ ] ',
    quote: '> ',
};

/** Any list, quote or heading marker a line may already start with. */
const LINE_MARKER = /^(#{1,6} |- \[[ xX]\] |[-*+] |\d+[.)] |> )/;

function wrap(text: string, sel: Selection, mark: string): Edit {
    const inner = text.slice(sel.start, sel.end);
    const before = text.slice(0, sel.start);
    const after = text.slice(sel.end);
    // Already wrapped: take the marks off again.
    if (before.endsWith(mark) && after.startsWith(mark) && inner) {
        const start = sel.start - mark.length;
        return {
            text: before.slice(0, start) + inner + after.slice(mark.length),
            selection: { start, end: start + inner.length },
        };
    }
    const start = sel.start + mark.length;
    return { text: `${before}${mark}${inner}${mark}${after}`, selection: { start, end: start + inner.length } };
}

function linePrefix(text: string, sel: Selection, prefix: string): Edit {
    const lineStart = text.lastIndexOf('\n', sel.start - 1) + 1;
    const nextBreak = text.indexOf('\n', sel.end);
    const lineEnd = nextBreak === -1 ? text.length : nextBreak;
    const lines = text.slice(lineStart, lineEnd).split('\n');
    const allHave = lines.every((line) => line.startsWith(prefix));
    const changed = lines.map((line) => (allHave ? line.slice(prefix.length) : prefix + line.replace(LINE_MARKER, '')));
    const block = changed.join('\n');
    const delta = block.length - (lineEnd - lineStart);
    const cursor = Math.max(lineStart, sel.end + delta);
    return {
        text: text.slice(0, lineStart) + block + text.slice(lineEnd),
        selection: sel.start === sel.end ? { start: cursor, end: cursor } : { start: lineStart, end: lineEnd + delta },
    };
}

export function applyFormat(text: string, selection: Selection, format: MarkdownFormat): Edit {
    const sel = {
        start: Math.max(0, Math.min(selection.start, selection.end, text.length)),
        end: Math.min(text.length, Math.max(selection.start, selection.end)),
    };
    const mark = WRAPS[format];
    if (mark) return wrap(text, sel, mark);
    return linePrefix(text, sel, PREFIXES[format] ?? '');
}
