/**
 * Notebook Tools (formerly Workspace Tools)
 * Provides notebook_read, notebook_write, notebook_replace, notebook_insert,
 * and notebook_search tools for AI agents.
 * These operate on the rich-text notebook panel that appears alongside the chat.
 * Content is stored as Markdown in the database; the TipTap editor renders it as rich text.
 *
 * Token optimization (2026-04):
 * - notebook_read supports outline/section/search/full modes to avoid returning entire docs
 * - Write/replace/insert return compact confirmations to the LLM; full content goes via SSE only
 */
const log = require('../telemetry/log');

const WORKSPACE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'notebook_read',
            description: `Read notebook content. Supports 4 modes:
- "outline" (default): Returns section headings + word counts + line ranges. Use this FIRST to understand the document structure before making edits.
- "section": Returns content of a specific section by heading. Use after outline to load only what you need.
- "search": Search for text/keywords and return matching paragraphs with context. Use to find specific content without loading everything.
- "full": Returns the entire document. Only use for very short documents or when you truly need everything.
ALWAYS prefer outline → section over full reads to save tokens.`,
            parameters: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['outline', 'section', 'full', 'search'],
                        description: 'Read mode. Default: "outline".'
                    },
                    section_heading: {
                        type: 'string',
                        description: 'When mode is "section", the heading text to find (e.g. "Part Two", "Introduction"). Case-insensitive partial match.'
                    },
                    query: {
                        type: 'string',
                        description: 'When mode is "search", the text or keywords to search for.'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'notebook_write',
            description: 'Write or replace the ENTIRE content of the notebook panel. Only call this when the user has EXPLICITLY asked for output to go into the notebook (e.g. "save this to my notebook", "schrijf dit in het notebook"). Do NOT call for generic write/draft/summarise requests — reply in chat instead. Content must be the full Markdown document; never call with empty or placeholder content. WARNING: This replaces ALL existing content. For partial edits use notebook_replace; to add content use notebook_insert.',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'The full Markdown content to write. Replaces everything.'
                    },
                    title: {
                        type: 'string',
                        description: 'Optional short title (e.g. "Project Plan", "Meeting Notes").'
                    }
                },
                required: ['content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'notebook_replace',
            description: 'Replace a specific portion of the notebook content. Use notebook_read with mode="search" or mode="section" first to find the exact text, then copy find_text character-for-character from that output. Prefer this over notebook_write for any partial edit — it preserves everything else.',
            parameters: {
                type: 'object',
                properties: {
                    find_text: {
                        type: 'string',
                        description: 'The exact Markdown text to find and replace. Must match existing content.'
                    },
                    replace_text: {
                        type: 'string',
                        description: 'The new Markdown text. Set to empty string to delete.'
                    },
                    section_heading: {
                        type: 'string',
                        description: 'Optional: limit search to this section only. Helps when the same phrase appears multiple times.'
                    }
                },
                required: ['find_text', 'replace_text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'notebook_insert',
            description: 'Insert content at a specific position without replacing existing content. Preferred over notebook_write when adding new sections.',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'The Markdown content to insert.'
                    },
                    position: {
                        type: 'string',
                        enum: ['start', 'end', 'after'],
                        description: 'Where to insert: "start", "end", or "after" (after text specified in after_text).'
                    },
                    after_text: {
                        type: 'string',
                        description: 'When position is "after", the text to insert after. Must match existing content (e.g. a heading like "## Section Title").'
                    }
                },
                required: ['content', 'position']
            }
        }
    }
];

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Tool execution ─────────────────────────────────────────────────────────

/**
 * Execute a notebook tool call.
 */
