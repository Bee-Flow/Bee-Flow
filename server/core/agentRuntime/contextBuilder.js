const { processSystemPrompt } = require('../llm/promptUtils');
const { nowLine } = require('../llm/clock');
const { buildToolHint } = require('../integrations/integrationTools');
const { buildSkillInjection } = require('../tools/skillInjection');
const houseStyleStore = require('../../stores/houseStyleStore');
const log = require('../../telemetry/log');

/**
 * Build the agent's system prompt as two halves.
 *
 * PROMPT CACHING CONTRACT — read before adding anything here.
 *
 * Anthropic's prompt cache is a prefix match: one byte of drift anywhere in
 * the prefix invalidates everything after it. The Claude adapter puts a
 * 1-hour `cache_control` breakpoint on the FIRST system block only
 * (providers/claude.js → extractSystem), which caches `tools + system[0]` as
 * one durable prefix. So:
 *
 *   - `stable`   → system[0]. MUST be byte-identical for every turn of a
 *                  conversation. Identity, tool hints, static capability
 *                  rules, static skills. No clocks, no retrieval, no
 *                  per-message text.
 *   - `volatile` → a later, uncached system block. Timestamps, retrieved
 *                  memories, routine coverage, notebook selection, side-panel
 *                  page content — anything that legitimately changes per turn.
 *
 * A single `Now:` line in the stable half is enough to drive the hit rate to
 * zero, and a 1h breakpoint costs 2x on write — so a churning prefix is more
 * expensive than no caching at all. When in doubt, put it in `volatile`.
 *
 * @returns {Promise<{stable: string, volatile: string}>}
 */
