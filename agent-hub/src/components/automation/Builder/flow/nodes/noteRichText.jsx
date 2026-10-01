import React from 'react';

/**
 * The note node's display formatting (BFSF-479): a deliberately tiny subset —
 * **bold**, *italic*, `- ` bullet lines and `1. ` numbered lines. The editor
 * stays a plain textarea (the author types the markers); this renderer is
 * what turns them into styled text once the note is committed.
 *
 * Same idiom as the App Studio runtime's markdownInline.jsx: a character
 * scanner, no regex, no dangerouslySetInnerHTML — everything it emits is a
 * React element or an escaped-by-construction string.
 */

/** One line → an array of strings / <strong> / <em> elements. */
function parseInline(text, keyPrefix) {
    const out = [];
    let buf = '';
    let i = 0;
    const flush = () => {
        if (buf) { out.push(buf); buf = ''; }
    };
    while (i < text.length) {
        if (text[i] === '*') {
            const bold = text[i + 1] === '*';
            const marker = bold ? '**' : '*';
            const close = text.indexOf(marker, i + marker.length);
            const inner = close === -1 ? '' : text.slice(i + marker.length, close);
            if (inner.trim()) {
                flush();
                const key = `${keyPrefix}-${i}`;
                out.push(bold ? <strong key={key}>{inner}</strong> : <em key={key}>{inner}</em>);
                i = close + marker.length;
                continue;
            }
        }
        buf += text[i];
        i += 1;
    }
    flush();
    return out;
}

const BULLET = /^\s*[-•] +(.*)$/;
const NUMBERED = /^\s*\d+[.)] +(.*)$/;

/**
 * Whole note text → block elements. Consecutive bullet (or numbered) lines
 * fold into one list; everything else is a paragraph per line. Empty lines
 * keep their vertical space so the note's rhythm matches what was typed.
 */
export function renderNoteText(text) {
    const lines = String(text || '').split('\n');
    const blocks = [];
    let list = null; // { kind: 'ul'|'ol', items: [] }
    const flushList = () => {
        if (list) { blocks.push(list); list = null; }
    };
    for (const line of lines) {
        const bullet = line.match(BULLET);
        const numbered = line.match(NUMBERED);
        if (bullet || numbered) {
            const kind = bullet ? 'ul' : 'ol';
            if (!list || list.kind !== kind) flushList();
            if (!list) list = { kind, items: [] };
            list.items.push((bullet || numbered)[1]);
            continue;
        }
        flushList();
        blocks.push({ kind: 'p', text: line });
    }
    flushList();

    return blocks.map((block, bi) => {
        if (block.kind === 'p') {
            return (
                <div key={bi} className={block.text ? '' : 'h-[1em]'}>
                    {parseInline(block.text, `p${bi}`)}
                </div>
            );
        }
        const ListTag = block.kind;
        return (
            <ListTag key={bi} className={block.kind === 'ul' ? 'list-disc' : 'list-decimal'} style={{ paddingInlineStart: '1.2em' }}>
                {block.items.map((item, ii) => <li key={ii}>{parseInline(item, `l${bi}-${ii}`)}</li>)}
            </ListTag>
        );
    });
}
