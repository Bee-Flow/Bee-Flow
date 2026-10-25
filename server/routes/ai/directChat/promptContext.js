/**
 * Direct Chat prompt assembly: the context blocks the system prompt is built
 * from. Project instructions and project KB retrieval, the attached KBs, the
 * memory block, house style, the notebook capability and selection, the
 * side-panel webpage and document, skills, and the capability-honesty
 * addenda. Split out of promptAssembly.js; behaviour unchanged.
 *
 * Each builder returns the text for the STABLE block (cached prefix) and/or
 * the VOLATILE block (per turn) separately; see promptAssembly.js for which
 * goes where and why.
 */

const userStore = require('../../../stores/userStore');
const log = require('../../../telemetry/log');
const { resolveMemoryPolicy } = require('../../../core/memory/memoryPolicy');
const { memoryUsedItems, emitMemoryUsed } = require('../../../core/memory/memoryUsed');
const { fallback } = require('../../../utils/bestEffort');

/**
 * Knowledge-base passages go into the prompt without a tool call, so the
 * Privacy Shield's "own server" block list is applied to them here
 * (BFSF-354); the same passages fetched through kb_search are stripped in the
 * tool loop. The "### Source N:" label goes through the same scan (a title
 * can carry the same data). Resolved once, and only when there are passages
 * to strip. Returns a function from passages to prompt text.
 */
function makeKbPassagesText({ userOrgForTiers, userId }) {
    let kbShield;
    return async (chunks) => {
        if (kbShield === undefined) {
            try {
                const { resolveShieldFor } = require('../../../core/privacy/orgShield');
                kbShield = await resolveShieldFor({ orgId: userOrgForTiers || null, userId });
            } catch (e) {
                kbShield = null;
                log.warn('[DirectChat] Shield lookup for KB passages failed (fail-open):', e.message);
            }
        }
        const { injectedPassagesPrompt } = require('../../../core/privacy/toolPiiGate');
        return injectedPassagesPrompt(chunks, { shield: kbShield, tag: 'DirectChat' });
    };
}

/**
 * Project context. `projectId` comes from the REQUEST BODY and is therefore
 * attacker-chosen: it is resolved into `validProjectId` ONCE, here, and only
 * that is used from this point on. Memory retrieval drops its `user_id`
 * filter whenever a projectId is present (memoryStore.findRelevantMemories),
 * so an unvalidated id would inject any project's memories into the prompt.
 */
async function projectContextFor({ req, userId, projectId, message, kbPassagesText }) {
    const out = { stable: '', volatile: '', validProjectId: null, extractMemoriesEnabled: false };
    if (!projectId) return out;
    const { resolveRequestedProject } = require('../../../auth/projectAccess');
    const resolved = await resolveRequestedProject(userId, projectId);
    if (!resolved) return out;
    const project = resolved.project;
    out.validProjectId = resolved.projectId;
    out.extractMemoriesEnabled = project.extractMemories === true;
    // Inject custom instructions
    if (project.customInstructions && project.customInstructions.trim()) {
        out.stable += `\n\n[PROJECT INSTRUCTIONS — "${project.name}"]\n${project.customInstructions}`;
    }
    // Search project knowledge bases
    const kbIds = project.knowledgeBaseIds || [];
    if (kbIds.length === 0) return out;
    try {
        const { quickKBSearch } = require('../../../core/agentRuntime/knowledgeSearch');
        const kbResults = await quickKBSearch(userId, kbIds, message, { topK: 6, session: req.session });
        if (kbResults.length > 0) {
            const kbText = await kbPassagesText(kbResults);
            // Retrieved against THIS turn's message: volatile.
            out.volatile += `\n\n[PROJECT KNOWLEDGE BASE — "${project.name}"]\nRelevant information from this project's knowledge base:\n${kbText}`;
            log.info(`[DirectChat] Injected ${kbResults.length} KB chunks from project "${project.name}"`);
        }
    } catch (kbErr) {
        log.warn('[DirectChat] Project KB search failed:', kbErr.message);
    }
    return out;
}