async function executeWorkspaceTool(toolName, args, context) {
    const { conversationId, userId: callerUserId } = context;

    // Normalize legacy tool names
    const normalizedName = toolName
        .replace('workspace_read', 'notebook_read')
        .replace('workspace_write', 'notebook_write')
        .replace('workspace_replace', 'notebook_replace');

    if (!conversationId) {
        return { error: 'Notebook requires an active conversation. Send a message first.' };
    }

    // Lazy-load DB helpers to avoid circular deps
    const { getOne, run } = require('../db');
    const notebookStore = require('../stores/notebookStore');

    // Helper: get notebook content from either agent or direct conversations.
    // Returns user_id alongside content so callers can cross-check ownership
    // against the tool's execution context. When the conversation row has a
    // `workspace_notebook_id` link, we resolve content from the standalone
    // `notebooks` table — that is the source of truth the UI reads, so the
    // tool must read/write there too. Otherwise we fall back to the legacy
    // per-conversation `workspace_content` column.
    async function getWorkspace(convId) {
        let row = await getOne('SELECT workspace_content, workspace_notebook_id, user_id FROM agent_conversations WHERE id = $1', [convId]);
        let source = 'agent';
        if (!row) {
            row = await getOne('SELECT workspace_content, workspace_notebook_id, user_id FROM direct_conversations WHERE id = $1', [convId]);
            source = 'direct';
        }
        if (!row) return null;
        if (row.workspace_notebook_id) {
            const notebook = await notebookStore.getNotebook(row.workspace_notebook_id, row.user_id);
            // These tools speak Markdown, so prefer the canonical Markdown
            // mirror and fall back to document_content only when there isn't
            // one (older rows). Reading document_content unconditionally handed
            // the model HTML once a write had populated it.
            return {
                content: (notebook && (notebook.documentMd != null ? notebook.documentMd : notebook.documentContent)) || '',
                user_id: row.user_id,
                source,
                notebookId: row.workspace_notebook_id,
            };
        }
        return { content: row.workspace_content || '', user_id: row.user_id, source };
    }

    // Fails CLOSED. `conversationId` is client-supplied and getWorkspace resolves
    // it by id alone, so this is the only thing standing between a caller and
    // another user's notebook. A missing callerUserId used to short-circuit the
    // comparison and wave everything through — treat it as a denial instead.
    function denyIfCrossUser(workspace) {
        if (!workspace) return null;
        if (!callerUserId) {
            log.warn('[NotebookTool] refused: no caller identity in tool context', { conversationId });
            return { error: 'This notebook belongs to a different user.' };
        }
        if (workspace.user_id && workspace.user_id !== callerUserId) {
            log.warn('[NotebookTool] cross-user access blocked:', { conversationId, caller: callerUserId, owner: workspace.user_id });
            return { error: 'This notebook belongs to a different user.' };
        }
        return null;
    }

    // Helper: persist notebook content. Writes to the linked standalone
    // notebook when the conversation has one (via notebookStore so version
    // tracking and owner gating stay consistent), otherwise to the legacy
    // per-conversation column.
    async function setWorkspace(convId, content, workspace) {
        if (workspace?.notebookId) {
            // `content` is Markdown. Store it as the canonical mirror and keep
            // document_content as the HTML rendering, so the notebook UI and the
            // PDF/DOCX export path (both of which expect HTML) stay correct
            // while these tools keep reading Markdown back out.
            const { markdownToHtml } = require('../core/markdown');
            let html = content;
            try { html = markdownToHtml(content); } catch (_) { /* fall back to raw */ }
            return notebookStore.updateNotebook(workspace.notebookId, workspace.user_id, {
                documentContent: html,
                documentMd: content,
                documentFormat: 'markdown',
            });
        }
        // The owner predicate is defence in depth: every caller already runs
        // denyIfCrossUser(workspace) first, so a cross-user write cannot reach
        // here today. Keeping the scope in the statement means a future caller
        // that forgets the guard writes nothing rather than writing to someone
        // else's conversation — the same rule the notebook branch above gets for
        // free from updateNotebook(id, user_id, ...).
        const ownerId = workspace?.user_id;
        if (!ownerId) return false;
        const agentResult = await run('UPDATE agent_conversations SET workspace_content = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', [content, convId, ownerId]);
        if (agentResult.rowCount > 0) return true;
        const directResult = await run('UPDATE direct_conversations SET workspace_content = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', [content, convId, ownerId]);
        return directResult.rowCount > 0;
    }

    // ─── notebook_read ──────────────────────────────────────────────
    if (normalizedName === 'notebook_read') {
        try {
            const workspace = await getWorkspace(conversationId);
            const denied = denyIfCrossUser(workspace);
            if (denied) return denied;
            const content = workspace?.content || '';
            if (!content.trim()) {
                return { content: '', message: 'The notebook is currently empty.' };
            }

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
        } catch (err) {
            log.error('[NotebookTool] Read failed:', err.message);
            return { error: 'Failed to read notebook content.' };
        }
    }

    // ─── notebook_write ─────────────────────────────────────────────
    if (normalizedName === 'notebook_write') {
        const content = typeof args.content === 'string' ? args.content : '';
        const title = args.title || 'Notebook';

        if (!content.trim()) {
            return {
                error: 'content is required for notebook_write. Generate the full Markdown document first, then call notebook_write with it. Do not call notebook_write with empty or placeholder content.'
            };
        }

        try {
            const existing = await getWorkspace(conversationId);
            const denied = denyIfCrossUser(existing);
            if (denied) return denied;
            const saved = await setWorkspace(conversationId, content, existing);
            if (!saved) {
                log.error('[NotebookTool] Write not persisted (0 rows updated):', { conversationId, notebookId: existing?.notebookId || null });
                return {
                    error: 'Notebook save FAILED — the change was NOT persisted (the linked notebook may have been deleted or is not accessible). Do not tell the user the notebook was updated; report the failure instead.',
                    _nbWriteFailed: true,
                    _revertContent: existing?.content || ''
                };
            }
            const words = wordCount(content);
            return {
                _action: 'workspace_update',
                content, // Full content → sent via SSE to frontend
                title,
                // Compact message for LLM context (the LLM just wrote it, doesn't need it back)
                message: `Notebook updated: "${title}" (${words} words, ${content.split('\n').length} lines). Content is now visible in the notebook panel.`
            };
        } catch (err) {
            log.error('[NotebookTool] Write failed:', err.message);
            return { error: 'Failed to write to notebook.' };
        }
    }

    // ─── notebook_insert ────────────────────────────────────────────
    if (normalizedName === 'notebook_insert') {
        const insertContent = args.content || '';
        const position = args.position || 'end';
        const afterText = args.after_text || '';

        if (!insertContent.trim()) {
            return { error: 'content is required for notebook_insert.' };
        }

        try {
            const workspace = await getWorkspace(conversationId);
            const denied = denyIfCrossUser(workspace);
            if (denied) return denied;
            const currentContent = workspace?.content || '';
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
                    const normalizeWs = (t) => t.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
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

            const saved = await setWorkspace(conversationId, newContent, workspace);
            if (!saved) {
                log.error('[NotebookTool] Insert not persisted (0 rows updated):', { conversationId, notebookId: workspace?.notebookId || null });
                return {
                    error: 'Notebook save FAILED — the change was NOT persisted (the linked notebook may have been deleted or is not accessible). Do not tell the user the notebook was updated; report the failure instead.',
                    _nbWriteFailed: true,
                    _revertContent: workspace?.content || ''
                };
            }
            const words = wordCount(insertContent);
            return {
                _action: 'workspace_update',
                content: newContent, // Full content → SSE to frontend
                // Compact message for LLM
                message: `Inserted ${words} words at ${position}${position === 'after' ? ` "${afterText.substring(0, 50)}"` : ''}. Notebook now has ${wordCount(newContent)} words total.`
            };
        } catch (err) {
            log.error('[NotebookTool] Insert failed:', err.message);
            return { error: 'Failed to insert into notebook.' };
        }
    }

    // ─── notebook_replace ───────────────────────────────────────────
    if (normalizedName === 'notebook_replace') {
        const findText = args.find_text;
        const replaceText = args.replace_text ?? '';
        const sectionHeading = args.section_heading;

        if (!findText) {
            return { error: 'find_text is required for notebook_replace.' };
        }

        try {
            const workspace = await getWorkspace(conversationId);
            const denied = denyIfCrossUser(workspace);
            if (denied) return denied;
            const currentContent = workspace?.content || '';

            if (!currentContent.trim()) {
                return { error: 'The notebook is empty — nothing to replace. Use notebook_write to create the initial content (only when the user has explicitly asked).' };
            }

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

            const saved = await setWorkspace(conversationId, newContent, workspace);
            if (!saved) {
                log.error('[NotebookTool] Replace not persisted (0 rows updated):', { conversationId, notebookId: workspace?.notebookId || null });
                return {
                    error: 'Notebook save FAILED — the change was NOT persisted (the linked notebook may have been deleted or is not accessible). Do not tell the user the notebook was updated; report the failure instead.',
                    _nbWriteFailed: true,
                    _revertContent: workspace?.content || ''
                };
            }
            const action = replaceText ? 'replaced' : 'removed';
            return {
                _action: 'workspace_update',
                content: newContent, // Full content → SSE to frontend
                // Compact message for LLM (it already knows what it replaced)
                message: `Text ${action} successfully. Notebook now has ${wordCount(newContent)} words.`
            };
        } catch (err) {
            log.error('[NotebookTool] Replace failed:', err.message);
            return { error: 'Failed to replace notebook content.' };
        }
    }

    return { error: `Unknown notebook tool: ${toolName}` };
}

