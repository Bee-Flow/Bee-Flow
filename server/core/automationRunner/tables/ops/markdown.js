'use strict';
/** A small table as markdown: header labels, then one line per row. */

const DEFAULT_MAX_CELL_CHARS = 200;

function cellText(v, max) {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'string' ? v : String(v);
    s = s.replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * @param {{ key: string, label?: string }[]} columns
 * @param {Iterable<Record<string, unknown>>} rows
 * @param {{ maxCellChars?: number }} [opts]
 */
function toMarkdown(columns, rows, opts = {}) {
    const max = opts.maxCellChars > 0 ? opts.maxCellChars : DEFAULT_MAX_CELL_CHARS;
    if (!columns.length) return '';
    const line = (cells) => `| ${cells.join(' | ')} |`;
    const out = [line(columns.map((c) => cellText(c.label ?? c.key, max))), line(columns.map(() => '---'))];
    for (const row of rows) out.push(line(columns.map((c) => cellText(row[c.key], max))));
    return out.join('\n');
}

module.exports = { toMarkdown };
