/**
 * The read side of the chat's notebook tools (integrations/workspaceTools.js
 * notebook_read): a Markdown notebook read as an outline, one section, the
 * paragraphs matching a search, or in full, so the model loads only what it
 * needs. Pure functions over the Markdown text; who may read it, and which
 * text is current, is decided by the caller.
 */

'use strict';

/**
 * Count words in text.
 */
function wordCount(text) {
    return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Parse a Markdown document into sections based on headings.
 * Returns an array of { heading, level, startLine, endLine, content, words }.
 */
function parseSections(content) {
    const lines = content.split('\n');
    const sections = [];
    let currentSection = null;

    for (let i = 0; i < lines.length; i++) {
        const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);

        if (headingMatch) {
            // Close previous section
            if (currentSection) {
                currentSection.endLine = i - 1;
                currentSection.content = lines.slice(currentSection.startLine, i).join('\n');
                currentSection.words = wordCount(currentSection.content);
                sections.push(currentSection);
            }
            currentSection = {
                heading: headingMatch[2].trim(),
                level: headingMatch[1].length,
                startLine: i,
                endLine: i,
                content: '',
                words: 0
            };
        } else if (!currentSection && lines[i].trim()) {
            // Content before any heading — treat as preamble
            currentSection = {
                heading: '(Document Start)',
                level: 0,
                startLine: 0,
                endLine: 0,
                content: '',
                words: 0
            };
        }
    }

    // Close last section
    if (currentSection) {
        currentSection.endLine = lines.length - 1;
        currentSection.content = lines.slice(currentSection.startLine, lines.length).join('\n');
        currentSection.words = wordCount(currentSection.content);
        sections.push(currentSection);
    }

    return sections;
}

/**
 * Build an outline string from sections.
 */
function buildOutline(content, sections) {
    const totalWords = wordCount(content);
    const totalLines = content.split('\n').length;

    let outline = `Document: ${totalWords} words, ${totalLines} lines\n\n## Sections\n`;

    if (sections.length === 0) {
        outline += '(No headings found — document is unstructured)\n';
        // Show a preview for small documents
        if (totalWords <= 100) {
            outline += `\nFull content:\n${content}`;
        } else {
            outline += `\nPreview (first 200 chars): ${content.substring(0, 200)}...\n`;
        }
    } else {
        for (let i = 0; i < sections.length; i++) {
            const s = sections[i];
            const indent = '  '.repeat(Math.max(0, s.level - 1));
            const prefix = '#'.repeat(s.level || 1);
            outline += `${i + 1}. ${indent}${prefix} ${s.heading} (L${s.startLine + 1}-L${s.endLine + 1}, ${s.words} words)\n`;
        }
    }

    outline += `\nUse notebook_read with mode="section" and section_heading="<heading>" to read a specific section.`;
    outline += `\nUse notebook_read with mode="search" and query="<text>" to find specific content.`;

    return outline;
}

/**
 * One notebook_read answer for `content` (not empty), by `args.mode`:
 * outline (the default), section, search or full.
 *
 * @param {string} content
 * @param {{ mode?: string, section_heading?: string, query?: string }} args
 */
function readNotebookContent(content, args) {
    const mode = args.mode || 'outline';

    // MODE: full — return everything (legacy behavior)
    if (mode === 'full') {
        return { content };
    }

    const sections = parseSections(content);

    // MODE: outline — return headings + word counts + line ranges
    if (mode === 'outline') {
        const outline = buildOutline(content, sections);
        // For very short documents (< 300 words), just return full content
        // since the outline would be about the same size
        if (wordCount(content) < 300) {
            return { content, message: `(Short document — returning full content: ${wordCount(content)} words)` };
        }
        return { outline, total_words: wordCount(content), total_lines: content.split('\n').length };
    }

    // MODE: section — return a specific section by heading
    if (mode === 'section') {
        const heading = args.section_heading;
        if (!heading) {
            return { error: 'section_heading is required when mode is "section". Use mode="outline" first to see available sections.' };
        }

        const headingLower = heading.toLowerCase().trim();
        const match = sections.find(s =>
            s.heading.toLowerCase().includes(headingLower) ||
            headingLower.includes(s.heading.toLowerCase())
        );

        if (!match) {
            // Return available headings to help the AI
            const available = sections.map(s => s.heading).join(', ');
            return { error: `Section "${heading}" not found. Available sections: ${available}` };
        }

        return {
            section: match.heading,
            content: match.content,
            line_range: `L${match.startLine + 1}-L${match.endLine + 1}`,
            words: match.words
        };
    }

    // MODE: search — find matching paragraphs
    if (mode === 'search') {
        const query = args.query;
        if (!query) {
            return { error: 'query is required when mode is "search".' };
        }

        const queryLower = query.toLowerCase();
        const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);
        const lines = content.split('\n');
        const matches = [];
        const CONTEXT_LINES = 2;

        for (let i = 0; i < lines.length; i++) {
            const lineLower = lines[i].toLowerCase();
            // Match if line contains the full query OR most of the query terms
            const fullMatch = lineLower.includes(queryLower);
            const termHits = queryTerms.filter(t => lineLower.includes(t)).length;
            const termMatch = queryTerms.length > 0 && termHits >= Math.ceil(queryTerms.length * 0.6);

            if (fullMatch || termMatch) {
                // Get surrounding context
                const start = Math.max(0, i - CONTEXT_LINES);
                const end = Math.min(lines.length - 1, i + CONTEXT_LINES);
                const contextBlock = lines.slice(start, end + 1).join('\n');

                // Avoid duplicates (overlapping context)
                const alreadyCovered = matches.some(m => i >= m._start && i <= m._end);
                if (!alreadyCovered) {
                    matches.push({
                        line: i + 1,
                        context: contextBlock,
                        _start: start,
                        _end: end
                    });
                }
            }
        }

        if (matches.length === 0) {
            return { message: `No matches found for "${query}". Try different keywords or use mode="outline" to see the document structure.` };
        }

        // Limit to 5 matches to keep token count low
        const limited = matches.slice(0, 5);
        return {
            matches: limited.map(({ _start, _end, ...m }) => m),
            total_matches: matches.length,
            message: matches.length > 5 ? `Showing 5 of ${matches.length} matches. Refine your query for fewer results.` : undefined
        };
    }

    return { error: `Unknown read mode: "${mode}". Use "outline", "section", "search", or "full".` };
}

module.exports = { wordCount, parseSections, buildOutline, readNotebookContent };
