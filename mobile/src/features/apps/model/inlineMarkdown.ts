/**
 * The "small markdown subset" that `markdown`-typed props carry —
 * bold, italic and links — ported from the web runtime's markdownInline.jsx.
 *
 * The phone was rendering these props as raw strings, so `**spoed**` reached
 * the screen with its asterisks showing. `text` alone appears 464 times across
 * the shipped templates, so this was visible on essentially every app screen.
 *
 * Deliberately NOT a markdown library. The web's parser is a character scanner
 * with no regex and no HTML, and the grammar it accepts is the contract the
 * server's componentSpecs.js documents: anything wider would let an app
 * definition smuggle in images, tables or code blocks that the spec says are
 * not part of a markdown-typed prop. This mirrors that scanner exactly, so the
 * same string renders the same way in a browser and on a phone.
 *
 * The output is a FLAT span list rather than a tree. React Native's <Text>
 * nests and inherits, so nesting would work — but flat spans keep the renderer
 * a map() and keep this module pure and testable, and the subset has no
 * construct where the difference is visible.
 */

export interface InlineSpan {
    text: string;
    bold: boolean;
    italic: boolean;
    /** An http(s) URL, or null. Anything else is not a link — see isSafeHref. */
    href: string | null;
}

/**
 * Links are http(s) only, exactly as the web restricts them. A `javascript:`
 * or `data:` href in an app definition is not a link the phone will open.
 */
function isSafeHref(url: string): boolean {
    const u = String(url ?? '')
        .trim()
        .toLowerCase();
    return u.startsWith('https://') || u.startsWith('http://');
}

interface Marks {
    bold: boolean;
    italic: boolean;
    href: string | null;
}

/**
 * A `[label](url)` starting at `start`, or null when the text there is not a
 * complete, non-empty link to a safe href — in which case the `[` is literal.
 */
function linkAt(text: string, start: number): { label: string; href: string; end: number } | null {
    const closeBracket = text.indexOf(']', start + 1);
    if (closeBracket === -1 || text[closeBracket + 1] !== '(') return null;
    const closeParen = text.indexOf(')', closeBracket + 2);
    if (closeParen === -1) return null;
    const label = text.slice(start + 1, closeBracket);
    const href = text.slice(closeBracket + 2, closeParen).trim();
    return label && isSafeHref(href) ? { label, href, end: closeParen + 1 } : null;
}

function scan(text: string, marks: Marks, out: InlineSpan[]): void {
    let buf = '';
    let i = 0;
    const flush = () => {
        if (buf) {
            out.push({ text: buf, ...marks });
            buf = '';
        }
    };

    while (i < text.length) {
        const ch = text[i];

        // **bold** / *italic*
        if (ch === '*') {
            const bold = text[i + 1] === '*';
            const marker = bold ? '**' : '*';
            const close = text.indexOf(marker, i + marker.length);
            const inner = close === -1 ? '' : text.slice(i + marker.length, close);
            // An unclosed or empty marker is literal text, not a broken tag.
            if (inner.trim()) {
                flush();
                scan(inner, { ...marks, [bold ? 'bold' : 'italic']: true }, out);
                i = close + marker.length;
                continue;
            }
            buf += ch;
            i += 1;
            continue;
        }

        // [label](https://…)
        const link = ch === '[' ? linkAt(text, i) : null;
        if (link) {
            flush();
            scan(link.label, { ...marks, href: link.href }, out);
            i = link.end;
            continue;
        }

        buf += ch;
        i += 1;
    }
    flush();
}

/** Split a markdown-subset string into styled spans. Never throws. */
export function parseInlineMarkdown(text: string | null | undefined): InlineSpan[] {
    if (text == null) return [];
    const out: InlineSpan[] = [];
    scan(String(text), { bold: false, italic: false, href: null }, out);
    return out;
}

/** True when the string has no markup, so the caller can skip the span path. */
export function isPlain(spans: InlineSpan[]): boolean {
    return spans.every((s) => !s.bold && !s.italic && !s.href);
}
