import type { ReactNode } from 'react';

/**
 * App Studio runtime — the "small markdown subset" (bold / italic / links)
 * that `markdown`-typed props support per componentSpecs.js.
 *
 * Deliberately NOT the chat MarkdownRenderer: that one renders full markdown
 * (code blocks, tables, images…) which app definitions must not smuggle in.
 * This is a tiny character scanner (no regex, no dangerouslySetInnerHTML) that
 * emits React elements only — output is escaped by construction. Links are
 * restricted to http(s) and always open in a new tab with rel=noopener.
 *
 * RICH mode (markdownRich.tsx, a markdown block with rich on, since 3) adds two things and
 * nothing else: mailto: links and `![alt](ref)` pictures. The picture itself is drawn by the
 * `image` callback of the options (it answers null for anything that is not an uploaded file
 * of the app, and the text then stays text), so this module stays free of the asset layer.
 */

export interface InlineOptions {
    /** Also allow mailto: links. */
    mailto?: boolean;
    /** Draws `![alt](ref)`; null = not a picture, keep the characters as text. Absent = no pictures. */
    image?: (ref: string, alt: string, key: string) => ReactNode | null;
}

function isSafeHref(url: string, mailto = false) {
    const u = String(url || '').trim().toLowerCase();
    return u.startsWith('https://') || u.startsWith('http://') || (mailto && u.startsWith('mailto:'));
}

/** What a reader found at a position: the node to draw and the index after what it consumed. */
interface Found {
    node: ReactNode;
    end: number;
}

/** **bold** / *italic* at `i`, or null when the marker has no content. */
function readEmphasis(text: string, i: number, keyPrefix: string, opts?: InlineOptions): Found | null {
    const bold = text[i + 1] === '*';
    const marker = bold ? '**' : '*';
    const close = text.indexOf(marker, i + marker.length);
    const inner = close === -1 ? '' : text.slice(i + marker.length, close);
    if (!inner.trim()) return null;
    const key = `${keyPrefix}-${i}`;
    const kids = parse(inner, key, opts);
    return { node: bold ? <strong key={key}>{kids}</strong> : <em key={key}>{kids}</em>, end: close + marker.length };
}

/** ![alt](ref) at `i` in rich mode, or null when it is not a picture the options draw. */
function readImage(text: string, i: number, keyPrefix: string, opts?: InlineOptions): Found | null {
    if (!opts?.image || text[i + 1] !== '[') return null;
    const closeBracket = text.indexOf(']', i + 2);
    const closeParen = closeBracket !== -1 && text[closeBracket + 1] === '(' ? text.indexOf(')', closeBracket + 2) : -1;
    if (closeParen === -1) return null;
    const drawn = opts.image(text.slice(closeBracket + 2, closeParen).trim(), text.slice(i + 2, closeBracket), `${keyPrefix}-${i}`);
    return drawn ? { node: drawn, end: closeParen + 1 } : null;
}

/** [label](https://…) at `i`, or null when it is not a link with a safe address. */
function readLink(text: string, i: number, keyPrefix: string, opts?: InlineOptions): Found | null {
    const closeBracket = text.indexOf(']', i + 1);
    if (closeBracket === -1 || text[closeBracket + 1] !== '(') return null;
    const closeParen = text.indexOf(')', closeBracket + 2);
    if (closeParen === -1) return null;
    const label = text.slice(i + 1, closeBracket);
    const href = text.slice(closeBracket + 2, closeParen).trim();
    if (!label || !isSafeHref(href, opts?.mailto)) return null;
    const key = `${keyPrefix}-${i}`;
    const node = (
        <a
            key={key}
            href={href}
            target={href.toLowerCase().startsWith('mailto:') ? undefined : '_blank'}
            rel="noopener noreferrer"
            className="underline underline-offset-2 [color:var(--app-primary)]"
        >
            {parse(label, key, opts)}
        </a>
    );
    return { node, end: closeParen + 1 };
}

function readAt(text: string, i: number, keyPrefix: string, opts?: InlineOptions): Found | null {
    const ch = text[i];
    if (ch === '*') return readEmphasis(text, i, keyPrefix, opts);
    if (ch === '!') return readImage(text, i, keyPrefix, opts);
    if (ch === '[') return readLink(text, i, keyPrefix, opts);
    return null;
}

function parse(text: string, keyPrefix: string, opts?: InlineOptions): ReactNode[] {
    const out: ReactNode[] = [];
    let buf = '';
    let i = 0;
    while (i < text.length) {
        const found = readAt(text, i, keyPrefix, opts);
        if (found) {
            if (buf) { out.push(buf); buf = ''; }
            out.push(found.node);
            i = found.end;
        } else {
            buf += text[i];
            i += 1;
        }
    }
    if (buf) out.push(buf);
    return out;
}

/** Render a markdown-subset string to an array of React nodes. */
function renderInlineMarkdown(text: unknown, opts?: InlineOptions) {
    if (text == null) return null;
    return parse(String(text), 'md', opts);
}

export default renderInlineMarkdown;
