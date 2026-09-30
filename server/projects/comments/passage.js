// @typecheck
/**
 * What the AI reads about the passage a comment thread is anchored to: the
 * quoted words, and the section of the item they sit in (from the heading
 * above them to the next heading of the same or a higher level).
 *
 * ── Finding the quote in Markdown ───────────────────────────────────────────
 *
 * The anchor's quote is what the reader selected on screen: plain text. The
 * item is read as Markdown (the co-editing layer's fresh materialisation, the
 * notebook's Markdown mirror, or a document's HTML converted), where the same
 * words carry `**`, link brackets, list markers and line breaks. So each line
 * is reduced to its visible text, the lines are joined with single spaces,
 * and the quote is searched in that — exactly, then ignoring case. When the
 * quote occurs more than once, the occurrence whose preceding text ends with
 * the anchor's prefix wins. The block-index hint is not trusted: blocks move.
 *
 * A quote that cannot be found any more (the text was rewritten) is reported
 * as such; the AI then sees the quote on its own and is told the passage has
 * changed, rather than being handed a guess.
 *
 * ── Reading the item ────────────────────────────────────────────────────────
 *
 * `makeItemReader` loads the Markdown of a notebook or document the way its
 * owners expose it, checks again that it is filed in the thread's project,
 * and never returns HTML. Every source is injectable; the defaults are
 * required lazily so this module loads without a database.
 */

'use strict';

const log = require('../../telemetry/log');

const SECTION_CHARS = 6000;
const WHOLE_ITEM_CHARS = 6000;
const PREFIX_TAIL = 24;

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;

/**
 * One Markdown line as the reader sees it on screen.
 * @param {string} line
 */
