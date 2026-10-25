// @typecheck noImplicitAny
/**
 * The text edits behind notebook_insert and notebook_replace, as pure functions
 * of the current Markdown: no I/O, so the matching strategies can be read and
 * tested on their own. Each answers { newContent } or { error } (the error is
 * what the tool hands back to the model).
 */

const log = require('../telemetry/log');

/**
 * Where `insertContent` goes: the start, the end, or after the text `afterText` (exact, then whitespace-normalised, else appended).
 * @param {string} currentContent
 * @param {{ position?: string, afterText?: string, insertContent?: string }} edit
 */
function insertIntoContent(currentContent, { position, afterText, insertContent }) {
    /** @type {string} */
    let newContent;

    if (position === 'start') {
        newContent = insertContent + '\n\n' + currentContent;
    } else if (position === 'end') {
        newContent = currentContent + (currentContent.trim() ? '\n\n' : '') + insertContent;
    } else if (position === 'after') {
        if (!afterText) {
            return { error: 'after_text is required when position is "after".' };
        }
        // Try exact match first
        if (currentContent.includes(afterText)) {
            const idx = currentContent.indexOf(afterText) + afterText.length;
            newContent = currentContent.slice(0, idx) + '\n\n' + insertContent + currentContent.slice(idx);
        } else {
            // Try whitespace-normalized match
            const normalizeWs = (/** @type {string} */ t) => t.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
            const afterNorm = normalizeWs(afterText);
            const lines = currentContent.split('\n');
            let matchEnd = -1;

            for (let i = 0; i < lines.length; i++) {
                if (normalizeWs(lines[i]).includes(afterNorm) || afterNorm.includes(normalizeWs(lines[i]))) {
                    matchEnd = i;
                    break;
                }
            }

            if (matchEnd !== -1) {
                const before = lines.slice(0, matchEnd + 1).join('\n');
                const after = lines.slice(matchEnd + 1).join('\n');
                newContent = before + '\n\n' + insertContent + (after ? '\n' + after : '');
            } else {
                // Fallback: append at end
                newContent = currentContent + '\n\n' + insertContent;
            }
        }
    } else {
        return { error: `Invalid position: ${position}. Use "start", "end", or "after".` };
    }

    return { newContent };
}

/**
 * Replace `findText` (exact, then whitespace-normalised, then Markdown-stripped match), optionally narrowed to a section.
 * @param {string} currentContent
 * @param {{ findText?: string, replaceText?: string, sectionHeading?: string }} edit
 */
function replaceInContent(currentContent, { findText, replaceText, sectionHeading }) {
    const { parseSections } = require('./notebookReadModes');
    let searchContent = currentContent;

    // If section_heading is specified, narrow the search scope
    if (sectionHeading) {
        const sections = parseSections(currentContent);
        const headingLower = sectionHeading.toLowerCase().trim();
        const section = sections.find(s =>
            s.heading.toLowerCase().includes(headingLower) ||
            headingLower.includes(s.heading.toLowerCase())
        );
        if (section) {
            searchContent = section.content;
        }
    }

    /** @type {string} */
    let newContent;

    // Strategy 1: Exact match
    if (searchContent.includes(findText)) {
        // Apply to full content (even if we narrowed search scope)
        if (currentContent.includes(findText)) {
            newContent = currentContent.replace(findText, replaceText);
        } else {
            newContent = currentContent;
        }
    } else {
        // Strategy 2: Whitespace-normalized match
        /**
         * @param {string} t
         */
        const normalizeWs = (t) => t.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
        const findNorm = normalizeWs(findText);

        const lines = currentContent.split('\n');
        let wsMatchStart = -1, wsMatchEnd = -1;
        const findNormLines = findNorm.split('\n').map(l => l.trim()).filter(Boolean);

        if (findNormLines.length > 0) {
            for (let i = 0; i < lines.length; i++) {
                const lineNorm = normalizeWs(lines[i]);
                if (lineNorm === findNormLines[0] || lineNorm.includes(findNormLines[0]) || findNormLines[0].includes(lineNorm)) {
                    wsMatchStart = i;
                    wsMatchEnd = i;
                    let fi = 1;
                    for (let j = i + 1; j < lines.length && fi < findNormLines.length; j++) {
                        const ls = normalizeWs(lines[j]);
                        if (!ls) { wsMatchEnd = j; continue; }
                        if (ls === findNormLines[fi] || ls.includes(findNormLines[fi]) || findNormLines[fi].includes(ls)) {
                            wsMatchEnd = j;
                            fi++;
                        }
                    }
                    if (fi >= findNormLines.length) break;
                    wsMatchStart = -1;
                }
            }
        }

        if (wsMatchStart !== -1) {
            const before = lines.slice(0, wsMatchStart).join('\n');
            const after = lines.slice(wsMatchEnd + 1).join('\n');
            newContent = [before, replaceText, after].filter(p => p !== '').join('\n');
        } else {
            // Strategy 3: Strip-markdown matching
            /**
             * @param {string} t
             */
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

            const findStripped = stripMd(findText).trim();
            let mdMatchStart = -1, mdMatchEnd = -1;
            const findMdLines = findStripped.split('\n').map(l => l.trim()).filter(Boolean);

            if (findMdLines.length > 0) {
                for (let i = 0; i < lines.length; i++) {
                    const lineStripped = stripMd(lines[i]).trim();
                    if (lineStripped && (lineStripped.includes(findMdLines[0]) || findMdLines[0].includes(lineStripped))) {
                        mdMatchStart = i;
                        mdMatchEnd = i;
                        let fi = 1;
                        for (let j = i + 1; j < lines.length && fi < findMdLines.length; j++) {
                            const ls = stripMd(lines[j]).trim();
                            if (!ls) { mdMatchEnd = j; continue; }
                            if (ls.includes(findMdLines[fi]) || findMdLines[fi].includes(ls)) {
                                mdMatchEnd = j;
                                fi++;
                            }
                        }
                        if (fi >= findMdLines.length) break;
                        mdMatchStart = -1;
                    }
                }
            }

            if (mdMatchStart !== -1) {
                const before = lines.slice(0, mdMatchStart).join('\n');
                const after = lines.slice(mdMatchEnd + 1).join('\n');
                newContent = [before, replaceText, after].filter(p => p !== '').join('\n');
            } else {
                log.warn('[NotebookTool] Replace match failed. find_text:', JSON.stringify(findText.substring(0, 200)));
                log.warn('[NotebookTool] Current content starts with:', JSON.stringify(currentContent.substring(0, 200)));
                return { error: `Could not find the specified text in the notebook. Try using notebook_read with mode="search" to find the exact text, then retry.` };
            }
        }
    }

    return { newContent };
}

module.exports = { insertIntoContent, replaceInContent };