/**
 * The KBs picked in the input-area picker: ids from a client, checked here
 * (core/kb/kbVisibility through kbSelection) rather than trusted. What this
 * turn may search comes from the REQUEST, never from the stored column (see
 * promptAssembly.js). `usableKbIds` is what survived both checks, and also
 * what gets persisted at the end of the turn.
 */
async function attachedKbContext({ req, userId, message, requestedKbIds, orgIdsForTiers, kbPassagesText }) {
    const out = { volatile: '', usableKbIds: [] };
    if (!(Array.isArray(requestedKbIds) && requestedKbIds.length > 0)) return out;
    const { resolveUsableKbIds } = require('../../../core/kb/kbSelection');
    const userGroupsRaw = await userStore.getUser(userId).then(u => u?.groups).catch((e) => fallback('routes/ai/directChat/promptContext:attachedKbContext', e, null));
    const userGroups = Array.isArray(userGroupsRaw)
        ? userGroupsRaw
        : (() => { try { return JSON.parse(userGroupsRaw || '[]'); } catch (_) { return []; } })();
    out.usableKbIds = await resolveUsableKbIds(requestedKbIds, {
        userId,
        orgIds: orgIdsForTiers instanceof Set ? orgIdsForTiers : new Set(),
        userGroups,
        surface: 'direct_chat',
    });
    if (out.usableKbIds.length < requestedKbIds.length) {
        log.warn(`[DirectChat] User ${userId} requested ${requestedKbIds.length} KBs but only ${out.usableKbIds.length} were usable here`);
    }
    // A retrieval failure is NOT an authorisation failure: the search dying (or
    // matching nothing) must not silently detach the bases the person picked.
    if (out.usableKbIds.length === 0) return out;
    try {
        const { quickKBSearch } = require('../../../core/agentRuntime/knowledgeSearch');
        const kbResults = await quickKBSearch(userId, out.usableKbIds, message, { topK: 6, session: req.session });
        if (kbResults.length > 0) {
            const kbText = await kbPassagesText(kbResults);
            // Retrieved against THIS turn's message: volatile.
            out.volatile += `\n\n[ATTACHED KNOWLEDGE BASES]\nRelevant information from the knowledge bases attached to this chat:\n${kbText}`;
            log.info(`[DirectChat] Injected ${kbResults.length} KB chunks from ${out.usableKbIds.length} attached KBs`);
        }
    } catch (kbErr) {
        log.warn('[DirectChat] Direct-chat KB search failed:', kbErr.message);
    }
    return out;
}

/**
 * Memory injection. The gate is resolved once here and handed to
 * finalizeTurn on the turn state, so the write side never re-reads config.
 */
async function retrieveMemories({ req, send, userId, message, userOrgForTiers, validProjectId }) {
    const memoryPolicy = await resolveMemoryPolicy({
        userId, orgId: userOrgForTiers || null,
        perChatReadEnabled: req.body?.memoryReadEnabled,
        perChatWriteEnabled: req.body?.memoryWriteEnabled,
    });
    let memoryContext = '';
    let memoryUsed = [];
    if (memoryPolicy.read) try {
        const memoryStore = require('../../../stores/memoryStore');
        // Always pass the project for retrieval (project memories are available
        // regardless of the extractMemories flag), but only the VALIDATED id:
        // findRelevantMemories drops its user_id filter when a projectId is
        // present, so an unvalidated id here is a cross-project read.
        // TODO(memory): pass `queryEmbedding` when the attached-KB search
        // embedded this message; quickKBSearch does not return its vector yet.
        const relevantMemories = await memoryStore.findRelevantMemories(userId, null, message, 500, validProjectId, { includeSensitive: memoryPolicy.sensitive === true });
        if (relevantMemories.length > 0) {
            memoryContext = '\n\n' + memoryStore.formatMemoriesForPrompt(relevantMemories);
            // Once per turn, before the answer streams.
            memoryUsed = memoryUsedItems(relevantMemories);
            emitMemoryUsed(send, memoryUsed);
        }
    } catch (e) {
        log.warn('[DirectChat] Memory retrieval failed:', e.message);
    } else {
        log.info(`[DirectChat] Memory read skipped (${memoryPolicy.reason})`);
    }
    return { memoryPolicy, memoryContext, memoryUsed };
}

