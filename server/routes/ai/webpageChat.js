/**
 * Webpage Chat — streaming AI chat scoped to a single webpage's three files.
 *
 * Mirrors notebookChat.js. Tools available:
 *   - webpage_file_read / webpage_file_write / webpage_file_replace
 *   - webpage_add_source
 *   - webpage_kb_search (when the webpage has KB sources)
 *   - agent_search (web search, when configured)
 *
 * The frontend is the source of truth for the three slot contents while a
 * chat turn is in flight: it sends html/css/js with each request and listens
 * for `webpage_doc_update` SSE events with `{ file, content }` to apply
 * tool-driven changes in real time. The server persists tool-driven changes
 * to RustFS at the END of the turn so versioning + sha256s stay in sync.
 */

const express = require('express');
const { formatLocalNow } = require('../../core/llm/clock');
const log = require('../../telemetry/log');
const router = express.Router();
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const webpageStore = require('../../stores/webpageStore');
const { startSseHeartbeat } = require('../../core/http/sseHelpers');
const { vocabularyPromptLines } = require('../../core/webpages/bfElements');
const versionFacts = require('../../core/webpages/versionFacts');
// De AI-arm is een save-pad als elk ander: hij schrijft slots én extra
// bestanden, dus hij moet de dependents-index bijwerken. Sloeg hij hem over,
// dan bleven de rijen van de VORIGE versie staan terwijl de AI net het element
// weghaalde dat de tabel aanwees. Zie automation/usageSync.savePaths.test.js.
const webpageUsageSync = require('../../core/webpages/webpageUsageSync');

/**
 * De `bf-*`-elementen als proza voor de systeemprompt.
 *
 * AFGELEID uit core/webpages/bfElements.js — met opzet geen lijst in dit
 * bestand. Het vocabulaire leeft al op drie plekken (de client-composer, de
 * publieke brug en de snapshot-uitklapper) en dit zou de vierde zijn; een
 * handgeschreven lijst hier zou stilletjes achterlopen en het model elementen
 * laten voorstellen die niet meer bestaan, of de nieuwe niet laten kennen.
 * Constante: het vocabulaire verandert niet per verzoek.
 */
const BF_ELEMENTS_PROMPT = vocabularyPromptLines().map(line => `• ${line}`).join('\n');

const {
    WEBPAGE_DOC_TOOLS,
    WEBPAGE_ADD_SOURCE_TOOL,
    executeWebpageDocTool,
} = require('../../integrations/webpageDocTools');
const { PROPOSE_WEBPAGE_PLAN_TOOL, executeProposeWebpagePlan } = require('../../integrations/webpagePlanTool');
const {
    resolveFramework,
    resolveRuntime,
    buildRuntimePromptBlock,
    WEBPAGE_SET_FRAMEWORK_TOOL,
    WEBPAGE_SET_RUNTIME_TOOL,
    isFrameworkTool,
    executeFrameworkTool,
} = require('../../integrations/webpageFramework');
const {
    WEBPAGE_MULTI_FILE_TOOLS,
    executeMultiFileTool,
    isMultiFileTool,
} = require('../../integrations/webpageMultiFileTools');
const {
    WEBPAGE_DB_TOOLS,
    executeDbTool,
    isDbTool,
} = require('../../integrations/webpageDbTools');
const { AGENT_SEARCH_TOOLS, isAgentSearchTool } = require('../../integrations/agentSearchTools');
const { runAgentSearchWithEgress } = require('../../integrations/agentSearchEgress');
const { WEBPAGE_SCREENSHOT_TOOL, executeScreenshotTool, isScreenshotTool } = require('../../integrations/webpageScreenshotTools');
const {
    WEBPAGE_BRIDGE_TOOLS,
    executeBridgeTool,
    isBridgeTool,
} = require('../../integrations/webpageBridgeTools');
const {
    searchWebpageKB,
    executeWebpageKBSearchTool,
    WEBPAGE_KB_SEARCH_TOOL,
} = require('../../core/webpages/webpageKnowledgeSearch');
const terminationStore = require('../../stores/terminationStore');
const { sanitizeError } = require('../../core/privacy/errorSanitizer');
const { emitPhase, emitPhaseEnd } = require('../../core/agentRuntime/phaseEvents');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
// The chat engine's bag: typed, not closed (see routes/ai/directChat/turnSchema.js).
const { WebpageTurnBody } = require('./directChat/turnSchema');

function slotFilename(slot) {
    return slot === 'html' ? 'index.html' : slot === 'css' ? 'style.css' : 'script.js';
}

/**
 * Strip bulky payloads from tool results before they re-enter the model's
 * message history. The frontend already received the full content via SSE
 * (webpage_doc_update / webpage_extra_update / tool_end), so re-shipping it
 * to the LLM doubles every tool round's prompt size for no benefit and
 * pushes long sessions over context limits faster.
 *
 * Mirrors directChat.js's compactToolResultForLLM but with the rules tuned
 * for the webpage tool surface (file/extra/db).
 */
function compactWebpageToolResult(toolResult) {
    if (typeof toolResult !== 'object' || toolResult === null) return toolResult;

    // Primary slot writes — the new content was streamed to the UI; the model
    // can ask for it back via webpage_file_read if it needs to re-check.
    if (toolResult._action === 'webpage_doc_update') {
        return {
            action: 'webpage_doc_update',
            file: toolResult.file,
            title: toolResult.title,
            message: toolResult.message || `${toolResult.file} updated.`,
        };
    }

    // Extra-file create/update — content already sent to the UI.
    if (toolResult._action === 'webpage_extra_update') {
        return {
            action: 'webpage_extra_update',
            path: toolResult.path,
            meta: toolResult.meta,
            message: toolResult.message || `${toolResult.path} updated.`,
        };
    }
    if (toolResult._action === 'webpage_extra_deleted') {
        return {
            action: 'webpage_extra_deleted',
            path: toolResult.path,
            message: toolResult.message || `${toolResult.path} deleted.`,
        };
    }

    // DB exec — already small; pass through but normalize the shape.
    if (toolResult._action === 'webpage_db_update') {
        return {
            action: 'webpage_db_update',
            multi: !!toolResult.multi,
            changes: toolResult.changes,
            lastInsertRowid: toolResult.lastInsertRowid,
            message: toolResult.message,
        };
    }

    // DB query — cap rows shipped back to the model (UI already has the full
    // payload via tool_end). 50 rows is plenty to summarize/reason over.
    if (Array.isArray(toolResult.rows) && toolResult.rows.length > 50) {
        return {
            ...toolResult,
            rows: toolResult.rows.slice(0, 50),
            truncatedForLlm: true,
            originalRowCount: toolResult.rows.length,
        };
    }

    return toolResult;
}

