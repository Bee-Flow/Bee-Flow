// @typecheck strict
/**
 * The text edits behind notebook_insert and notebook_replace, as pure functions
 * of the current Markdown: no I/O, so the matching strategies can be read and
 * tested on their own. Each answers { newContent } or { error } (the error is
 * what the tool hands back to the model).
 */

const log = require('../telemetry/log');

/** A line may stand in for a longer find text only when it is at least this share of it. */
const MIN_REVERSE_SHARE = 0.8;

/** @param {string} t */
const normalizeWs = (t) => t.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

/** @param {string} t */
const stripMd = (t) => t
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

/**
 * Does a normalised notebook line stand for the normalised find text? Never for an empty line (it is
 * "inside" every string); a line that is only a fragment of the find text counts only when it is most of it.
 * @param {string} line
 * @param {string} find
 */
function lineMatches(line, find) {
    if (!line || !find) return false;
    if (line.includes(find)) return true;
    return find.includes(line) && line.length >= find.length * MIN_REVERSE_SHARE;
}

/**
 * First run of lines whose normalised form matches the lines of the find text in order (blank lines between are skipped).
 * @param {string[]} lines
 * @param {string[]} findLines
 * @param {(line: string) => string} norm
 * @returns {{ start: number, end: number } | null}
 */
function findLineRun(lines, findLines, norm) {
    if (findLines.length === 0) return null;
    for (let i = 0; i < lines.length; i++) {
        if (!lineMatches(norm(lines[i]), findLines[0])) continue;
        let end = i;
        let fi = 1;
        for (let j = i + 1; j < lines.length && fi < findLines.length; j++) {
            const ls = norm(lines[j]);
            if (!ls) { end = j; continue; }
            if (lineMatches(ls, findLines[fi])) { end = j; fi++; }
        }
        if (fi >= findLines.length) return { start: i, end };
    }
    return null;
}

/** @param {string} t @param {(s: string) => string} norm */
const toNormLines = (t, norm) => norm(t).split('\n').map(l => l.trim()).filter(Boolean);

const NOT_FOUND = 'Could not find the specified text in the notebook. Nothing was changed. Use notebook_read (mode="search" or the full notebook) to see the current text, then retry with find_text copied exactly from it.';

/**
 * Where `insertContent` goes: the start, the end, or after the text `afterText` (exact, then whitespace-normalised, else an error).
 * @param {string} currentContent
 * @param {{ position?: string, afterText?: string, insertContent?: string }} edit
 */
function insertIntoContent(currentContent, { position, afterText, insertContent }) {
    if (position === 'start') return { newContent: insertContent + '\n\n' + currentContent };
    if (position === 'end') return { newContent: currentContent + (currentContent.trim() ? '\n\n' : '') + insertContent };
    if (position !== 'after') return { error: `Invalid position: ${position}. Use "start", "end", or "after".` };
    if (!afterText) return { error: 'after_text is required when position is "after".' };

    const exactAt = currentContent.indexOf(afterText);
    if (exactAt !== -1) {
        const idx = exactAt + afterText.length;
        return { newContent: currentContent.slice(0, idx) + '\n\n' + insertContent + currentContent.slice(idx) };
    }
    const afterNorm = normalizeWs(afterText);
    const lines = currentContent.split('\n');
    const matchEnd = lines.findIndex(l => lineMatches(normalizeWs(l), afterNorm));
    if (matchEnd === -1) {
        return { error: NOT_FOUND.replace('find_text', 'after_text') };
    }
    const before = lines.slice(0, matchEnd + 1).join('\n');
    const after = lines.slice(matchEnd + 1).join('\n');
    return { newContent: before + '\n\n' + insertContent + (after ? '\n' + after : '') };
}

/**
 * The text `searchContent` is narrowed to by a section heading, or the whole notebook.
 * @param {string} currentContent
 * @param {string | undefined} sectionHeading
 */
function narrowToSection(currentContent, sectionHeading) {
    if (!sectionHeading) return currentContent;
    const { parseSections } = require('./notebookReadModes');
    const headingLower = sectionHeading.toLowerCase().trim();
    const section = parseSections(currentContent).find((/** @type {{ heading: string }} */ s) =>
        s.heading.toLowerCase().includes(headingLower) ||
        headingLower.includes(s.heading.toLowerCase())
    );
    return section ? section.content : currentContent;
}

/**
 * Replace lines start..end of `lines` by `replaceText`.
 * @param {string[]} lines
 * @param {{ start: number, end: number }} run
 * @param {string} replaceText
 */
function spliceLines(lines, run, replaceText) {
    const before = lines.slice(0, run.start).join('\n');
    const after = lines.slice(run.end + 1).join('\n');
    return [before, replaceText, after].filter(p => p !== '').join('\n');
}

/**
 * Replace `findText` (exact, then whitespace-normalised, then Markdown-stripped match), optionally narrowed to a section.
 * No match is an error, never an edit elsewhere.
 * @param {string} currentContent
 * @param {{ findText?: string, replaceText?: string, sectionHeading?: string }} edit
 */
function replaceInContent(currentContent, { findText, replaceText, sectionHeading }) {
    const find = findText || '';
    const replacement = replaceText || '';
    const searchContent = narrowToSection(currentContent, sectionHeading);

    // Strategy 1: exact match, applied to the full content, spliced by index so `$&` stays literal
    if (find && searchContent.includes(find)) {
        const at = currentContent.indexOf(find);
        if (at === -1) return { newContent: currentContent };
        return { newContent: currentContent.slice(0, at) + replacement + currentContent.slice(at + find.length) };
    }

    const lines = currentContent.split('\n');
    // Strategy 2: whitespace-normalised, Strategy 3: Markdown-stripped
    const run = findLineRun(lines, toNormLines(find, normalizeWs), normalizeWs)
        || findLineRun(lines, toNormLines(stripMd(find), (t) => t.trim()), (t) => stripMd(t).trim());
    if (run) return { newContent: spliceLines(lines, run, replacement) };

    log.warn(`[NotebookTool] Replace match failed: find_text ${find.length} chars, notebook ${currentContent.length} chars`);
    return { error: NOT_FOUND };
}

module.exports = { insertIntoContent, replaceInContent };
