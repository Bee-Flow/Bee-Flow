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

/**
 * Collaborators a test swaps on this object (testUtils/swaps.js): the
 * co-editing facade, resolved when used.
 */
const seams = {
    collab: () => require('../agents/notebooks/notebookCollab').defaultFacade(),
};

// A linked notebook the conversation's owner cannot open (deleted, or never
// theirs: the link is only an id the client sent) is not theirs to use.
const NOTEBOOK_UNAVAILABLE = 'The notebook linked to this chat is not accessible (it was deleted, or it is not shared with this user). Tell the user; do not claim to have read or changed it.';
// What the model is told when the user may read the linked notebook but not change it.
const NOTEBOOK_READ_ONLY = 'This user can view the linked notebook but not change it, so it was left as it is. Answer in the chat instead.';
const NOTEBOOK_CONFLICT = 'Someone changed the same part of the notebook while you were working, so your edit was NOT applied. Read the notebook again (notebook_read) and redo the edit on the current text.';
const NOTEBOOK_SAVE_FAILED = 'Notebook save FAILED — the change was NOT persisted (the linked notebook may have been deleted or is not accessible). Do not tell the user the notebook was updated; report the failure instead.';
// A whole-document write onto a notebook others are editing live: it would take
// out whatever they typed after the text the model worked from.
const NOTEBOOK_LIVE_STALE = 'Others are editing this notebook live and it changed since you read it, so notebook_write was NOT applied (it would have removed what they typed). Call notebook_read again and pass its revision to notebook_write, or make the change with notebook_replace or notebook_insert, which keep their typing.';
const NOTEBOOK_LIVE_READ_FIRST = 'Others are editing this notebook live, so notebook_write needs the revision notebook_read returns. Call notebook_read first and pass its revision to notebook_write, or use notebook_replace or notebook_insert instead. Nothing was written.';

// The live update a read of a co-edited notebook was made at, handed to the
// model as `revision` and given back to notebook_write.
const LIVE_REVISION = 'live:';
const liveRevision = (seq) => `${LIVE_REVISION}${seq}`;
function parseRevision(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text.startsWith(LIVE_REVISION)) return null;
    const seq = Number(text.slice(LIVE_REVISION.length));
    return Number.isInteger(seq) && seq >= 0 ? seq : null;
}