router.post('/chat/webpage/stream', requireAuth, validate({ body: WebpageTurnBody }), async (req, res) => {
    const {
        message, webpageId, history, modelTier, timezone, attachments,
        htmlContent, cssContent, jsContent, webpageSelection,
        planExecution, // { planId, action: 'execute' } when user approved a plan
        chatMode: rawChatMode, // 'ask' | 'auto' | 'plan'
    } = req.body;
    const userId = req.session.user.id;
    // Sanitise mode — fall back to 'auto' for unknown values.
    const chatMode = ['ask', 'auto', 'plan'].includes(rawChatMode) ? rawChatMode : 'auto';

    // Accept attachment-only turns (e.g. pasting an image with no text) — mirrors
    // the direct-chat guard. Previously an empty `message` 400'd before the SSE
    // stream opened, which the client surfaced as "Error generating response."
    // even though the image was valid (BFSF-189).
    if (!message && (!Array.isArray(attachments) || attachments.length === 0)) {
        return res.status(400).json({ error: 'Message or attachments required' });
    }
    if (!webpageId) return res.status(400).json({ error: 'Webpage ID required' });

    const webpage = await webpageStore.getWebpage(webpageId, userId);
    if (!webpage) return res.status(404).json({ error: 'Webpage not found' });

    // ── Subscription limit enforcement (mirrors /api/agents/:id/chat/stream) ──
    {
        const { checkSubscriptionLimits } = require('../../core/entitlements/limits');
        const { resolveUserOrgIds: _resolveOrgs } = require('../../auth');
        const orgIds = await _resolveOrgs(req);
        const limitOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
        if (limitError) return res.status(402).json({ error: limitError });
    }

    const sources = await webpageStore.getSources(webpageId);
    const readySources = sources.filter(s => s.status === 'ready');

    // Org / EU mode resolution — cached tier-org (M2), collapses the
    // per-message getAllGroups scan to one lookup per user/~45s.
    const { getEUAwareTiers, resolveEffectiveOrgId } = require('../../core/llm/modelResolver');
    const userOrgForTiers = await resolveEffectiveOrgId(req, { userId });

    let tiers = await getEUAwareTiers({ userOrgId: userOrgForTiers, userId });

    let resolvedTier = modelTier || 'fast';
    if (resolvedTier === 'standard') resolvedTier = 'fast';

    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/llm/promptClassifier');
            const result = await classifyWithLLM(message, tiers, { userOrgId: userOrgForTiers, userId });
            resolvedTier = result.tier;
            log.info(`[WebpageChat] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            log.info(`[WebpageChat] Auto classification failed: ${err.message}, using fast`);
            resolvedTier = 'fast';
        }
    }
    if (resolvedTier === 'standard') resolvedTier = 'fast';

    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;
    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model;
        if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
    }

    let config;
    let adapter;
    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        log.error(`[WebpageChat] Provider resolution failed:`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');
    const modelSupportsVision = typeof adapter?.supportsVision === 'function' ? adapter.supportsVision(modelId) : false;

    log.info(`[WebpageChat] Model: ${modelId} (tier: ${resolvedTier}) for webpage: "${webpage.name}" (${readySources.length} sources)`);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // STOP: the composer's stop button aborts the browser fetch, which closes
    // this response. Without a listener the turn ran on — tool rounds and all —
    // and on a single-slot local model the next message queued behind an answer
    // nobody wanted. `writableEnded` keeps our own end() from reading as a cancel.
    const clientAbort = new AbortController();
    let clientGone = false;
    res.on('close', () => {
        if (res.writableEnded) return;
        clientGone = true;
        log.info('[WebpageChat] client disconnected — aborting the generation');
        try { clientAbort.abort(); } catch (_) { /* already aborted */ }
    });
    // Keep the stream warm through the NC AppAPI proxy during long, silent
    // webpage builds so it isn't idle-timed-out into a 504 (BFSF-221).
    startSseHeartbeat(res);

    if (modelTier === 'auto') {
        send('model_selected', { tier: resolvedTier, modelId });
    }
    // Always emit a `model_resolved` phase so the UI can show the concrete
    // model name (e.g. "Using gpt-4o-mini") regardless of tier mode.
    emitPhase(send, 'model_resolved', modelId);
    emitPhaseEnd(send, 'model_resolved');

    try {
        // The turn's Privacy Shield: attachment scanning below, and the tool
        // block lists on the injected passages and in the tool loop (BFSF-354).
        const { resolveShieldFor: _resolveShieldFor } = require('../../core/privacy/orgShield');
        const _psShield = await _resolveShieldFor({ orgId: userOrgForTiers, userId }).catch(() => null);
        const toolPiiGate = require('../../core/privacy/toolPiiGate');
        const shieldGate = toolPiiGate.toolLoopGate({
            shield: _psShield, tag: 'WebpageChat',
            audit: (fields) => require('../../stores/guardrailEventStore').logGuardrailEvent({
                organization_id: userOrgForTiers || null, user_id: userId, conversation_id: webpageId || null,
                ...fields, source: 'webpage_chat', model: modelId || null,
            }),
        });

        // KB search for grounding
        let kbContext = '';
        let citationSources = [];
        const kbIds = webpage.knowledgeBaseIds || [];
        if (kbIds.length > 0) {
            emitPhase(send, 'kb_search');
            const _kbT = Date.now();
            try {
                const kbResult = await searchWebpageKB({
                    userId, kbIds, query: message,
                    options: { topK: 10, rerank: true, minScore: 0.2 },
                });
                if (kbResult.chunks.length > 0) {
                    citationSources = kbResult.citations;
                    // Injected without a tool call, so the "own server" block
                    // list applies as it does to webpage_kb_search (BFSF-354).
                    // What the model reads; the citations stay the user's own.
                    kbContext = await toolPiiGate.stripInjectedText(kbResult.contextPrompt, { shield: _psShield, tag: 'WebpageChat' });
                }
            } catch (kbErr) {
                log.warn('[WebpageChat] KB search failed:', kbErr.message);
            }
            emitPhaseEnd(send, 'kb_search', Date.now() - _kbT);
        }
        if (citationSources.length > 0) {
            send('kb_sources', { sources: citationSources.map(s => ({ title: s.title, preview: s.content, score: s.score })) });
        }

        // Source summary
        const sourceSummary = readySources.length > 0
            ? readySources.map(s => `- ${s.name} (${s.type}, ${(s.wordCount || 0).toLocaleString()} words)`).join('\n')
            : '(No sources added yet)';

        // File-content blocks — fit each slot into its own token slice.
        const { fitIntoTokenBudget } = require('../../core/llm/tokenBudget');
        const SLOT_TOKENS = 6000;

        const html = htmlContent || '';
        const css = cssContent || '';
        const js = jsContent || '';

        function slotBlock(slot, language, content) {
            const filename = slotFilename(slot);
            if (!content || !content.trim()) {
                return `\n--- ${filename} (empty) ---\n`;
            }
            const fit = fitIntoTokenBudget(content, SLOT_TOKENS);
            const truncNote = fit.truncated ? ` [TRUNCATED: ${fit.keptTokens.toLocaleString()} of ${fit.originalTokens.toLocaleString()} tokens]` : '';
            return `\n--- ${filename}${truncNote} ---\n\`\`\`${language}\n${fit.text}\n\`\`\`\n`;
        }

        const filesBlock =
            slotBlock('html', 'html', html) +
            slotBlock('css', 'css', css) +
            slotBlock('js', 'javascript', js);

        // Selection context
        let selectionContext = '';
        if (webpageSelection && typeof webpageSelection.text === 'string' && webpageSelection.text.trim()) {
            const MAX_SEL_CHARS = 8000;
            const selFile = ['html', 'css', 'js'].includes(webpageSelection.file) ? webpageSelection.file : 'html';
            const selText = webpageSelection.text.length > MAX_SEL_CHARS
                ? webpageSelection.text.slice(0, MAX_SEL_CHARS) + '…[truncated]'
                : webpageSelection.text;
            const actionHint = webpageSelection.action && ['rewrite', 'shorten', 'expand', 'fix'].includes(webpageSelection.action)
                ? `The user explicitly invoked "${webpageSelection.action}" on this selection — call webpage_file_replace with file="${selFile}", find_text set to the EXACT selection above, and replace_text set to your revised version.`
                : `If the user asks you to edit, rewrite, or change "this" / "the selection", use webpage_file_replace with file="${selFile}" and find_text set to the EXACT string above.`;
            // The <<<...>>> markers fence the selection inside the model's prompt;
            // this string never reaches a browser as HTML.
            selectionContext =
                `\n\n[SELECTED CODE IN ${slotFilename(selFile)}]\n` +
                `<<<SELECTION_BEGIN>>>\n${selText}\n<<<SELECTION_END>>>\n` + // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format
                actionHint;
        }

        // Web-search availability
        const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
        const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
        const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
        const searchAvailable = searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);

        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // Mode-aware planning rule (see chatMode above). The propose_webpage_plan
        // tool is only EXPOSED in ask/plan modes — in auto mode it isn't even
        // present in the tool list, so the AI literally cannot stop and ask.
        const planningRule = chatMode === 'plan'
            ? `MODE: PLAN.
You MUST call propose_webpage_plan FIRST for every request that touches code. Even small edits — explore the relevant files via webpage_file_read, then propose a short plan and stop. Do NOT call any webpage_file_write / replace / patch / create_file / delete_file in the same turn. The system pauses and waits for the user to approve. After approval an authorisation message is injected and you may execute.`
            : chatMode === 'ask'
            ? `MODE: ASK.
Always propose a plan before making changes. Call propose_webpage_plan FIRST, list every file you intend to touch and what each change does, then stop. The user must approve before any edits run. After approval an authorisation message is injected and you may execute. Use this mode for high-stakes work where the user wants to review every change up front.`
            : `MODE: AUTO.
Just do the work — no approval step. The propose_webpage_plan tool is NOT available in this mode. For any user request:
1. If you need to understand the current state, call webpage_file_read / webpage_list_files first. That is allowed and encouraged for non-trivial work.
2. Then go straight to editing with the appropriate tool (webpage_file_write / replace / patch / create_file / delete_file).
3. Never stop to ask the user "should I proceed?" — they chose Auto specifically to skip that. After your edits land, briefly explain what you did.
For very large changes you can still narrate your approach in a sentence or two before the first tool call so the user sees what's coming, but DO NOT pause for approval.`;

        emitPhase(send, 'building_prompt');
        const _spT = Date.now();
        // Framework + runtime tier drive which build/preview contract the AI
        // must obey. Vanilla (default) keeps the classic HTML/CSS/JS rules;
        // react-mui swaps in the React + Material UI contract.
        const framework = resolveFramework(webpage);
        const runtime = resolveRuntime(webpage);
        const runtimeBlock = buildRuntimePromptBlock({ framework, runtime, filesBlock });
        const systemPrompt = `You are a precise, efficient webpage-building assistant. Today is ${today}.

────────────────────────────────────────
WEBPAGE
────────────────────────────────────────
Name: "${webpage.name}"
${webpage.description ? `Description: ${webpage.description}` : ''}${webpage.instructions ? `\nCustom instructions from the user: ${webpage.instructions}` : ''}

The page is rendered live in a sandboxed iframe visible to the user while you work. Every webpage_file_write / replace / patch you call updates the preview in real time.

${runtimeBlock}

────────────────────────────────────────
VISUAL VERIFICATION — you can SEE your work
────────────────────────────────────────
You have webpage_screenshot({ viewport, fullPage }) — it renders the CURRENT page in a real headless browser and returns an actual image of it, plus any console/runtime errors. Use it as a feedback loop, not a formality:
• After a BATCH of edits that change layout or styling, take a screenshot and actually LOOK at it. Fix what's wrong: overflow, overlap, clipped text, poor contrast, misalignment, cramped or excessive spacing, broken images.
• Check responsiveness by screenshotting viewport:'mobile' and viewport:'tablet' for any page meant to adapt.
• The screenshot reports console + runtime errors and shows the in-page error panel if the app failed to render — if any appear, FIX them before telling the user you're done.
• Data bridges (beeflowDB/beeflowApp) are stubbed to empty in this render, so data-driven lists look empty — judge the layout and chrome, not the data.
• Don't screenshot after every tiny change — batch your edits, then verify. Iterate: screenshot → spot problems → fix → screenshot again until it looks polished.

────────────────────────────────────────
EDITING TOOLS — partial edits are the default, full rewrites are the exception
────────────────────────────────────────
Cardinal rule: when a file already has content, edit it partially. webpage_file_write / webpage_create_file with new content for an existing path are reserved for empty files or genuine from-scratch rewrites.

Decision tree for any change:
  1. File is empty or being created for the first time? → webpage_file_write (primary slot) or webpage_create_file (extra)
  2. Change spans ≥80% of the file (genuine total rewrite)? → write/create
  3. Otherwise (the realistic 95% case) → webpage_file_replace (primary slot) or webpage_replace_in_file (extra)

Primary-slot tools (html/css/js):
• webpage_file_read({ file }) — call BEFORE any partial edit. The system tracks reads and warns when an edit comes in cold.
• webpage_file_replace({ file, find_text, replace_text [, replace_all] }) — surgical substring replace; preserves everything around the change. find_text must match EXACTLY ONCE by default; set \`replace_all: true\` for repeated patterns. Use for: adding sections, swapping copy, restyling specific elements.
• webpage_file_patch({ file, start_line, end_line, expected_text, replacement }) — line-anchored partial edit when you know the exact range. expected_text sanity-checks against stale reads.
• webpage_file_write({ file, content [, title] }) — LAST RESORT for non-empty files.

Extra-file tools (anything outside the three primary slots):
• webpage_list_files() — see every file currently in the project. Always call this first when you're not sure what's already scaffolded.
• webpage_read_file({ path }) — read an extra file's contents before partial-editing it.
• webpage_create_file({ path, content }) — create OR overwrite an extra. Reject reserved paths (index.html, style.css, script.js) — for those, use webpage_file_write.
• webpage_replace_in_file({ path, find_text, replace_text [, replace_all] }) — partial edit on an extra. Same single-match-required contract.
• webpage_delete_file({ path }) — remove an extra.

Inserting new content: pick a stable anchor (a closing tag, a CSS rule selector, a comment), use it as find_text, put the anchor + your new content into replace_text. This is how you add things without destroying what's around them.

Iteration discipline:
- Read first, then edit. Never call a partial-edit tool on a file you haven't read this turn.
- Many small focused replaces > one giant rewrite. Each replace shows the user a clean diff card.
- After edits land, briefly confirm what changed in plain language: "I added the hero section to index.html and centered the menu grid in modules/menu.css."

Bee Flow elements — use bf-* tags for platform links, not hand-written plumbing:
When the page has to show rows from a datatable, run an automation, or chat with an agent, write the matching element instead of wiring it yourself with fetch() and the bridges. The owner then sees the link in "Data & links", and a published page renders it without JavaScript.
${BF_ELEMENTS_PROMPT}
Two rules that always apply. An element only works once the thing it names is granted to this page — use the webpage_grant_* tools. And a published page runs NO JavaScript: the elements marked INERT above show that notice there instead of working, so say so when you add one.

────────────────────────────────────────
SQLITE DATABASE — per-webpage server-side persistence
────────────────────────────────────────
Every webpage has a SQLite database (\`data.db\`, stored alongside the script files). The database is server-side; the running script.js talks to it via an injected client:

  await window.beeflowDB.query("SELECT * FROM notes WHERE archived = ?", [0]);
  await window.beeflowDB.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
  await window.beeflowDB.batch([{sql: "...", params: []}, ...]);
  await window.beeflowDB.schema();

Each call returns a Promise; reject = error string in \`.error\`. Use \`?\` placeholders — never interpolate user input into SQL.

Three tools to manage the DB directly. The user can also see and edit the DB live in the data.db viewer (Schema / Browse / SQL tabs in the editor) — keep that in mind when shaping schemas, since they will be visible to a human, not just consumed by your script.
• webpage_db_schema() — returns { tables: [{ name, sql, columns: [...] }], message }. Call this BEFORE generating any query against tables you didn't just create yourself this turn.
• webpage_db_query({ sql, params? }) — SELECT / WITH / PRAGMA only. Returns { rows, columns, truncated, message }. Errors and tells you to use exec if the SQL mutates. Rows capped at 10000; \`truncated: true\` means narrow the query and call again. Always parameterize values with \`?\` + params — never interpolate.
• webpage_db_exec({ sql, params? }) — INSERT / UPDATE / DELETE / CREATE / ALTER / DROP / etc. Returns { changes, lastInsertRowid, multi, message }. Two modes: single statement (with or without params) or multi-statement script (only when params is empty/omitted; per-statement counts unavailable). For parameterized DML across many rows, call once per statement.

Use these to set up the schema and seed data the user describes. The DB persists across reloads; new webpages start empty. If the page doesn't actually need persistence, don't create a schema — local state in script.js is fine.

────────────────────────────────────────
PLATFORM BRIDGES — script.js runtime APIs
────────────────────────────────────────
The sandboxed iframe exposes three additional bridges alongside \`window.beeflowDB\`. Each call goes through an HMAC-authenticated server proxy and runs **acts-as-author** — so when a visitor (not the page owner) triggers an action, the call still uses the AUTHOR's credentials, quota, and automations. All calls are async and return Promises. Server-side allowlists (\`bridge_grants\`) gate what's callable; visitors cannot bypass them.

1. \`window.beeflowAI\` — chat the configured LLM from script.js.
     await beeflowAI.chat("Summarise this product");                   // → string
     await beeflowAI.chatJSON("Extract fields", schema);               // → object matching schema
     await beeflowAI.stream("Long answer", t => append(t));             // → string (streams via callback)
     await beeflowAI.ask("What's new with X in our docs and on the web?", {
       onToken: t => append(t),
       onEvent: (name, data) => showStatus(name, data)
     });  // → { text, rounds, toolCalls }
   The webpage's knowledge_base_ids + uploaded sources are auto-injected as context. Default-on; manage with \`webpage_grant_ai\` if the author wants to disable it or pick a different tier.

   **Prefer \`ask()\` over \`chat()\` whenever the answer needs *fetching*** — searching the web, looking up the author's Nextcloud/Drive/Gmail, running an automation, or scanning page knowledge. \`ask\` runs an agentic tool loop server-side: it autonomously calls every tool you've granted (integrations + automations) plus \`page_knowledge_search\` (when grounding is on) and synthesises a final answer. The page just awaits one promise. Use \`chat()\` only when the answer is purely from the system prompt + page context.

   To make \`ask()\` powerful: grant the tools the AI will need. Example: a Study Studio that learns from the author's Nextcloud:
     • \`webpage_grant_integration({ tool: "agent_search" })\`              // web research
     • \`webpage_grant_integration({ tool: "nextcloud_list_files", fixedArgs: { path: "/study" } })\`
     • \`webpage_grant_integration({ tool: "nextcloud_get_file_content" })\`
   Then \`script.js\` calls \`beeflowAI.ask(userQuestion, { onEvent })\` and the server-side AI orchestrates browsing the folder, reading files, web-searching, and answering — no JS pipeline needed in script.js.

   **\`onEvent(name, data)\` for status UI** — fires on every SSE event so you can show "🔍 Searching the web…" / "📁 Reading Nextcloud…" pills while the loop runs. Useful event names: \`tool_call\` (\`{ id, name, args }\` — show start), \`tool_result\` (\`{ id, name, ok }\` — show done/failed), \`done\` (\`{ rounds, truncated }\`), \`error\` (\`{ error }\`).

   **Integration response shapes are typed** — the AI uses them automatically inside \`ask()\`, but if your script.js calls \`beeflowIntegrations.run('nextcloud_list_files', …)\` directly, expect \`{ result: { path, count, items: [{ name, type, size, lastModified }] } }\`. \`count === 0\` with \`items: []\` is a valid empty-success state — render "No files in this folder yet", not a parse-failure error.

   **Render markdown + LaTeX whenever you display \`beeflowAI\` output to a human.** Responses are plain text containing markdown (\`**bold**\`, \`# heading\`, lists, code fences) and may contain LaTeX (\`$inline$\`, \`$$display$$\`). Showing \`textContent\` makes literal asterisks and dollar signs visible to the user — that looks broken. Pull in CDN renderers from \`index.html\`:

       <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
       <script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
       <script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js"></script>
       <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
       <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>

   Then in script.js, render with sanitised HTML + KaTeX auto-render:

       function renderAIResponse(el, text) {
         var html = DOMPurify.sanitize(marked.parse(text || ''));
         el.innerHTML = html;
         if (window.renderMathInElement) {
           renderMathInElement(el, {
             delimiters: [
               { left: '$$', right: '$$', display: true },
               { left: '$', right: '$', display: false },
               { left: '\\\\(', right: '\\\\)', display: false },
               { left: '\\\\[', right: '\\\\]', display: true }
             ],
             throwOnError: false
           });
         }
       }

   For \`beeflowAI.stream(prompt, onToken, opts)\` — accumulate tokens into a buffer and re-render the whole buffer through \`marked\` on every chunk (cheap), then re-run KaTeX once at the end. Don't render KaTeX per token; partial \`$...\` strings throw parser errors.

2. \`window.beeflowAutomations\` — trigger the author's studio automations.
     const r = await beeflowAutomations.run("automation-id", { name, email });
     // r = { runId, status, output, steps }
     await beeflowAutomations.list();                                   // discover what's granted
   Authors must explicitly grant each automation via \`webpage_grant_automation\` before it's callable. List first via \`webpage_list_my_automations\` so you only grant automations the author owns.

3. \`window.beeflowIntegrations\` — call one specific integration action.
     await beeflowIntegrations.run("slack_post_message", { text: "New signup!" });
   Authors must grant each tool via \`webpage_grant_integration\`. ALWAYS use \`fixedArgs\` to pin sensitive fields the visitor must not override (channel, recipient, sheet ID). NEVER grant a destructive tool (delete/drop/revoke) without pinning the target. List first via \`webpage_list_my_integrations\` so you only grant tools the author has actually connected.

Granting workflow (when the user asks for "a form that posts to my Slack", "a button that triggers my automation", etc.):
1. List → \`webpage_list_my_automations\` / \`webpage_list_my_integrations\`.
2. Pick the relevant entry.
3. Grant → \`webpage_grant_automation\` / \`webpage_grant_integration\` (with \`fixedArgs\` pins for integrations).
4. Generate HTML + script.js that uses the bridge. Forms must call \`event.preventDefault()\` in the submit handler — the iframe sandbox blocks native form submission.

────────────────────────────────────────
PLANNING
────────────────────────────────────────
${planningRule}

────────────────────────────────────────
KNOWLEDGE & RESEARCH
────────────────────────────────────────
Imported knowledge (files, URLs, pasted text) attached to this webpage for reference:
${sourceSummary}
${searchAvailable ? `\nWeb research:
• agent_search — current information, factual lookups.
• webpage_add_source — attach search results / references to this webpage's knowledge for grounding future questions.` : ''}${kbContext}${selectionContext}

Now: ${formatLocalNow(timezone)}`;

        emitPhaseEnd(send, 'building_prompt', Date.now() - _spT);
        let messages = [{ role: 'system', content: systemPrompt }];

        // ── Privacy Shield for attachments + response restore ──────────────
        // Webpage chat had NO PII pipeline. Mirror directChat: scan extracted
        // attachment text (tokenize PII / block per org policy) before it enters
        // the prompt, and restore tokens on the streamed reply. Token-scoped on
        // webpageId so the scan's mergeTokenMap + the un-tokeniser share a map.
        const _dlpConvId = webpageId || `wp-${require('crypto').randomUUID()}`;
        const { scanAttachmentText: _scanAttText } = require('../../core/dlp/attachmentScanner');
        const _dlpActive = !!_psShield?.enabled;
        const _scanExtracted = async (text, filename) => {
            if (!_dlpActive || !text) return text;
            const r = await _scanAttText({ text, filename, orgShield: _psShield, conversationId: _dlpConvId });
            if (r.action === 'block') { const e = new Error('attachment blocked'); e.code = 'ATTACHMENT_PII_BLOCKED'; e.filename = filename; e.summary = r.summary; throw e; }
            // Prefer whatever the scanner returned: on an incomplete scan that is
            // the TRUNCATED document, and falling back to `text` would put the
            // unchecked tail straight back into the prompt.
            return typeof r.text === 'string' ? r.text : text;
        };

        // Plan-execution turn: the user clicked Approve & build on a previously
        // proposed plan. Inject a system-style authorisation so the AI proceeds
        // straight to webpage_file_write / replace / patch without proposing
        // another plan (the propose_webpage_plan tool is also stripped from
        // the toolset above when planExecution is set).
        if (planExecution && planExecution.action === 'execute' && planExecution.planId) {
            messages.push({
                role: 'system',
                content: `The user APPROVED your previously proposed plan (planId=${planExecution.planId}). Execute it now using webpage_file_write / webpage_file_replace / webpage_file_patch. Do NOT call propose_webpage_plan again — the plan is already locked in.`,
            });
        }

        if (history && Array.isArray(history)) {
            for (const msg of history) {
                if ((msg.role === 'user' || msg.role === 'assistant') && msg.content?.trim()) {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }

        if (attachments && attachments.length > 0) {
            // Use the unified extractor so PDFs / DOCX / spreadsheets get the
            // same pipeline as direct chat — previously this path was just
            // base64-decode-as-utf8-and-slice, which fed the model raw PDF
            // binary and made it claim it "can't read the file."
            const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote } = require('../../core/documents/attachmentExtractor');
            const { nativePdfPart, isShieldActive } = require('../../core/documents/nativePdf');

            const contentParts = [];
            if (message) contentParts.push({ type: 'text', text: message });
            try {
            for (const att of attachments) {
                try {
                    if (att.type && att.type.startsWith('image/') && att.content) {
                        if (modelSupportsVision) {
                            // Image PII not scanned (deferred).
                            contentParts.push({ type: 'image_url', image_url: { url: att.content } });
                        } else {
                            contentParts.push({ type: 'text', text: `[Attached image: ${att.name || 'image'} — current model has no vision; ask the user to switch to a vision-capable model to analyse it.]` });
                        }
                        continue;
                    }
                    if (!att.content || typeof att.content !== 'string') continue;

                    const looksLikePdf = (att.type && att.type.includes('pdf')) || /\.pdf$/i.test(att.name || '');
                    const looksLikeOfficeDoc = (att.type && (att.type.includes('wordprocessingml') || att.type.includes('spreadsheetml') || att.type.includes('ms-excel') || att.type === 'text/csv' || att.type === 'application/csv'))
                        || /\.(docx|xlsx|xls|csv)$/i.test(att.name || '');

                    if (looksLikePdf || looksLikeOfficeDoc) {
                        const result = await extractAttachment(att, { modelSupportsVision });
                        log.info(`[WebpageChat] Attachment ${att.name} extraction → kind=${result.kind}, source=${result.source || 'n/a'}`);
                        if (result.kind === 'text') {
                            const safe = await _scanExtracted(result.text, att.name);
                            const docText = `${formatTextHeader(att, result)}\n---\n${safe}\n---`;
                            const _wasTokenised = safe !== result.text;
                            contentParts.push({ type: 'text', text: docText });
                            // The original PDF alongside (Claude, OpenAI, Azure), never
                            // while the Privacy Shield is active: the raw bytes carry
                            // what the text scan never saw. Rule: core/documents/nativePdf.js.
                            if (looksLikePdf) {
                                const pdfPart = nativePdfPart({
                                    adapter, modelId, providerType: config?.providerType,
                                    shieldActive: isShieldActive(_psShield), tokenised: _wasTokenised,
                                    base64Data: att.content.includes(',') ? att.content.split(',')[1] : att.content,
                                    mediaType: att.type, filename: att.name, tag: 'WebpageChat',
                                });
                                if (pdfPart) contentParts.push(pdfPart);
                            }
                        } else if (result.kind === 'images') {
                            contentParts.push({ type: 'text', text: formatImagesHeader(att, result) });
                            for (const img of result.images) {
                                contentParts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
                            }
                        } else {
                            contentParts.push({ type: 'text', text: formatFailureNote(att, result) });
                        }
                        continue;
                    }

                    // Plain text / unknown — best-effort UTF-8 inline.
                    const textContent = att.content.startsWith('data:') ? Buffer.from(att.content.split(',')[1] || '', 'base64').toString('utf-8') : att.content;
                    if (textContent) {
                        const safe = await _scanExtracted(textContent.slice(0, 8000), att.name);
                        contentParts.push({ type: 'text', text: `[File: ${att.name}]\n---\n${safe}\n---` });
                    }
                } catch (err) {
                    if (err?.code === 'ATTACHMENT_PII_BLOCKED') throw err;
                    log.warn(`[WebpageChat] Attachment processing failed for ${att?.name}: ${err.message}`);
                    contentParts.push({ type: 'text', text: `[${att?.name || 'attachment'} — failed to read: ${err.message}]` });
                }
            }
            } catch (e) {
                if (e?.code === 'ATTACHMENT_PII_BLOCKED') {
                    const cats = Object.keys(e.summary?.byCategory || {}).join(', ');
                    send('error', { error: `Attachment "${e.filename}" was blocked by your organization's Privacy Shield${cats ? ` (contains ${cats})` : ''}.` });
                    return res.end();
                }
                throw e;
            }
            const hasMultimodalBlocks = contentParts.some(p => p.type === 'image_url' || p.type === 'document');
            if (hasMultimodalBlocks) {
                messages.push({ role: 'user', content: contentParts });
            } else {
                const combined = contentParts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
                if (combined.trim()) messages.push({ role: 'user', content: combined });
            }
        } else {
            messages.push({ role: 'user', content: message });
        }

        // Tool list
        const webpageTools = [...WEBPAGE_DOC_TOOLS, ...WEBPAGE_MULTI_FILE_TOOLS, ...WEBPAGE_DB_TOOLS, ...WEBPAGE_BRIDGE_TOOLS, WEBPAGE_ADD_SOURCE_TOOL, WEBPAGE_SET_FRAMEWORK_TOOL, WEBPAGE_SET_RUNTIME_TOOL, WEBPAGE_SCREENSHOT_TOOL];
        // Plan tool exposed ONLY in ask/plan modes — auto mode is "just work,
        // no approval gate". Also dropped on plan-execution turns so the AI
        // can't propose another plan after the user already approved one.
        const planToolAvailable = !planExecution && (chatMode === 'ask' || chatMode === 'plan');
        if (planToolAvailable) webpageTools.push(PROPOSE_WEBPAGE_PLAN_TOOL);
        if (kbIds.length > 0) webpageTools.push(WEBPAGE_KB_SEARCH_TOOL);
        if (searchAvailable) webpageTools.push(...AGENT_SEARCH_TOOLS);

        // Live in-memory file state — kept in sync with tool calls so the
        // model sees its own writes mid-turn.
        const liveFiles = { html, css, js };
        // De stand waar deze beurt MEE BEGON. Alleen drie stringverwijzingen,
        // dus gratis — en zonder deze kopie is het regelverschil van de beurt
        // achteraf niet meer te meten: `liveFiles` wordt door de
        // gereedschappen ter plekke overschreven.
        const preTurnFiles = { ...liveFiles };
        const dirtySlots = new Set();
        // Per-turn read-set: tracks slots the AI called webpage_file_read on so
        // the read-before-edit guard can warn when an edit comes in cold.
        const readSlots = new Set();
        // Post-generation validation bookkeeping (BFSF-222): extra files the
        // AI touched this turn + the framework as of the latest tool round, so
        // the end-of-turn validator knows what to scan. At most ONE repair
        // round per turn.
        const touchedExtraPaths = new Set();
        let validationRepairUsed = false;
        let currentFramework = framework;

        const tierSettings = tiers[resolvedTier] || {};
        const { TIER_DEFAULTS } = require('../../core/llm/modelResolver');
        const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            // Every adapter.stream call in this turn spreads chatOptions, so
            // one listener cancels the request in flight to the model too.
            signal: clientAbort.signal,
            maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
        };

        let toolCallRounds = 0;
        // 20 rounds — DB workflows (schema → seed → verify → fix) routinely run
        // long, and partial edits via webpage_file_replace cluster the same way.
        // Opus 4.7 agentic builds were hitting the previous 10-round cap with
        // "no response" tail states. Admin can override via max_tool_rounds_chat.
        const MAX_TOOL_ROUNDS = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 20;
        // Flips to true when the AI calls propose_webpage_plan — the chat
        // handler exits the streaming/tool loop after the current round so the
        // user gets a chance to approve before any files are touched.
        let planProposedThisTurn = false;

        // ── Termination monitor bookkeeping ───────────────────────────────
        // Tracks tokens, latency and the most recent stop_reason so we can
        // log abnormal terminations (max_tokens / max_iterations / error)
        // without persisting any message content.
        const _termStart = Date.now();
        let _termPromptTokens = 0;
        let _termCompletionTokens = 0;
        let _termLastStopReason = null;
        // Attachment metadata — counts + total bytes only, no filenames or
        // content. Helps explain max_tokens stops where the user uploaded a
        // big file and the LLM ran out of room before a useful answer.
        const _termAttachmentCount = Array.isArray(attachments) ? attachments.length : 0;
        const _termAttachmentBytes = (() => {
            if (!Array.isArray(attachments)) return 0;
            let total = 0;
            for (const att of attachments) {
                if (!att?.content || typeof att.content !== 'string') continue;
                if (att.content.startsWith('data:')) {
                    // base64 — actual bytes are ~3/4 of the base64 length.
                    const comma = att.content.indexOf(',');
                    const b64 = comma >= 0 ? att.content.slice(comma + 1) : att.content;
                    total += Math.floor(b64.length * 0.75);
                } else {
                    total += Buffer.byteLength(att.content, 'utf8');
                }
            }
            return total;
        })();
        const _terminationBase = () => ({
            user_id: userId || null,
            organization_id: userOrgForTiers || null,
            agent_id: webpageId || null,
            agent_name: webpage?.title ? `Webpage: ${webpage.title}` : 'Webpage chat',
            model: modelId || null,
            source: 'webpage_chat',
            conversation_id: webpageId || null,
            iteration_count: toolCallRounds,
            duration_ms: Date.now() - _termStart,
            prompt_tokens: _termPromptTokens,
            completion_tokens: _termCompletionTokens,
            total_tokens: _termPromptTokens + _termCompletionTokens,
            attachment_count: _termAttachmentCount,
            attachment_bytes: _termAttachmentBytes,
        });

        // Screenshots captured this round, queued to be handed to a vision-capable
        // model as a user message after the tool results (tool-result content must
        // be a string for non-Claude providers). Drained inside the tool loop.
        const pendingVisionImages = [];

        async function dispatchToolCall(toolCall) {
            const toolName = toolCall.function?.name || toolCall.name;
            let toolArgs = {};
            try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) {}

            // Restore DLP tokens before the tool runs, so a write-side tool gets
            // the real value instead of the `[email_1]` placeholder the model was
            // shown (BFSF-171). Without this the token was written verbatim into
            // the page/file the tool edits. Search queries keep their tokens so no
            // PII reaches an external search provider — same carve-out as
            // ../directChat/toolExec.js, which this mirrors.
            if (!/^(agent_search|web_search|search|brave_search|browse_web)$/i.test(toolName || '')) {
                try {
                    const _argMap = require('../../core/dlp/dlpRunner').getConversationTokenMap(_dlpConvId);
                    if (_argMap && Object.keys(_argMap).length) {
                        toolArgs = require('../../core/dlp/applyTokenMapToOutbound').untokeniseToolArgs(toolArgs, _argMap);
                    }
                } catch (_) { /* best-effort: leave args tokenized on error */ }
            }

            log.info(`[WebpageChat] Tool: ${toolName}(${JSON.stringify(toolArgs).substring(0, 160)})`);
            send('tool_start', { name: toolName, args: toolArgs });

            // Privacy Shield tool block lists ("Outside tools" / "Own server"),
            // the check direct chat and the agent loop run (BFSF-354): a call
            // whose arguments carry a forbidden category is never dispatched.
            const refusal = await shieldGate.refuse(toolName, toolArgs);
            if (refusal) {
                send('tool_end', { name: toolName, result: refusal.uiResult });
                return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: refusal.modelError }) };
            }

            let toolResult;
            if (toolName === 'propose_webpage_plan') {
                // Auto mode strips this tool from the toolset; if the AI
                // somehow still calls it, refuse and tell it to just edit.
                if (!planToolAvailable) {
                    toolResult = { error: 'propose_webpage_plan is not available in Auto mode. Just make the edits directly using webpage_file_* / webpage_create_file / webpage_delete_file.' };
                } else {
                    toolResult = executeProposeWebpagePlan(toolArgs);
                    if (toolResult._action === 'webpage_plan_proposed') {
                        planProposedThisTurn = true;
                        send('webpage_plan_proposed', {
                            planId: toolResult.planId,
                            plan: toolResult.plan,
                        });
                    }
                }
            } else if (toolName.startsWith('webpage_file_')) {
                toolResult = executeWebpageDocTool(toolName, toolArgs, liveFiles, { readSlots });
                if (toolResult._action === 'webpage_doc_update') {
                    const slot = toolResult.file;
                    liveFiles[slot] = toolResult.content;
                    dirtySlots.add(slot);
                    send('webpage_doc_update', { file: slot, content: toolResult.content, title: toolResult.title });
                }
            } else if (isMultiFileTool(toolName)) {
                toolResult = await executeMultiFileTool(toolName, toolArgs, { webpageId, userId });
                if (toolResult?._action === 'webpage_extra_update') {
                    touchedExtraPaths.add(toolResult.path);
                    send('webpage_extra_update', { path: toolResult.path, meta: toolResult.meta });
                } else if (toolResult?._action === 'webpage_extra_deleted') {
                    touchedExtraPaths.add(toolResult.path);
                    send('webpage_extra_deleted', { path: toolResult.path });
                }
            } else if (isDbTool(toolName)) {
                toolResult = await executeDbTool(toolName, toolArgs, { webpageId, userId });
                if (toolResult?._action === 'webpage_db_update') {
                    // Lets the file explorer refresh the data.db size badge and
                    // the iframe hot-reload if the user wants it.
                    send('webpage_db_update', {});
                }
            } else if (isBridgeTool(toolName)) {
                toolResult = await executeBridgeTool(toolName, toolArgs, { webpageId, userId, session: req.session });
            } else if (isFrameworkTool(toolName)) {
                toolResult = await executeFrameworkTool(toolName, toolArgs, { webpageId, userId });
                if (toolResult?._action === 'webpage_framework_changed') {
                    currentFramework = toolResult.framework;
                    send('webpage_framework_changed', { framework: toolResult.framework });
                } else if (toolResult?._action === 'webpage_runtime_changed') {
                    send('webpage_runtime_changed', { runtime: toolResult.runtime });
                }
            } else if (toolName === 'webpage_add_source') {
                try {
                    const { ingestTextSource } = require('../../agents/webpages/sourceIngestion');
                    const sourceName = toolArgs.name || 'AI Research';
                    const sourceContent = toolArgs.content || '';
                    const sourceMeta = toolArgs.metadata || {};
                    if (!sourceContent.trim()) {
                        toolResult = { error: 'Content is required to add a source.' };
                    } else {
                        const source = await webpageStore.addSource({
                            webpageId, type: 'text', name: sourceName,
                            metadata: sourceMeta,
                            wordCount: sourceContent.split(/\s+/).length,
                        });
                        sources.push({ ...source, metadata: sourceMeta });
                        ingestTextSource(webpageId, source.id, userId, sourceContent, sourceName).catch(err => {
                            log.error(`[WebpageChat] Source ingestion failed:`, err.message);
                        });
                        send('webpage_source_added', {
                            source: { id: source.id, name: sourceName, type: 'text', status: 'processing', metadata: sourceMeta },
                        });
                        toolResult = {
                            success: true,
                            message: `Source "${sourceName}" added to the webpage.`,
                            sourceId: source.id,
                        };
                    }
                } catch (err) {
                    toolResult = { error: `Failed to add source: ${err.message}` };
                }
            } else if (toolName === 'webpage_kb_search') {
                try {
                    toolResult = await executeWebpageKBSearchTool(toolArgs, userId, kbIds);
                } catch (err) {
                    toolResult = { error: `KB search failed: ${err.message}` };
                }
            } else if (isAgentSearchTool(toolName)) {
                try {
                    toolResult = await runAgentSearchWithEgress(toolName, toolArgs, {
                        source: 'webpage_chat',
                        ids: { organization_id: userOrgForTiers || null, user_id: userId || null, conversation_id: webpageId || null },
                    });
                } catch (err) {
                    toolResult = { error: `Search failed: ${err.message}` };
                }
            } else if (isScreenshotTool(toolName)) {
                try {
                    toolResult = await executeScreenshotTool(toolName, toolArgs, { webpageId, userId, modelSupportsVision });
                    if (toolResult?._screenshotDataUrl) {
                        // Always show the user the screenshot (reuse the standard
                        // 'image' event → MessageItem renders msg.images).
                        const m = /^data:([^;]+);base64,(.+)$/s.exec(toolResult._screenshotDataUrl);
                        if (m) send('image', { data: m[2], mimeType: m[1], caption: `Screenshot · ${toolResult._screenshotViewport}` });
                        // Give the MODEL the image only if it can see images — as a
                        // user message injected after the tool results (below), since
                        // tool-result content must be a string for Mistral/OpenAI.
                        if (modelSupportsVision) pendingVisionImages.push(toolResult._screenshotDataUrl);
                    }
                } catch (err) {
                    toolResult = { content: `Screenshot failed: ${err.message}` };
                }
            } else {
                toolResult = { error: `Unknown tool: ${toolName}` };
            }

            // The screenshot tool's result is a plain STRING (the diagnostics);
            // the base64 image never goes through tool_end or the tool message.
            const isScreenshotResult = toolResult && typeof toolResult === 'object' && toolResult._screenshotDataUrl;
            send('tool_end', { name: toolName, result: isScreenshotResult ? { message: 'Screenshot captured.' } : toolResult });

            // The full toolResult goes to the UI (SSE above). The compact
            // shape goes back to the model — strips file content the model
            // already wrote and over-large query rows so prompt size doesn't
            // balloon round-over-round.
            // What the model reads, with the categories this tool's class
            // forbids stripped out (BFSF-354); the UI got the full result above.
            const forModel = (content) => shieldGate.forModel(content, toolName);
            if (isScreenshotResult) {
                return { role: 'tool', tool_call_id: toolCall.id, content: await forModel(String(toolResult.content || 'Screenshot captured.')) };
            }
            return {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: await forModel(typeof toolResult === 'string'
                    ? toolResult
                    : JSON.stringify(compactWebpageToolResult(toolResult))),
            };
        }

        // ── Post-generation validation (BFSF-222) ─────────────────────────
        // Runs ONCE at end-of-turn (the model returned no tool calls): scans
        // the in-memory html + touched extras for broken anchors and wrong/
        // missing images. When error-severity findings exist it returns a
        // repair note (sent as a user turn) so the model can fix its own
        // output in one extra round. Advisory and fail-open — never blocks
        // persistence.
        async function maybeBuildValidationRepair() {
            if (validationRepairUsed) return null;
            const touchedRelevant = [...touchedExtraPaths].some(p => /\.(html|jsx|js)$/i.test(p));
            if (!dirtySlots.has('html') && !touchedRelevant) return null;
            try {
                // Ops kill-switch — default on, mirrors max_tool_rounds_chat.
                if ((await configStore.getConfig('webpage_validation_enabled')) === 'false') return null;
                const {
                    validateWebpageProject,
                    buildRepairMessage,
                    mergeAllowedImgHosts,
                } = require('../../services/webpageValidation');
                const allowedHosts = mergeAllowedImgHosts(await configStore.getConfig('webpage_img_host_allowlist'));
                const extras = await webpageStore.listExtraFiles(webpageId);
                // ALL extras (text AND binary) — AI-created SVGs are text
                // extras and must count as existing assets.
                const assetPaths = extras.map(e => e.path);
                let scriptTexts;
                let sourcesMap;
                if (currentFramework === 'react-mui') {
                    sourcesMap = {};
                    const srcExtras = extras.filter(e => e.isText && /^src\/.*\.(jsx|js)$/i.test(e.path)).slice(0, 10);
                    for (const e of srcExtras) {
                        const f = await webpageStore.readExtraFile({ webpageId, userId, path: e.path });
                        if (f?.text) sourcesMap[e.path] = f.text;
                    }
                } else {
                    scriptTexts = [liveFiles.js];
                    const jsExtras = extras.filter(e => e.isText && /\.(js|mjs|cjs)$/i.test(e.path)).slice(0, 10);
                    for (const e of jsExtras) {
                        const f = await webpageStore.readExtraFile({ webpageId, userId, path: e.path });
                        if (f?.text) scriptTexts.push(f.text);
                    }
                }
                const { violations } = validateWebpageProject({
                    framework: currentFramework,
                    html: liveFiles.html,
                    scriptTexts,
                    sources: sourcesMap,
                    assetPaths,
                    allowedHosts,
                });
                const actionable = violations.filter(v => v.severity !== 'info');
                if (actionable.length === 0) return null;
                // Observability — the frontend SSE switch ignores unknown
                // event names, so old clients are unaffected.
                send('webpage_validation', { violations: actionable });
                log.info(`[WebpageChat] Validation found ${actionable.length} issue(s)`);
                // Warns alone never trigger the extra LLM round — only real
                // errors (broken anchor / missing asset) are worth the cost.
                if (!actionable.some(v => v.severity === 'error')) return null;
                return buildRepairMessage(actionable, { assetPaths });
            } catch (valErr) {
                log.warn('[WebpageChat] Post-generation validation failed (skipping):', valErr.message);
                return null;
            }
        }

        // Unified streaming loop: every model round streams, so users see
        // text + reasoning + tool calls immediately rather than waiting on
        // blocking chat completions before the first paint.
        // PII token-preservation: when attachment scanning minted tokens, tell the
        // model what the [token]s mean so it echoes them verbatim. Best-effort.
        if (_dlpActive) {
            try {
                const { buildTokenPreservationAddendum } = require('../../core/dlp/tokenPreservationPrompt');
                const _convMap = require('../../core/dlp/dlpRunner').getConversationTokenMap(_dlpConvId);
                const _add = buildTokenPreservationAddendum(_convMap);
                if (_add && messages[0]?.role === 'system') messages[0].content += _add;
            } catch (_) { /* best-effort */ }
        }
        // Response un-tokeniser: restore [token]s minted from attachment PII back to
        // real values as chunks stream (shared by every phase below). Passthrough
        // when the shield is off. Flushed once before send('done').
        const _streamUntok = _dlpActive
            ? require('../../core/dlp/untokeniseStream').createUntokeniser(() => require('../../core/dlp/dlpRunner').getConversationTokenMap(_dlpConvId))
            : null;

        let fullContent = '';
        let streamToolCalls = [];
        let streamThinkingParts = {};

        const streamCallback = (type, data) => {
            if (type === 'text') {
                const _safe = _streamUntok ? _streamUntok.push(data.text) : data.text;
                if (_safe) { fullContent += _safe; send('content', { text: _safe }); }
            } else if (type === 'thinking_start') {
                if (data.partId) {
                    streamThinkingParts[data.partId] = { redacted: !!data.redacted };
                    send('thinking_start', { partId: data.partId, redacted: data.redacted || undefined });
                }
            } else if (type === 'thinking') {
                send('thinking', { text: data.text, partId: data.partId });
            } else if (type === 'thinking_stop') {
                if (data.partId) {
                    send('thinking_stop', { partId: data.partId, redacted: data.redacted || undefined });
                }
            } else if (type === 'tool_use' || type === 'tool_call') {
                streamToolCalls.push({
                    id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: data.name || data.function?.name,
                        arguments: typeof data.input !== 'undefined'
                            ? JSON.stringify(data.input || {})
                            : (data.function?.arguments || '{}'),
                    },
                });
            } else if (type === 'done') {
                // Adapter signals end-of-stream with usage + stop_reason.
                // Track tokens for the termination monitor and remember the
                // last stop_reason so we can detect max_tokens truncations.
                _termPromptTokens += data?.prompt_tokens || 0;
                _termCompletionTokens += data?.completion_tokens || 0;
                _termLastStopReason = data?.stop_reason || data?.finish_reason || null;
            } else if (type === 'error') {
                send('error', data);
            }
        };

        while (toolCallRounds < MAX_TOOL_ROUNDS) {
            // No new tool round once the user is gone.
            if (clientGone) break;
            fullContent = '';
            streamToolCalls = [];
            streamThinkingParts = {};

            const streamOptions = {
                ...chatOptions,
                tools: webpageTools,
                toolChoice: 'auto',
            };

            // Final pre-LLM phase marker — only on the first round, so the UI
            // status placeholder fades out before the first token arrives.
            if (toolCallRounds === 0) {
                emitPhase(send, 'streaming_start', modelId);
            }

            try {
                await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);
            } catch (err) {
                log.error('[WebpageChat] Stream error:', err.message);
                terminationStore.logTermination({
                    ..._terminationBase(),
                    termination_type: 'error',
                    ...sanitizeError(err),
                }).catch(() => {});
                send('error', { error: `Chat error: ${err.message}` });
                break;
            }

            if (_termLastStopReason === 'max_tokens' || _termLastStopReason === 'length') {
                terminationStore.logTermination({ ..._terminationBase(), termination_type: 'max_tokens' }).catch(() => {});
            }

            if (streamToolCalls.length === 0) {
                // End of turn — validate what was generated and, on real
                // problems, feed them back for a single repair round
                // (BFSF-222). Stays bounded: one injection per turn, and the
                // repair round still counts against MAX_TOOL_ROUNDS.
                const repair = await maybeBuildValidationRepair();
                if (repair) {
                    // A user turn, not a system message: the request has to
                    // end on a user turn or Claude rejects it as prefill.
                    const { validationRepairTurn } = require('../../services/webpageValidation');
                    messages.push(...validationRepairTurn(fullContent, repair));
                    validationRepairUsed = true;
                    continue;
                }
                break;
            }

            messages.push({
                role: 'assistant',
                content: fullContent || null,
                tool_calls: streamToolCalls,
            });
            toolCallRounds++;
            const toolResults = await Promise.all(streamToolCalls.map(dispatchToolCall));
            messages.push(...toolResults);

            // Hand any screenshots taken this round to the (vision-capable) model
            // as a user message — so it can actually SEE the page and iterate.
            // image_url blocks are converted to the provider's native image format
            // by the adapter (Claude). Only populated when the model has vision.
            if (pendingVisionImages.length > 0) {
                messages.push({
                    role: 'user',
                    content: [
                        ...pendingVisionImages.map(url => ({ type: 'image_url', image_url: { url } })),
                        { type: 'text', text: 'Above is the screenshot you just captured. Review the layout, spacing, colour, contrast and alignment, and fix any visual problems before continuing.' },
                    ],
                });
                pendingVisionImages.length = 0;
            }

            // Plan proposed — stop the loop. Then run one more streaming
            // round (no tools) so the model can deliver its natural-language
            // "I'll build the following…" message above the plan card.
            if (planProposedThisTurn) {
                fullContent = '';
                streamToolCalls = [];
                try {
                    await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, streamCallback);
                } catch (err) {
                    log.error('[WebpageChat] Plan wrap-up stream error:', err.message);
                    terminationStore.logTermination({
                        ..._terminationBase(),
                        termination_type: 'error',
                        ...sanitizeError(err),
                    }).catch(() => {});
                }
                break;
            }
        }

        // Hit MAX_TOOL_ROUNDS with tool calls still pending — give the model
        // one chance to summarise without offering more tools.
        if (toolCallRounds >= MAX_TOOL_ROUNDS && streamToolCalls.length > 0) {
            terminationStore.logTermination({ ..._terminationBase(), termination_type: 'max_iterations' }).catch(() => {});
            try {
                await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, streamCallback);
            } catch (err) {
                log.error('[WebpageChat] Final wrap-up stream error:', err.message);
                terminationStore.logTermination({
                    ..._terminationBase(),
                    termination_type: 'error',
                    ...sanitizeError(err),
                }).catch(() => {});
            }
        }

        // Persist any tool-driven file updates to RustFS so versioning + sha256s
        // stay accurate across sessions.
        //
        // ── EEN MOMENTOPNAME PER BEURT (W4) ─────────────────────────────────
        // Hier stond de 5-minuten-debounce van de autosave. Die hoort bij
        // TOETSAANSLAGEN — een reeks kleine bewerkingen zonder duidelijk begin
        // of eind. Een AI-beurt is het tegenovergestelde: één afgebakende
        // gebeurtenis met een eigen samenvatting, en twee beurten binnen vijf
        // minuten (het normale tempo van een gesprek) deelden onder de debounce
        // één terugzetpunt — waarmee de tweede beurt niet meer los terug te
        // draaien was. De rijen dragen `source: 'ai'`, tellen gewoon mee tegen
        // MAX_VERSIONS_PER_WEBPAGE en kunnen een gepubliceerde momentopname
        // niet verdringen (die is prune-vast).
        if (dirtySlots.size > 0) {
            try {
                const wpFresh = await webpageStore.getWebpage(webpageId, userId);
                const hadContent = wpFresh && (wpFresh.htmlSize + wpFresh.cssSize + wpFresh.jsSize > 0);
                if (hadContent) {
                    await webpageStore.createVersion(userId, webpageId,
                        // De samenvatting komt uit WAT DE GEREEDSCHAPPEN DEDEN,
                        // niet uit de proza van het model — dezelfde regel die
                        // webpageTurnFacts.js aan de clientkant aanhoudt.
                        versionFacts.aiTurnSummary(dirtySlots), {
                            htmlSha: wpFresh.htmlSha,
                            cssSha: wpFresh.cssSha,
                            jsSha: wpFresh.jsSha,
                            contentLength: wpFresh.htmlSize + wpFresh.cssSize + wpFresh.jsSize,
                        }, 'ai', {
                            // De persoon wiens sessie de beurt aanstuurde. De AI
                            // is geen account en kan er geen worden: `source`
                            // zegt al dat het een AI-beurt was.
                            actorUserId: userId,
                            lineDelta: versionFacts.slotsLineDelta(preTurnFiles, liveFiles, dirtySlots),
                        });
                }
                const updates = {};
                for (const slot of dirtySlots) {
                    const { sha, size } = await webpageStore.writeSlot(userId, webpageId, slot, liveFiles[slot]);
                    updates[`${slot}Sha`] = sha;
                    updates[`${slot}Size`] = size;
                }
                if (Object.keys(updates).length > 0) {
                    await webpageStore.updateWebpageMetadata(webpageId, userId, updates);
                }
            } catch (persistErr) {
                log.error('[WebpageChat] Failed to persist tool-driven edits:', persistErr.message);
            }
        }

        // De dependents-index bijwerken zodra de beurt IETS aan de pagina
        // veranderde. `touchedExtraPaths` telt uitdrukkelijk mee: een
        // react-mui-app leeft volledig in extra bestanden, dus een beurt die
        // alleen `src/App.jsx` herschreef heeft een lege `dirtySlots` en toch een
        // andere tabellenlijst. Gedebouncet en detached — een AI-beurt wacht
        // hier niet op en gaat er niet aan kapot.
        //
        // Deze regel is sinds de reconcile in `stores/webpageStore.js` hangt
        // niet meer de ENIGE dekking, en dat is precies de reden dat hij mag
        // blijven staan waar hij staat: valt de beurt eerder om (adapter.stream
        // gooit, de catch hieronder doet alleen `res.end()`), dan is het extra
        // bestand al persistent — en heeft de store bij het schrijven zelf al
        // een pass ingepland. Dit is de samenvattende pass aan het eind, niet
        // het vangnet.
        if (dirtySlots.size > 0 || touchedExtraPaths.size > 0) {
            webpageUsageSync.reconcileWebpageUsageDetached(webpageId);
        }

        if (_streamUntok) {
            const _tail = _streamUntok.flush();
            if (_tail) { fullContent += _tail; send('content', { text: _tail }); }
        }

        send('done', {});
        res.end();
    } catch (err) {
        // A cancelled answer is not an outage: no error event (nobody is
        // listening), and nothing logged as a termination.
        if (clientGone || err?.name === 'AbortError' || clientAbort.signal.aborted) {
            log.info('[WebpageChat] turn cancelled by the client');
            try { if (!res.writableEnded) res.end(); } catch (_) { /* socket already gone */ }
            return;
        }
        log.error('[WebpageChat] Error:', err);
        try {
            terminationStore.logTermination({
                user_id: req.session?.user?.id || null,
                agent_id: req.body?.webpageId || null,
                agent_name: 'Webpage chat',
                source: 'webpage_chat',
                conversation_id: req.body?.webpageId || null,
                termination_type: 'error',
                ...sanitizeError(err),
            }).catch(() => {});
        } catch (_) { /* ignore logging failures */ }
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

module.exports = router;