function visibleText(line) {
    return String(line)
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, '$1')
        .replace(/[*_~`]+/g, '')
        .replace(/\|/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * The visible text of every line, joined with single spaces, and where each
 * line starts in it.
 * @param {string[]} lines
 */
function flatten(lines) {
    /** @type {number[]} */
    const starts = [];
    let text = '';
    for (const line of lines) {
        const visible = visibleText(line);
        if (visible && text) text += ' ';
        starts.push(text.length);
        text += visible;
    }
    return { text, starts };
}

/** The last line whose visible text starts at or before `offset`. */
function lineAt(starts, offset) {
    let found = 0;
    for (let i = 0; i < starts.length; i++) {
        if (starts[i] <= offset) found = i; else break;
    }
    return found;
}

/**
 * Every place `needle` occurs in `hay`.
 * @param {string} hay @param {string} needle
 */
function occurrences(hay, needle) {
    const at = [];
    if (!needle) return at;
    let i = hay.indexOf(needle);
    while (i >= 0 && at.length < 50) { at.push(i); i = hay.indexOf(needle, i + 1); }
    return at;
}

/**
 * Where the quote starts in the flattened text, or -1.
 * @param {string} text
 * @param {{ quote?: string, prefix?: string }} anchor
 */
function locateQuote(text, anchor) {
    const quote = collapse(anchor.quote);
    if (!quote) return -1;
    let hits = occurrences(text, quote);
    let hay = text;
    if (hits.length === 0) {
        hay = text.toLowerCase();
        hits = occurrences(hay, quote.toLowerCase());
    }
    if (hits.length <= 1) return hits.length ? hits[0] : -1;
    const tail = collapse(anchor.prefix).slice(-PREFIX_TAIL);
    if (!tail) return hits[0];
    const wanted = hay === text ? tail : tail.toLowerCase();
    const best = hits.find((i) => hay.slice(Math.max(0, i - wanted.length - 1), i).trimEnd().endsWith(wanted.trimEnd()));
    return best ?? hits[0];
}

/**
 * The lines of the section around line `index`: from the nearest heading
 * above it to the next heading of the same or a higher level.
 * @param {string[]} lines @param {number} index
 */
function sectionAround(lines, index) {
    let start = 0;
    let level = 7;
    let heading = '';
    for (let i = index; i >= 0; i--) {
        const m = HEADING.exec(lines[i]);
        if (m) { start = i; level = m[1].length; heading = visibleText(lines[i]); break; }
    }
    let end = lines.length;
    for (let i = Math.max(index, start) + 1; i < lines.length; i++) {
        const m = HEADING.exec(lines[i]);
        if (m && m[1].length <= level) { end = i; break; }
    }
    return { start, end, heading };
}

/**
 * At most `max` characters of `text`, kept around `focus` when it is longer.
 * @param {string} text @param {number} focus @param {number} max
 */
function windowAround(text, focus, max) {
    if (text.length <= max) return text;
    const from = Math.max(0, Math.min(text.length - max, focus - Math.floor(max / 2)));
    return `${from > 0 ? '… ' : ''}${text.slice(from, from + max)}${from + max < text.length ? ' …' : ''}`;
}

/**
 * The passage and its section in `markdown`.
 *
 * @param {string} markdown
 * @param {{ quote?: string, prefix?: string, suffix?: string }|null} anchor  null: the whole item
 * @returns {{ found: boolean, whole: boolean, quote: string, heading: string, section: string }}
 */
function findPassage(markdown, anchor) {
    const md = typeof markdown === 'string' ? markdown : '';
    if (!anchor || !collapse(anchor.quote)) {
        return { found: true, whole: true, quote: '', heading: '', section: windowAround(md.trim(), 0, WHOLE_ITEM_CHARS) };
    }
    const quote = String(anchor.quote);
    const lines = md.split(/\r?\n/);
    const flat = flatten(lines);
    const at = locateQuote(flat.text, anchor);
    if (at < 0) return { found: false, whole: false, quote, heading: '', section: '' };
    const index = lineAt(flat.starts, at);
    const { start, end, heading } = sectionAround(lines, index);
    const block = lines.slice(start, end).join('\n').trim();
    const focus = lines.slice(start, index).join('\n').length;
    return { found: true, whole: false, quote, heading, section: windowAround(block, focus, SECTION_CHARS) };
}

// ── Reading the item ──────────────────────────────────────────────────────

/**
 * The HTML of the `data-doc-section` element with this id, or ''.
 * @param {string} html @param {string} sectionId @param {() => any} domParser
 */
function sectionHtmlOf(html, sectionId, domParser) {
    if (!html || !sectionId) return '';
    try {
        const Parser = domParser();
        const doc = new Parser().parseFromString(html, 'text/html');
        for (const el of doc.querySelectorAll('[data-doc-section]')) {
            if (el.getAttribute('data-doc-section') === sectionId) return el.innerHTML;
        }
    } catch (err) {
        log.debug(`[ProjectComments] section lookup failed: ${err && err.message}`);
    }
    return '';
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.getNotebook]     (id, userId) => notebook | null
 * @param {Function} [deps.getDocument]     (id, {userId}) => document | null
 * @param {Function} [deps.htmlToMarkdown]  (html) => markdown
 * @param {Function} [deps.collab]          () => the co-editing facade, or null when it is not there
 * @param {Function} [deps.readTask]        ({projectId, taskId}) => { title, description } | null, opened with the project key
 * @param {() => any} [deps.domParser]      () => a DOMParser constructor, asked for once per reader
 */
function makeItemReader(deps = {}) {
    const getNotebook = deps.getNotebook || ((id, userId) => require('../../stores/notebookStore').getNotebook(id, userId));
    const getDocument = deps.getDocument || ((id, ctx) => require('../../stores/documentStore').getDocument(id, ctx));
    const readTask = deps.readTask || (async ({ projectId, taskId }) => {
        const task = await require('../../stores/projectTaskStore').getTask(projectId, taskId);
        const project = task ? await require('../../stores/projectStore').getProject(projectId) : null;
        if (!task || !project) return null;
        const box = await require('../chatCrypto').forProject(project, { what: 'Comments' });
        return { title: box.openTitle(task.id, task.title), description: box.openContent(task.id, task.id, task.description) };
    });
    const htmlToMarkdown = deps.htmlToMarkdown || ((html) => require('../../core/markdown').htmlToMarkdown(html));
    const collab = deps.collab || (() => {
        // @ts-ignore -- the co-editing facade ships with its own workstream; until it exists this reads the stored copy
        try { return require('../../core/collab'); } catch (_) { return null; }
    });
    // One DOMParser per reader, made on first use: a JSDOM window per read
    // would be a whole browser environment for every designed-document anchor.
    const makeParser = deps.domParser || (() => {
        const { JSDOM } = require('jsdom');
        return new JSDOM('').window.DOMParser;
    });
    let Parser = null;
    const domParser = () => Parser || (Parser = makeParser());

    /** The co-edited state when a live co-editing document exists, else null. */
    async function liveMarkdown(kind, id) {
        const facade = collab();
        if (!facade || typeof facade.isActive !== 'function' || typeof facade.readMarkdown !== 'function') return null;
        try {
            if (!(await facade.isActive(kind, id))) return null;
            const md = await facade.readMarkdown(kind, id);
            return typeof md === 'string' ? md : null;
        } catch (err) {
            log.warn(`[ProjectComments] live ${kind} text unavailable, reading the stored copy: ${err && err.message}`);
            return null;
        }
    }

    /**
     * The item as Markdown, read with `userId`'s access, only when it is
     * filed in `projectId`. Null when it is not there or not readable.
     *
     * @param {{ projectId: string, targetType: string, targetId: string, userId: string|null, sectionId?: string|null }} p
     * @returns {Promise<{ name: string, markdown: string, sectionMarkdown: string }|null>}
     */
    async function read({ projectId, targetType, targetId, userId, sectionId = null }) {
        if (!userId) return null;
        if (targetType === 'notebook') {
            const nb = await getNotebook(targetId, userId);
            if (!nb || nb.projectId !== projectId) return null;
            const live = await liveMarkdown('notebook', targetId);
            const markdown = live ?? (typeof nb.documentMd === 'string' ? nb.documentMd : htmlToMarkdown(nb.documentContent || ''));
            return { name: nb.name || '', markdown: markdown || '', sectionMarkdown: '' };
        }
        if (targetType === 'task') {
            // Anyone who may read the thread may read the task it is on: both are the project's.
            const task = await readTask({ projectId, taskId: targetId });
            return task ? { name: task.title, markdown: `# ${task.title}\n\n${task.description}`.trim(), sectionMarkdown: '' } : null;
        }
        if (targetType === 'document') {
            const doc = await getDocument(targetId, { userId });
            if (!doc || doc.projectId !== projectId) return null;
            const live = await liveMarkdown('document', targetId);
            const markdown = live ?? htmlToMarkdown(doc.bodyHtml || '');
            const sectionHtml = live === null && sectionId ? sectionHtmlOf(doc.bodyHtml || '', sectionId, domParser) : '';
            return { name: doc.name || '', markdown: markdown || '', sectionMarkdown: sectionHtml ? htmlToMarkdown(sectionHtml) : '' };
        }
        return null;
    }

    return { read };
}

module.exports = {
    SECTION_CHARS,
    visibleText,
    findPassage,
    sectionHtmlOf,
    makeItemReader,
};