/** May this notebook role change the document? (routes/notebooksAccess.js ranks the same roles.) */
const canEditNotebook = (role) => role === 'owner' || role === 'editor';

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
ALWAYS prefer outline → section over full reads to save tokens.
When others are editing the notebook live, the answer carries a "revision": pass it to notebook_write.`,
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
                    },
                    revision: {
                        type: 'string',
                        description: 'The revision your last notebook_read returned, when it returned one (others are editing the notebook live). Required then: the write is applied only while nobody typed since that read.'
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

const { wordCount, parseSections, readNotebookContent } = require('./notebookReadModes');

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
            // The link is only an id the conversation's owner sent: it grants
            // nothing. The notebook is used with the owner's OWN role on it.
            const notebook = await notebookStore.getNotebook(row.workspace_notebook_id, row.user_id);
            if (!notebook) return { content: '', user_id: row.user_id, source, notebookId: null, notebookUnavailable: true };
            const role = notebook.role || (notebook.userId === row.user_id ? 'owner' : null);
            // While the notebook is co-edited the live document is the one to
            // read (and edit): the row is a mirror that lags typing by up to
            // minutes. These tools speak Markdown, so prefer the Markdown
            // rendering, and for the row the canonical Markdown mirror over
            // document_content (older rows have only the HTML).
            const { readCurrentContent } = require('../agents/notebooks/notebookCollab');
            const current = await readCurrentContent(notebook, seams.collab());
            const { htmlToMarkdown } = require('../core/markdown');
            const content = current.live
                ? (current.markdown != null ? current.markdown : htmlToMarkdown(current.html))
                : (notebook.documentMd != null ? notebook.documentMd : notebook.documentContent);
            return {
                content: content || '',
                user_id: row.user_id,
                source,
                notebookId: row.workspace_notebook_id,
                notebookRole: role,
                // Co-edited, and the live update this content was read at.
                coEdited: current.active,
                liveSeq: current.live && Number.isInteger(current.seq) ? current.seq : null,
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
        if (workspace.notebookUnavailable) {
            log.warn('[NotebookTool] refused: the linked notebook is not readable for this user', { conversationId });
            return { error: NOTEBOOK_UNAVAILABLE };
        }
        return null;
    }

    // Every write tool: the conversation's owner, and edit rights on a linked notebook.
    function denyWrite(workspace) {
        const denied = denyIfCrossUser(workspace);
        if (denied) return denied;
        if (workspace?.notebookId && !canEditNotebook(workspace.notebookRole)) {
            log.info('[NotebookTool] refused a write for a viewer of the linked notebook', { conversationId, notebookId: workspace.notebookId });
            return { error: NOTEBOOK_READ_ONLY };
        }
        return null;
    }

    // What a write tool answers when setWorkspace did not persist.
    const FAILED_WRITE = { conflict: NOTEBOOK_CONFLICT, forbidden: NOTEBOOK_READ_ONLY, stale: NOTEBOOK_LIVE_STALE, 'read-first': NOTEBOOK_LIVE_READ_FIRST };
    function failedWrite(result, workspace, what) {
        const refusedLive = result === 'stale' || result === 'read-first';
        log[refusedLive ? 'info' : 'error'](`[NotebookTool] ${what} not persisted:`, { conversationId, notebookId: workspace?.notebookId || null, reason: result || 'no-rows' });
        const error = FAILED_WRITE[result] || NOTEBOOK_SAVE_FAILED;
        return { error, _nbWriteFailed: true, _revertContent: workspace?.content || '' };
    }

    // Helper: persist notebook content. Writes to the linked standalone
    // notebook when the conversation has one (via notebookStore so version
    // tracking and owner gating stay consistent), otherwise to the legacy
    // per-conversation column.
    // Answers true, or why not: 'forbidden', 'conflict', 'stale' or false.
    // `expectSeq`: `content` is a whole document the model composed from the
    // live notebook as it was at that update (notebook_write's revision).
    async function setWorkspace(convId, content, workspace, { expectSeq = null } = {}) {
        if (workspace?.notebookId) {
            // Edit rights on the notebook itself, checked again right here: the
            // co-editing engine below is a trusted server facade that checks no
            // one, and the conversation link grants nothing.
            const nb = await notebookStore.getNotebook(workspace.notebookId, workspace.user_id);
            const role = nb && (nb.role || (nb.userId === workspace.user_id ? 'owner' : null));
            if (!canEditNotebook(role)) {
                log.warn('[NotebookTool] refused: no edit rights on the linked notebook', { conversationId: convId, notebookId: workspace.notebookId });
                return 'forbidden';
            }
            // `content` is Markdown. Store it as the canonical mirror and keep
            // document_content as the HTML rendering, so the notebook UI and the
            // PDF/DOCX export path (both of which expect HTML) stay correct
            // while these tools keep reading Markdown back out.
            const { markdownToHtml } = require('../core/markdown');
            let html = content;
            try { html = markdownToHtml(content); } catch (_) { /* fall back to raw */ }
            // While the notebook is co-edited, the live document is the
            // co-editing state: the edit goes in there (everyone's editor
            // follows) instead of onto the row, where the next materialisation
            // would silently undo it. An insert or a replace was computed in
            // this call from what it read, `workspace.content`: only that
            // change is carried onto the live document, so typing since the
            // read survives, and a change to the same blocks is a conflict. A
            // whole document (notebook_write) was composed from an EARLIER
            // read, so it goes in only while nothing was typed since that
            // read's update (`expectSeq`), and is refused ('stale') otherwise.
            // A failing engine refuses rather than writing the row behind
            // everyone's back.
            try {
                const { applyEdit } = require('../agents/notebooks/notebookCollab');
                const edit = Number.isInteger(expectSeq)
                    ? { html, markdown: content, expectSeq }
                    : { html, markdown: content, base: { markdown: workspace.content || '' } };
                // The engine records the versions around it (this path keeps no history of its own).
                const live = await applyEdit(workspace.notebookId, { origin: 'ai', actorId: workspace.user_id, recordVersions: true },
                    edit, seams.collab());
                if (live.conflict) return 'conflict';
                if (live.stale) return 'stale';
                // The live update it made: the revision a next whole write goes from.
                if (live.applied) { workspace.liveSeqAfter = Number.isInteger(live.seq) ? live.seq : null; return true; }
            } catch (e) {
                log.warn('[NotebookTool] co-edited notebook write failed', { notebookId: workspace.notebookId, error: e.message });
                return false;
            }
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
            // Read live: the update it was read at, for a later notebook_write.
            const revision = workspace?.liveSeq != null ? { revision: liveRevision(workspace.liveSeq) } : {};
            if (!content.trim()) {
                return { content: '', message: 'The notebook is currently empty.', ...revision };
            }

            const result = readNotebookContent(content, args);
            return result.error ? result : { ...result, ...revision };
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
            const denied = denyWrite(existing);
            if (denied) return denied;
            // Others are editing it live: the whole document goes in only from
            // the update the model read (its revision), never over typing since.
            const expectSeq = existing?.coEdited ? parseRevision(args.revision) : null;
            if (existing?.coEdited && expectSeq === null) return failedWrite('read-first', existing, 'Write');
            const saved = await setWorkspace(conversationId, content, existing, { expectSeq });
            if (saved !== true) return failedWrite(saved, existing, 'Write');
            const words = wordCount(content);
            return {
                _action: 'workspace_update',
                content, // Full content → sent via SSE to frontend
                title,
                ...(existing?.liveSeqAfter != null ? { revision: liveRevision(existing.liveSeqAfter) } : {}),
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
            const denied = denyWrite(workspace);
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
            if (saved !== true) return failedWrite(saved, workspace, 'Insert');
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
            const denied = denyWrite(workspace);
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
            if (saved !== true) return failedWrite(saved, workspace, 'Replace');
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
        // A co-edited notebook's live state is authoritative (and already what
        // the pane shows): seeding it from one client's copy would overwrite
        // everyone else's typing.
        const { isCollabActive } = require('../agents/notebooks/notebookCollab');
        if (await isCollabActive(row.workspace_notebook_id)) return { seeded: false, reason: 'collab-active' };
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

/**
 * Why `userId` may not link notebook `notebookId` to their chat, or null when
 * they may. The chat's notebook tools write through that link, so it takes
 * edit rights on the notebook (a viewer, or someone who only saw the id in a
 * URL, gets a refusal). The tools check the role again on every use.
 *
 * @returns {Promise<null | { status: 403|404, error: string }>}
 */
async function notebookLinkRefusal(notebookId, userId) {
    if (!notebookId) return null;
    const notebookStore = require('../stores/notebookStore');
    const nb = await notebookStore.getNotebook(notebookId, userId);
    if (!nb) return { status: 404, error: 'Notebook not found' };
    const role = nb.role || (nb.userId === userId ? 'owner' : null);
    if (!canEditNotebook(role)) {
        return { status: 403, error: 'You can view this notebook but not change it, so it cannot be linked to a chat.' };
    }
    return null;
}

module.exports = { WORKSPACE_TOOLS, executeWorkspaceTool, syncClientWorkspaceContent, resolveWorkspaceContent, notebookLinkRefusal, seams };
