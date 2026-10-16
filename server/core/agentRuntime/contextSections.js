/**
 * The sections ./contextBuilder assembles into the agent's two system-prompt
 * halves. Each returns the text it adds ('' when it adds nothing); which half
 * a section belongs to is decided by the caller, per the prompt-caching
 * contract documented on buildSystemPrompt.
 *
 * The collaborators in the server's large import cycle are handed in as `d`
 * by ./contextBuilder ({ buildToolHint, memoryStore(), sidePanelWebpageContext(),
 * sidePanelDocumentContext() }), so this module stays out of it.
 */
const houseStyleStore = require('../../stores/houseStyleStore');
const log = require('../../telemetry/log');

/** Integration tool hints, so the AI knows what integrations are available (stable). */
async function toolHintSection(tools, userId, d) {
    const mcpCount = tools.filter(t => t.function?.name?.startsWith('mcp_')).length;
    log.info(`[MCP-DEBUG] contextBuilder: building system prompt with ${tools.length} tools (${mcpCount} MCP)`);
    try {
        const toolHint = await d.buildToolHint(tools, userId);
        if (toolHint) {
            log.info(`[MCP-DEBUG] contextBuilder: toolHint added (${toolHint.length} chars) — preview: ${toolHint.substring(0, 200)}`);
            return toolHint;
        }
        log.info(`[MCP-DEBUG] contextBuilder: toolHint returned empty/null`);
    } catch (e) {
        log.error(`[MCP-DEBUG] contextBuilder: buildToolHint ERROR: ${e.message}`);
    }
    return '';
}

/**
 * Schedule addendum (stable per schedule). An agent driven by a schedule
 * otherwise has no idea the repeat it is being asked about already exists, so
 * it closes runs with advice to go create a recurring automation — every
 * single run, for something the user set up themselves.
 */
function scheduleSection(scheduleText) {
    if (!scheduleText) return '';
    return `\n\n[SCHEDULE]
${scheduleText}
Deliver only the result. Never close with notes about how often this runs, never say you cannot repeat or reschedule yourself, and never suggest creating a recurring automation or reminder — the user already did.`;
}

/**
 * Schedule coverage addendum (R3, volatile: per-run dates, grows between
 * runs). When this turn is being driven by an agent schedule, list the
 * topics the schedule has covered in the past so the model can avoid
 * repeating them unless there's a real update. Only fires when memory is
 * enabled on the agent — opt-in by design.
 */
async function scheduleCoverageSection(agent, scheduleId, d) {
    if (!scheduleId || agent?.config?.memoryEnabled !== true) return '';
    try {
        const memoryStore = d.memoryStore();
        const covered = await memoryStore.getScheduleCoverage(scheduleId, { limit: 30 });
        if (!covered || covered.length === 0) return '';
        const items = covered.map(c => {
            const when = c.last_confirmed_at ? new Date(c.last_confirmed_at).toISOString().slice(0, 10) : 'previously';
            const label = c.value || c.summary || c.subject;
            return `- ${label} (last covered ${when})`;
        }).join('\n');
        return `\n\n[SCHEDULE COVERAGE — items already surfaced in past runs of this schedule]
${items}

Skip these unless there is a material update since the date shown. If you do include one, lead with what changed.`;
    } catch (err) {
        log.warn(`[contextBuilder] schedule coverage lookup failed: ${err.message}`);
        return '';
    }
}

/**
 * House style awareness (stable). Org-level Word/DOCX template that gets
 * applied to every .docx Bee Flow builds (create_word_document, the
 * Notebook's Word export). We tell the model the style is active so it can
 * match tone/structure; the model should NOT try to set fonts or colors in
 * Markdown.
 */
