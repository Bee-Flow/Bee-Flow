// @typecheck strict
/**
 * The line parser of the deck grammar: the lines of ONE slide become its
 * fields. Each kind of line is one step that says whether the line was its
 * own; LINE_STEPS is their order, and the order is part of the grammar (a
 * fence swallows everything, notes swallow everything but a fence that was
 * already open, a comment is read before a heading, a table before prose).
 */

'use strict';

const { chartType } = require('./deckChart');
const { RE_ICON_TAG, stripInlineMarkdown, classifyImageRef } = require('./deckBase');

const RE_BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const RE_H3 = /^###\s+(.*)$/;
const RE_QUOTE = /^>\s?(.*)$/;
const RE_TABLE_ROW = /^\s*\|.*\|\s*$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RE_IMAGE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const RE_NOTES_PARA = /^(?:speaker\s+notes|notes|notities|sprekersnotities)\s*:\s*(.*)$/i;
const RE_COMMENT_ONE = /^\s*<!--\s*(layout|notes|chart|style)\s*:\s*([\s\S]*?)\s*-->\s*$/i;
const RE_COMMENT_OPEN = /^\s*<!--\s*(notes)\s*:\s*([\s\S]*)$/i;
const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([a-zA-Z0-9_-]*)\s*$/;

/**
 * @typedef {{ text: string, level?: number }} Bullet
 * @typedef {NonNullable<ReturnType<typeof classifyImageRef>>} ImageRef
 * @typedef {{ title: string, bullets: Bullet[], body: string[], icon?: string | null, image?: ImageRef | null }} Column
 * @typedef {{ lines: string[], attribution: string | null }} Quote
 * @typedef {{ columns: string[], rows: unknown[][] }} Table
 * @typedef {{ bullets: Bullet[], body: string[], table: Table | null, quote: Quote | null, image: ImageRef | null, notes: string[], layoutHint: string | null,
 *   columns: Column[], warnings: string[], chartText: string | null, chartHint: string | null, statsText: string | null, styleHint: string | null }} SlideFields
 * @typedef {{ marker: string, lang: string, lines: string[] }} Fence
 * @typedef {{ f: SlideFields, target: SlideFields | Column, noteMode: boolean, commentNotes: string[] | null, fence: Fence | null, lines: string[], i: number }} ParseState
 *   `target` is where bullets and prose go (the slide or the current ### block), `noteMode` a trailing "Notes:" paragraph
 *   that swallows the rest, `commentNotes` an open multi-line notes comment, `i` the next line to read.
 */

/** @returns {SlideFields} */
function emptyFields() {
    return {
        bullets: [], body: [], table: null, quote: null, image: null, notes: [], layoutHint: null, columns: [], warnings: [],
        chartText: null, chartHint: null, statsText: null, styleHint: null,
    };
}

/** @param {string} line */
function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
}

/** @param {string | undefined} line */
const isTableRow = (line) => line !== undefined && RE_TABLE_ROW.test(line);

/** @param {string | undefined} line */
const isTableSeparator = (line) => line !== undefined && RE_TABLE_SEP.test(line);

/** @param {string} lang */
const isStatsLang = (lang) => lang === 'stats' || lang === 'kpi';

/** @param {Fence} fence */
const fenceProse = (fence) => fence.lines.map((l) => l.trim());

/**
 * A closed fence: a chart block and a stats block are visuals (one of each per slide),
 * any other language is prose the slide prints as-is.
 * @param {ParseState} st
 * @param {Fence} fence
 */
function closeFence(st, fence) {
    const { f } = st;
    const text = fence.lines.join('\n');
    if (fence.lang === 'chart') {
        if (f.chartText === null) f.chartText = text;
        else f.warnings.push('a slide can hold one chart; the extra chart was skipped');
    } else if (isStatsLang(fence.lang)) {
        if (f.statsText === null) f.statsText = text;
        else f.warnings.push('a slide can hold one row of KPI tiles; the extra one was skipped');
    } else {
        st.target.body.push(...fenceProse(fence));
    }
}

/**
 * A fence still open at the end of the slide keeps what it held; a second
 * chart or row of tiles is then prose.
 * @param {ParseState} st
 */
function closeOpenFence(st) {
    const { f, fence } = st;
    if (!fence) return;
    const text = fence.lines.join('\n');
    if (fence.lang === 'chart' && f.chartText === null) f.chartText = text;
    else if (isStatsLang(fence.lang) && f.statsText === null) f.statsText = text;
    else st.target.body.push(...fenceProse(fence));
}

/** @typedef {(st: ParseState, line: string) => boolean} LineStep  true when the line was this step's */

/** @type {LineStep} */
function fenceBodyLine(st, line) {
    const { fence } = st;
    if (!fence) return false;
    const close = RE_FENCE.exec(line);
    if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length && !close[2]) {
        closeFence(st, fence);
        st.fence = null;
    } else {
        fence.lines.push(line);
    }
    return true;
}

/** @type {LineStep} */
function fenceOpenLine(st, line) {
    if (st.commentNotes !== null || st.noteMode) return false;
    const m = RE_FENCE.exec(line);
    if (!m) return false;
    st.fence = { marker: m[1], lang: m[2].toLowerCase(), lines: [] };
    return true;
}

/** @type {LineStep} */
function commentNotesLine(st, line) {
    const notes = st.commentNotes;
    if (notes === null) return false;
    const end = line.indexOf('-->');
    if (end === -1) { notes.push(line); return true; }
    notes.push(line.slice(0, end));
    st.f.notes.push(notes.join('\n').trim());
    st.commentNotes = null;
    return true;
}