/**
 * Seed the agent's notebook store from the LIVE client editor content, ONCE at
 * turn start, so notebook_read/replace/write/insert operate on what the user
 * currently sees. Fixes the split-brain where a manual edit lives in the editor
 * (and workspace_content) but the agent reads notebooks.document_content, which
 * still holds the agent's OWN last write (BFSF-287). Also closes the sub-1200ms
 * autosave race (an edit sent before the debounce fired is still seeded).
 *
 * Mirrors getWorkspace/setWorkspace routing:
 *   - linked notebook  → notebooks.document_content (notebookStore.updateNotebook)
 *   - otherwise        → agent_/direct_conversations.workspace_content
 *
 * No-op when the incoming content already equals what's stored (avoids needless
 * notebooks.version bumps and write races with the 1200ms frontend autosave) and
 * when the content is empty (never wipe a notebook on a transient-empty editor).
 * Ownership-gated on userId here because the tool dispatcher omits userId, so the
 * in-tool cross-user guard is inert (userId here comes from request auth).
 *
 * @returns {Promise<{ seeded: boolean, reason: string }>}
 */
async function syncClientWorkspaceContent(conversationId, userId, content) {
    if (!conversationId) return { seeded: false, reason: 'no-conversation' };
    if (typeof content !== 'string' || content.trim() === '') return { seeded: false, reason: 'empty' };

    // Lazy-load DB helpers to avoid circular deps (same pattern as executeWorkspaceTool).
    const { getOne, run } = require('../db');
    const notebookStore = require('../stores/notebookStore');

    // Resolve the conversation row: agent first, then direct (mirror getWorkspace).
    let row = await getOne('SELECT workspace_content, workspace_notebook_id, user_id FROM agent_conversations WHERE id = $1', [conversationId]);
    let table = 'agent_conversations';
    if (!row) {
        row = await getOne('SELECT workspace_content, workspace_notebook_id, user_id FROM direct_conversations WHERE id = $1', [conversationId]);
        table = 'direct_conversations';
    }
    if (!row) return { seeded: false, reason: 'no-row' };

    // Ownership cross-check (enforced here because toolDispatcher omits userId).
    if (userId && row.user_id && row.user_id !== userId) {
        log.warn('[NotebookSeed] cross-user seed blocked:', { conversationId, caller: userId, owner: row.user_id });
        return { seeded: false, reason: 'cross-user' };
    }

    if (row.workspace_notebook_id) {
        const nb = await notebookStore.getNotebook(row.workspace_notebook_id, row.user_id);
        if (!nb) return { seeded: false, reason: 'notebook-missing' };
        if ((nb.documentContent || '') === content) return { seeded: false, reason: 'unchanged' };
        // No expectedVersion → last-writer-wins; bumps version + refreshes the
        // document_md mirror, identical to a normal notebook_write.
        const ok = await notebookStore.updateNotebook(row.workspace_notebook_id, row.user_id, { documentContent: content });
        return { seeded: ok === true, reason: ok === true ? 'linked' : 'update-failed' };
    }

    // Legacy per-conversation column. `table` is an internal literal → safe to interpolate.
    if ((row.workspace_content || '') === content) return { seeded: false, reason: 'unchanged' };
    const res = await run(`UPDATE ${table} SET workspace_content = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`, [content, conversationId, userId || row.user_id]);
    return { seeded: res.rowCount > 0, reason: res.rowCount > 0 ? 'legacy' : 'update-failed' };
}

/**
 * Resolve the content a workspace pane should show for a conversation.
 *
 * When the conversation is linked to a standalone notebook, THAT notebook is the
 * source of truth — the AI tools write there via setWorkspace. The legacy
 * per-conversation `workspace_content` column only applies to unlinked
 * conversations. Reading the column unconditionally meant an AI write showed up
 * live over SSE, then vanished on reload, and the next client save overwrote it
 * for good.
 *
 * Returns Markdown (the dialect this pane and these tools speak).
 */
async function resolveWorkspaceContent({ notebookId, userId, fallbackContent }) {
    if (!notebookId) return fallbackContent || '';
    try {
        const notebookStore = require('../stores/notebookStore');
        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return fallbackContent || '';
        return (nb.documentMd != null ? nb.documentMd : nb.documentContent) || '';
    } catch (e) {
        log.warn('[Workspace] linked-notebook read failed, falling back to stored column:', e.message);
        return fallbackContent || '';
    }
}

module.exports = { WORKSPACE_TOOLS, executeWorkspaceTool, syncClientWorkspaceContent, resolveWorkspaceContent };