/**
 * House style awareness. When the org has a default house style, tell the
 * model so it can match tone; the formatting itself is applied when a .docx
 * is built (create_word_document, or the Notebook's Word export).
 */
async function houseStyleContextFor(userOrgForTiers) {
    try {
        if (!userOrgForTiers) return '';
        const houseStyleStore = require('../../../stores/houseStyleStore');
        const houseStyle = await houseStyleStore.getDefaultForOrg(userOrgForTiers);
        if (!houseStyle) return '';
        const tone = houseStyle.styleMeta?.toneDescription;
        return `\n\n[HOUSE STYLE ACTIVE]\nOrg Word/DOCX kantoorstijl "${houseStyle.name}" wordt automatisch toegepast op elk .docx: create_word_document en de Word-export van het Notebook${houseStyle.description ? ` — ${houseStyle.description}` : ''}.${tone ? ` Tone of voice: ${tone}.` : ''} Schrijf de inhoud in Markdown — lettertype, koppen, marges en header/footer komen uit de kantoorstijl; geen inline styling nodig.`;
    } catch (e) {
        log.warn('[DirectChat] house style lookup failed:', e.message);
        return '';
    }
}

const NOTEBOOK_CAPABILITY = `\n\n[NOTEBOOK CAPABILITY]
A Notebook panel is available in the user's UI. Tools:
- notebook_read: Read content. Modes: "outline" (default—headings+stats), "section" (one section by heading), "search" (find text), "full" (entire doc). Use outline first, then section/search for targeted access.
- notebook_write: Replace ALL content (for new documents or full rewrites). Write in Markdown.
- notebook_replace: Replace a SPECIFIC portion (find_text + replace_text). Preferred for partial edits.
- notebook_insert: Add content at "start", "end", or "after" a heading.

CRITICAL — WHEN TO WRITE TO THE NOTEBOOK:
- Only call notebook_write, notebook_replace, or notebook_insert when the user has EXPLICITLY asked you to put something in the notebook (e.g. "save this to the notebook", "schrijf dit in het notebook", "zet in mijn notitie", "add to the document", "write the report in the notebook", "noteer dit", "draft a letter in the notebook").
- Mere requests to "write", "draft", "summarise", "translate", "rewrite", "explain", or produce long-form content are NOT a notebook request — reply in chat instead. The user will explicitly ask if they want it in the notebook.
- If unsure whether the user wants the output in the notebook, do NOT write to it. Reply in chat and ask, or just answer in chat.
- The notebook is the user's document — never overwrite, append to, or modify it without an explicit instruction to do so.

When you DO use a notebook tool (after an explicit request), do NOT also write the document text in your chat reply. Acknowledge briefly (one short sentence) and stop — the user reads the result in the Notebook panel. Use Markdown inside the notebook for headings, bold, tables, lists, code blocks.`;

const NOTEBOOK_OPEN = `\n\n[NOTEBOOK OPEN]
The Notebook panel is currently open. Current rules for edits: 1) Before notebook_replace, use notebook_read mode="search" or mode="section" to get exact text. 2) Copy find_text EXACTLY from read output. 3) For partial edits always prefer notebook_replace over notebook_write. 4) After any notebook tool call, your chat reply is at most one short confirmation sentence — do not repeat the new or modified content.`;

/**
 * Notebook context. Two flags from the client: `notebookspaceAvailable` (the
 * panel exists in this UI, maybe closed; notebook_write auto-opens it via the
 * workspace_update SSE) and `notebookspaceContent` (the panel is open:
 * `undefined` means closed, `""` is "open but blank").
 */
function notebookContextFor({ canUseNotebooks, notebookspaceAvailable, notebookspaceContent, notebookspaceSelection }) {
    let stable = '';
    let volatile = '';
    if (canUseNotebooks && notebookspaceAvailable) stable = NOTEBOOK_CAPABILITY;
    if (canUseNotebooks && notebookspaceContent !== undefined) {
        stable += NOTEBOOK_OPEN;
        // The selection changes as the user clicks around: volatile.
        if (notebookspaceSelection && notebookspaceSelection.trim()) {
            volatile += `\n\n[SELECTED TEXT IN NOTEBOOK]\nThe user selected this text:\n\`\`\`\n${notebookspaceSelection}\n\`\`\`\nUse notebook_replace with find_text set to EXACTLY this text. Set replace_text to the new version.`;
        }
    }
    return { stable, volatile };
}