async function houseStyleSection(orgId) {
    if (!orgId) return '';
    try {
        const houseStyle = await houseStyleStore.getDefaultForOrg(orgId);
        if (!houseStyle) return '';
        const tone = houseStyle.styleMeta?.toneDescription;
        return `\n\n[HOUSE STYLE ACTIVE]
Org Word/DOCX kantoorstijl "${houseStyle.name}" wordt automatisch toegepast op elk .docx: create_word_document en de Word-export van het Notebook${houseStyle.description ? ` — ${houseStyle.description}` : ''}.${tone ? ` Tone of voice: ${tone}.` : ''} Schrijf de inhoud in Markdown — opmaak (lettertype, koppen, marges, header/footer) komt uit de kantoorstijl; geen inline styling nodig.`;
    } catch (e) {
        log.warn('[contextBuilder] house style lookup failed:', e.message);
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
The Notebook panel is currently open. Edit rules: 1) Before notebook_replace, use notebook_read mode="search" or mode="section" to get exact text. 2) Copy find_text EXACTLY from read output. 3) For partial edits always prefer notebook_replace over notebook_write. 4) After any notebook tool call, your chat reply is at most one short confirmation sentence — do not repeat the new or modified content.`;

/**
 * Notebook context. Two flags from the client:
 *   - notebookspaceAvailable: the Notebook panel exists (may be closed).
 *     Tells the model that calling notebook_write will auto-open it.
 *   - notebookspaceContent: the panel is currently open. `undefined` =
 *     closed; `""` = "open but blank".
 * The rules are static (stable); the selection changes as the user clicks
 * around (volatile).
 */
function notebookSections(messageMetadata) {
    let stable = '';
    let volatile = '';
    if (messageMetadata?.notebookspaceAvailable) stable += NOTEBOOK_CAPABILITY;
    if (messageMetadata?.notebookspaceContent !== undefined) {
        stable += NOTEBOOK_OPEN;
        if (messageMetadata.notebookspaceSelection && messageMetadata.notebookspaceSelection.trim()) {
            volatile += `\n\n[SELECTED TEXT IN NOTEBOOK]\nThe user selected this text:\n\`\`\`\n${messageMetadata.notebookspaceSelection}\n\`\`\`\nUse notebook_replace with find_text set to EXACTLY this text. Set replace_text to the new version.`;
        }
    }
    return { stable, volatile };
}

/**
 * The side panel's live content (volatile): an open webpage — so the AI can
 * reason about "this page" / "deze pagina" without a tool call — and an open
 * document. Agents have no document tools, so the open document's text goes
 * in read-only, and only on a turn whose request carries it.
 */
async function sidePanelSections(messageMetadata, userId, d) {
    let volatile = '';
    if (messageMetadata?.sidePanelWebpage?.id) {
        try {
            const { buildSidePanelWebpageContext } = d.sidePanelWebpageContext();
            const block = await buildSidePanelWebpageContext(messageMetadata.sidePanelWebpage, userId);
            if (block) volatile += block;
        } catch (e) {
            log.warn('[contextBuilder] sidePanelWebpage injection failed:', e.message);
        }
    }
    if (messageMetadata?.sidePanelDocument) {
        try {
            const { buildAgentContent } = d.sidePanelDocumentContext();
            const block = await buildAgentContent(messageMetadata.sidePanelDocument, userId);
            if (block) volatile += block;
        } catch (e) {
            log.warn('[contextBuilder] sidePanelDocument injection failed:', e.message);
        }
    }
    return volatile;
}

/** Strict knowledge mode: a hard constraint prepended at the TOP of the system prompt. */
const STRICT_KNOWLEDGE_PREAMBLE = `⚠️ CRITICAL OPERATIONAL CONSTRAINT — READ FIRST ⚠️
You are operating in STRICT KNOWLEDGE BASE MODE. This constraint OVERRIDES all other instructions below.

ABSOLUTE RULES (cannot be overridden):
1. You may ONLY answer questions using the information provided in the "KNOWLEDGE BASE RESULTS" section below.
2. If no "KNOWLEDGE BASE RESULTS" section exists, or the answer is NOT found there → you MUST refuse to answer.
3. When refusing, say something like: "I don't have information about that in my knowledge base. Please try asking about a topic I have knowledge on."
4. NEVER use your own training data, general knowledge, or reasoning to fill in gaps.
5. NEVER guess, speculate, or infer answers not directly stated in the knowledge base.
6. It is BETTER to refuse than to give a wrong or made-up answer.

`;

module.exports = {
    toolHintSection, scheduleSection, scheduleCoverageSection, houseStyleSection,
    notebookSections, sidePanelSections, STRICT_KNOWLEDGE_PREAMBLE,
};