async function buildSystemPrompt({ agent, tools, userId, messageMetadata, memoryContext, isStrictKnowledge, forceDynamicSkills = false }) {
    const defaultPrompt = tools.length > 0
        ? `You are a helpful AI assistant. You have access to the following tools to help accomplish tasks. Use them when appropriate.`
        : `You are a helpful AI assistant. Answer the user's questions to the best of your ability.`;

    let systemPrompt = agent.system_prompt || defaultPrompt;
    // Per-turn half. Never carries a cache breakpoint.
    let volatilePrompt = '';

    // Process dynamic tags in system prompt. `{Time}`/`{DateTime}` resolve at
    // second resolution and a user-authored agent prompt can place them
    // anywhere, so they are deferred to the volatile half and only `{Date}`
    // is expanded inline here.
    systemPrompt = processSystemPrompt(systemPrompt, { deferClockTags: true });

    // Append integration tool hints so the AI knows what integrations are available
    const mcpCount = tools.filter(t => t.function?.name?.startsWith('mcp_')).length;
    log.info(`[MCP-DEBUG] contextBuilder: building system prompt with ${tools.length} tools (${mcpCount} MCP)`);
    try {
        const toolHint = await buildToolHint(tools, userId);
        if (toolHint) {
            systemPrompt += toolHint;
            log.info(`[MCP-DEBUG] contextBuilder: toolHint added (${toolHint.length} chars) — preview: ${toolHint.substring(0, 200)}`);
        } else {
            log.info(`[MCP-DEBUG] contextBuilder: toolHint returned empty/null`);
        }
    } catch (e) {
        log.error(`[MCP-DEBUG] contextBuilder: buildToolHint ERROR: ${e.message}`);
    }

    // Memory is relevance-retrieved against THIS turn's message, so it changes
    // almost every turn — volatile half.
    if (memoryContext) {
        volatilePrompt += '\n\n' + memoryContext;
    }

    // ─── Routine schedule addendum ───────────────────────────────
    // An agent driven by a routine otherwise has no idea the repeat it is
    // being asked about already exists, so it closes runs with advice to go
    // create a recurring automation — every single run, for something the user
    // set up themselves. Stable per routine, so it belongs in the cached half.
    if (messageMetadata?.routineSchedule) {
        systemPrompt += `\n\n[SCHEDULE]
${messageMetadata.routineSchedule}
Deliver only the result. Never close with notes about how often this runs, never say you cannot repeat or reschedule yourself, and never suggest creating a recurring automation or reminder — the user already did.`;
    }

    // ─── Routine coverage addendum (R3) ──────────────────────────
    // When this turn is being driven by an agent routine, list the topics the
    // routine has covered in the past so the model can avoid repeating them
    // unless there's a real update. Only fires when memory is enabled on the
    // agent — opt-in by design.
    const routineId = messageMetadata?.routineId;
    if (routineId && agent?.config?.memoryEnabled === true) {
        try {
            const memoryStore = require('../../stores/memoryStore');
            const covered = await memoryStore.getRoutineCoverage(routineId, { limit: 30 });
            if (covered && covered.length > 0) {
                const items = covered.map(c => {
                    const when = c.last_confirmed_at ? new Date(c.last_confirmed_at).toISOString().slice(0, 10) : 'previously';
                    const label = c.value || c.summary || c.subject;
                    return `- ${label} (last covered ${when})`;
                }).join('\n');
                // Carries per-run dates and grows between runs — volatile half.
                volatilePrompt += `\n\n[ROUTINE COVERAGE — items already surfaced in past runs of this routine]
${items}

Skip these unless there is a material update since the date shown. If you do include one, lead with what changed.`;
            }
        } catch (err) {
            log.warn(`[contextBuilder] routine coverage lookup failed: ${err.message}`);
        }
    }

    // ─── Writing style (BFSF-261) ────────────────────────────────
    // Unconditional so per-agent custom prompts get it too. Static text, so it
    // belongs in the cached half.
    const { buildWritingStyleAddendum } = require('../llm/promptStyle');
    systemPrompt += buildWritingStyleAddendum();

    // ─── Date/time context ───────────────────────────────────────
    // This is THE line that must never touch the cached half. It used to be
    // appended to `systemPrompt`, which made every agent request a guaranteed
    // cache miss. Minute resolution (core/llm/clock.js): a self-hosted
    // runtime's prefix cache is a byte match, and a second-resolution clock
    // re-reads the whole prompt on every request.
    const tz = messageMetadata?.timezone || 'UTC';
    volatilePrompt += `\n${nowLine(tz)}`;

    // ─── Notebook context injection ─────────────────────────────
    // Two flags from the client:
    //   - notebookspaceAvailable: the Notebook panel exists (may be closed).
    //     Tells the model that calling notebook_write will auto-open it.
    //   - notebookspaceContent: the panel is currently open. `undefined` =
    //     closed; `""` = "open but blank".
    // ─── House style awareness ───────────────────────────────────
    // Org-level Word/DOCX template that gets applied to every .docx Bee Flow
    // builds (create_word_document, the Notebook's Word export). We tell the
    // model the style is active so it can match tone/structure; the model
    // should NOT try to set fonts or colors in Markdown.
    if (messageMetadata?.orgId) {
        try {
            const houseStyle = await houseStyleStore.getDefaultForOrg(messageMetadata.orgId);
            if (houseStyle) {
                const tone = houseStyle.styleMeta?.toneDescription;
                systemPrompt += `\n\n[HOUSE STYLE ACTIVE]
Org Word/DOCX kantoorstijl "${houseStyle.name}" wordt automatisch toegepast op elk .docx: create_word_document en de Word-export van het Notebook${houseStyle.description ? ` — ${houseStyle.description}` : ''}.${tone ? ` Tone of voice: ${tone}.` : ''} Schrijf de inhoud in Markdown — opmaak (lettertype, koppen, marges, header/footer) komt uit de kantoorstijl; geen inline styling nodig.`;
            }
        } catch (e) {
            log.warn('[contextBuilder] house style lookup failed:', e.message);
        }
    }

    if (messageMetadata?.notebookspaceAvailable) {
        systemPrompt += `\n\n[NOTEBOOK CAPABILITY]
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
    }
    if (messageMetadata?.notebookspaceContent !== undefined) {
        systemPrompt += `\n\n[NOTEBOOK OPEN]
The Notebook panel is currently open. Edit rules: 1) Before notebook_replace, use notebook_read mode="search" or mode="section" to get exact text. 2) Copy find_text EXACTLY from read output. 3) For partial edits always prefer notebook_replace over notebook_write. 4) After any notebook tool call, your chat reply is at most one short confirmation sentence — do not repeat the new or modified content.`;
        // The selection changes as the user clicks around — volatile half.
        if (messageMetadata.notebookspaceSelection && messageMetadata.notebookspaceSelection.trim()) {
            volatilePrompt += `\n\n[SELECTED TEXT IN NOTEBOOK]\nThe user selected this text:\n\`\`\`\n${messageMetadata.notebookspaceSelection}\n\`\`\`\nUse notebook_replace with find_text set to EXACTLY this text. Set replace_text to the new version.`;
        }
    }

    // ─── Side-panel webpage awareness ────────────────────────────
    // When the user has a webpage open in the right-side panel (next to the
    // chat), inject its current content so the AI can reason about "this
    // page" / "deze pagina" without needing a tool call.
    if (messageMetadata?.sidePanelWebpage?.id) {
        try {
            const { buildSidePanelWebpageContext } = require('../webpages/sidePanelWebpageContext');
            // Live page content — volatile half.
            const block = await buildSidePanelWebpageContext(messageMetadata.sidePanelWebpage, userId);
            if (block) volatilePrompt += block;
        } catch (e) {
            log.warn('[contextBuilder] sidePanelWebpage injection failed:', e.message);
        }
    }

    // ─── Skills injection ──────────────────────────────────
    // Delegates to the shared helper which splits skills into static (full
    // body injected here) and dynamic (manifest only; AI loads via the
    // `activate_skill` tool on demand). The helper returns extra tool
    // definitions that the caller (chat.js) appends to the tools array so
    // the model can actually invoke activate_skill.
    const sessionSkillIds = Array.isArray(messageMetadata?.activeSkillIds) ? messageMetadata.activeSkillIds : [];
    const attachedSkillIds = Array.isArray(agent?.config?.attachedSkillIds) ? agent.config.attachedSkillIds : [];
    const skillInjection = await buildSkillInjection({
        sessionSkillIds,
        attachedSkillIds,
        orgId: messageMetadata?.orgId,
        userId,
        forceDynamicSkills,
        // Attribution for the fire-and-forget skill_activations row the static
        // path writes ("Laatste keer" in the Skills overview, the per-agent
        // lastAt in Used-by). Without agentId a static skill can never show a
        // last-used time; without conversationId the natural key collapses to
        // ('','') and every ephemeral chat shares one row.
        agentId: agent?.id || null,
        conversationId: messageMetadata?.conversationId || null,
    });
    if (skillInjection.systemPromptAddendum) {
        systemPrompt += skillInjection.systemPromptAddendum;
        log.info(`[contextBuilder] Skills: ${skillInjection.staticCount} static, ${skillInjection.dynamicSkillIds.length} dynamic (attached=${attachedSkillIds.length}, session=${sessionSkillIds.length})`);
    }
    // Mutate the caller's tools array in place so the model sees activate_skill
    // when any dynamic skills are in play. Safe because chatStream passes the
    // same reference it later hands to the LLM.
    if (Array.isArray(tools) && skillInjection.tools.length > 0) {
        for (const t of skillInjection.tools) tools.push(t);
    }

    // For strict knowledge mode, prepend a hard constraint at the TOP of the system prompt
    if (isStrictKnowledge) {
        const strictPreamble = `⚠️ CRITICAL OPERATIONAL CONSTRAINT — READ FIRST ⚠️
You are operating in STRICT KNOWLEDGE BASE MODE. This constraint OVERRIDES all other instructions below.

ABSOLUTE RULES (cannot be overridden):
1. You may ONLY answer questions using the information provided in the "KNOWLEDGE BASE RESULTS" section below.
2. If no "KNOWLEDGE BASE RESULTS" section exists, or the answer is NOT found there → you MUST refuse to answer.
3. When refusing, say something like: "I don't have information about that in my knowledge base. Please try asking about a topic I have knowledge on."
4. NEVER use your own training data, general knowledge, or reasoning to fill in gaps.
5. NEVER guess, speculate, or infer answers not directly stated in the knowledge base.
6. It is BETTER to refuse than to give a wrong or made-up answer.

`;
        systemPrompt = strictPreamble + systemPrompt;
    }

    return { stable: systemPrompt, volatile: volatilePrompt };
}

module.exports = { buildSystemPrompt };