/**
 * The side panel: a webpage open there has its latest content resolved and
 * injected so the AI can answer questions about "this page"; for a document
 * only WHICH one is open (the model reads it with document_read, allowed by
 * core/documents/aiDocumentScope.js). Both are volatile.
 */
async function sidePanelContext({ sidePanelWebpage, sidePanelDocument, userId }) {
    let volatile = '';
    if (sidePanelWebpage?.id) {
        try {
            const { buildSidePanelWebpageContext } = require('../../../core/webpages/sidePanelWebpageContext');
            const block = await buildSidePanelWebpageContext(sidePanelWebpage, userId);
            if (block) volatile += block;
        } catch (e) {
            log.warn('[DirectChat] sidePanelWebpage injection failed:', e.message);
        }
    }
    if (sidePanelDocument) {
        const { buildDirectNote } = require('../../../core/documents/sidePanelDocumentContext');
        const note = await buildDirectNote(sidePanelDocument, userId);
        if (note) volatile += note;
    }
    return volatile;
}

/**
 * Skills injection. Static skills inject their full body; dynamic skills only
 * a manifest line, plus an `activate_skill` tool pushed onto directChatTools
 * so the model can pull the full body on demand.
 */
async function skillsContextFor({ activeSkillIds, userOrgForTiers, userId, conversationId, directChatTools }) {
    try {
        const { buildSkillInjection } = require('../../../core/tools/skillInjection');
        const skillInjection = await buildSkillInjection({
            sessionSkillIds: Array.isArray(activeSkillIds) ? activeSkillIds : [],
            attachedSkillIds: [], // direct chat has no agent => no attached skills
            orgId: userOrgForTiers,
            userId,
            // One skill_activations row per conversation instead of one per
            // turn. No agentId: direct chat has no agent.
            conversationId,
        });
        let skillsContext = '';
        if (skillInjection.systemPromptAddendum) {
            skillsContext = skillInjection.systemPromptAddendum;
            log.info(`[DirectChat] Skills: ${skillInjection.staticCount} static, ${skillInjection.dynamicSkillIds.length} dynamic`);
        }
        for (const t of skillInjection.tools) directChatTools.push(t);
        return skillsContext;
    } catch (skillErr) {
        log.warn('[DirectChat] Skills injection failed:', skillErr.message);
        return '';
    }
}

/**
 * Capability-honesty addenda (BFSF-176/125/127): the truth about which media
 * tools are registered, so the model doesn't invent an image via HTML/WebGL
 * when generate_image is absent, and Gmail attachment reads steered to the
 * real tool rather than a hallucinated convert_document_to_text.
 */
function capabilityContextFor(directChatTools) {
    const toolNames = new Set(directChatTools.map(t => t.function?.name).filter(Boolean));
    let capabilityContext = '';
    if (!toolNames.has('generate_image') && !toolNames.has('generate_video')) {
        capabilityContext += `\n\n[MEDIA GENERATION UNAVAILABLE]\nYou do NOT currently have an image or video generation tool. If the user asks you to generate, create, or draw an image or video, tell them it is unavailable on this workspace (an admin can enable it). Do NOT attempt to produce the media via HTML, CSS, Canvas, WebGL, SVG, create_webpage, or any other code-based workaround.`;
    }
    if ([...toolNames].some(n => n.startsWith('gmail_'))) {
        capabilityContext += `\n\n[GMAIL / ATTACHMENTS]\nTo read an email body use gmail_read; to extract text from an email attachment use gmail_read_attachment. Do NOT call any generic convert/terminal/document-conversion tool — those do not exist. Uploaded chat files already have their text provided to you inline.`;
    }
    return capabilityContext;
}

module.exports = {
    makeKbPassagesText, projectContextFor, attachedKbContext, retrieveMemories, houseStyleContextFor,
    notebookContextFor, sidePanelContext, skillsContextFor, capabilityContextFor,
};

/** @typedef {import('../../../core/agentRuntime/chatStream/turnState').ToolDef} ToolDef */

/** @typedef {ReturnType<typeof makeKbPassagesText>} KbPassagesText */