/** @type {LineStep} */
function noteModeLine(st, line) {
    if (!st.noteMode) return false;
    st.f.notes.push(line);
    return true;
}

/** What a one-line `<!-- kind: value -->` comment sets. @type {Record<string, (f: SlideFields, val: string) => void>} */
const COMMENT_KINDS = {
    layout: (f, val) => { f.layoutHint = val.toLowerCase().replace(/-/g, '_'); },
    chart: (f, val) => { f.chartHint = chartType(val, 'column'); },
    style: (f, val) => { f.styleHint = val.toLowerCase(); },
    notes: (f, val) => { f.notes.push(val); },
};

/** @type {LineStep} */
function commentLine(st, line) {
    const m = RE_COMMENT_ONE.exec(line);
    if (!m) return false;
    COMMENT_KINDS[m[1].toLowerCase()](st.f, m[2].trim());
    return true;
}

/** @type {LineStep} */
function commentOpenLine(st, line) {
    const m = RE_COMMENT_OPEN.exec(line);
    if (!m) return false;
    st.commentNotes = [m[2]];
    return true;
}

/** A blank line separates paragraphs, once. @type {LineStep} */
function blankLine(st, line) {
    if (line.trim()) return false;
    const { body } = st.target;
    if (body.length && body[body.length - 1] !== '') body.push('');
    return true;
}

/** @type {LineStep} */
function notesParagraphLine(st, line) {
    const m = RE_NOTES_PARA.exec(line.trim());
    if (!m) return false;
    st.noteMode = true;
    if (m[1]) st.f.notes.push(m[1]);
    return true;
}

/** `### Heading {icon: name}` opens a column. @type {LineStep} */
function columnHeadingLine(st, line) {
    const m = RE_H3.exec(line);
    if (!m) return false;
    const iconTag = RE_ICON_TAG.exec(m[1]);
    /** @type {Column} */
    const col = { title: stripInlineMarkdown(iconTag ? m[1].replace(RE_ICON_TAG, '') : m[1]), bullets: [], body: [], icon: iconTag ? iconTag[1].trim() : null, image: null };
    st.f.columns.push(col);
    st.target = col;
    return true;
}

/** @type {LineStep} */
function imageLine(st, line) {
    const m = RE_IMAGE.exec(line);
    if (!m) return false;
    const { f, target } = st;
    const ref = classifyImageRef(m[2], m[1]);
    if (!ref) return true;
    if (ref.rejected) f.warnings.push(`remote image "${ref.rejected.slice(0, 80)}" was skipped — only Bee Flow storage or data: images can be placed on a slide`);
    else if (target !== f && !target.image) target.image = ref; // a picture inside a ### block belongs to that card
    else if (!f.image) f.image = ref;
    else f.warnings.push('a slide can hold one image; the extra image was skipped');
    return true;
}

/** @type {LineStep} */
function bulletLine(st, line) {
    const m = RE_BULLET.exec(line);
    if (!m) return false;
    const indent = m[1].replace(/\t/g, '  ').length;
    st.target.bullets.push({ text: stripInlineMarkdown(m[2]), level: indent >= 2 ? 1 : 0 });
    return true;
}

/** @type {LineStep} */
function quoteLine(st, line) {
    const m = RE_QUOTE.exec(line);
    if (!m) return false;
    const q = st.f.quote || { lines: [], attribution: null };
    const text = m[1].trim();
    const attr = /^(?:—|--|–)\s*(.+)$/.exec(text);
    if (attr) q.attribution = stripInlineMarkdown(attr[1]);
    else if (text) q.lines.push(stripInlineMarkdown(text));
    st.f.quote = q;
    return true;
}

/** A header row, its separator and the rows under it. @type {LineStep} */
function tableLines(st, line) {
    const { f, lines } = st;
    if (!(isTableRow(line) && isTableSeparator(lines[st.i]))) return false;
    const header = splitTableRow(line).map(stripInlineMarkdown);
    st.i += 1; // the separator
    const rows = [];
    while (isTableRow(lines[st.i])) {
        rows.push(splitTableRow(lines[st.i]).map(stripInlineMarkdown));
        st.i += 1;
    }
    if (!f.table) f.table = { columns: header, rows };
    else f.warnings.push('a slide can hold one table; the extra table was skipped');
    return true;
}

/** @type {LineStep} */
function proseLine(st, line) {
    st.target.body.push(line.trim());
    return true;
}

/** @type {LineStep[]} */
const LINE_STEPS = [
    fenceBodyLine, fenceOpenLine, commentNotesLine, noteModeLine, commentLine, commentOpenLine, blankLine,
    notesParagraphLine, columnHeadingLine, imageLine, bulletLine, quoteLine, tableLines, proseLine,
];

/**
 * Parse the lines of one slide's content. `###` headings open a column; when
 * exactly two columns end up with content the slide is two-column, otherwise
 * the column headings are folded back in as bullets.
 * @param {string[]} lines
 */
function parseSlideLines(lines) {
    const f = emptyFields();
    /** @type {ParseState} */
    const st = { f, target: f, noteMode: false, commentNotes: null, fence: null, lines, i: 0 };
    while (st.i < lines.length) {
        const line = lines[st.i];
        st.i += 1;
        LINE_STEPS.some((step) => step(st, line));
    }
    closeOpenFence(st);
    return f;
}

module.exports = { parseSlideLines };
