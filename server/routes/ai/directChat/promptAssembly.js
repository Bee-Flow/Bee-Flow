/**
 * Direct Chat — system-prompt and message-array assembly: the stable/volatile
 * system-block split, tool hints, project instructions + KB retrieval,
 * attached KBs, memory injection (with PII scrub), house style, notebook and
 * side-panel webpage context, skills injection, the Now: timestamp,
 * capability-honesty addenda and conversation-history resolution/hydration.
 * Moved verbatim out of streamTurn.js.
 */

const configStore = require('../../../stores/configStore');
const { getAIConfig } = require('../../../core/aiAgent');
const agentStore = require('../../../stores/agentStore');
const userStore = require('../../../stores/userStore');
const { buildToolHint } = require('../../../core/integrations/integrationTools');
const { emitPhase, emitPhaseEnd } = require('../../../core/agentRuntime/phaseEvents');
const { DEFAULT_SYSTEM_PROMPT } = require('./systemPrompt');
const { encryptionOpts } = require('./shared');
const { formatLocalNow } = require('../../../core/llm/clock');
const log = require('../../../telemetry/log');

async function buildPromptAndHistory({ req, send, userId, message, conversationId, history, timezone, requestSystemPrompt, activeSkillIds, requestedKbIds, projectId, notebookspaceAvailable, notebookspaceContent, notebookspaceSelection, sidePanelWebpage, sidePanelDocument, webpagePlanExecution, userOrgForTiers, orgIdsForTiers, notebooksEnabled, canUseNotebooks, toolCatalogText, directChatTools }) {
        // Build messages array
        emitPhase(send, 'building_prompt');
        const _spT = Date.now();
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const customPrompt = await configStore.getConfig('direct_chat_system_prompt');
        let systemPromptText = customPrompt || DEFAULT_SYSTEM_PROMPT;
        // Strip notebook instructions from prompt when feature is disabled
        if (!notebooksEnabled) {
            systemPromptText = systemPromptText.replace(/\n*When the user has a notebook open[^\n]*\n*/g, '\n');
        }
        // BFSF-261: style layer appended unconditionally (custom admin prompts
        // included). `basePrompt` opens the CACHED system block, so it carries
        // no date — `Today is …` used to sit here, ahead of the tool hint, and
        // rewrote the whole prefix at midnight. It now rides the volatile
        // block next to the `Now:` line.
        const { buildWritingStyleAddendum, buildResponseLanguageRule } = require('../../../core/llm/promptStyle');
        const basePrompt = (requestSystemPrompt ? requestSystemPrompt + '\n\n' : '')
            + systemPromptText
            + buildWritingStyleAddendum()
            + buildResponseLanguageRule();

        // Per-turn system context. Kept out of the first system block so the
        // 1h cache breakpoint the Claude adapter places there stays valid for
        // the whole conversation. See core/agentRuntime/contextBuilder.js for
        // the full contract.
        let volatileContext = `\n\nToday is ${today}.`;

        // Build explicit integration hints so the AI knows what tools it has.
        // With disclosure on, buildToolHint only describes the eager/loaded
        // tools still in directChatTools; toolCatalogText advertises the rest.
        const toolHint = (await buildToolHint(directChatTools, userId)) + toolCatalogText;

        // Knowledge-base passages below go into the prompt without a tool
        // call, so the Privacy Shield's "own server" block list is applied to
        // them here (BFSF-354); the same passages fetched through kb_search
        // are stripped in the tool loop. The "### Source N:" label goes
        // through the same scan (a title can carry the same data). Resolved
        // once, and only when there are passages to strip. Returns the
        // passages as prompt text.
        let kbShield;
        const kbPassagesText = async (chunks) => {
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

        // ─── Project context injection ───────────────────────────────
        //
        // `projectId` comes from the REQUEST BODY and is therefore attacker-chosen.
        // Resolve it into `validProjectId` ONCE, here, and use only that from this
        // point on — never the raw `projectId` again.
        //
        // The previous shape checked access, warned on failure, and then carried on
        // with the raw id anyway. Memory retrieval below drops its `user_id` filter
        // whenever a projectId is present (memoryStore.findRelevantMemories), so any
        // authenticated user could name any project UUID and have that project's
        // memories injected into their prompt. The agent path
        // (core/agentRuntime/chatStream.js) already used a validated variable; this
        // now matches it.
        let projectContext = '';
        let extractMemoriesEnabled = false;
        let validProjectId = null;
        if (projectId) {
            const { resolveRequestedProject } = require('../../../auth/projectAccess');
            const resolved = await resolveRequestedProject(userId, projectId);
            if (resolved) {
                const project = resolved.project;
                validProjectId = resolved.projectId;
                extractMemoriesEnabled = project.extractMemories === true;
                // Inject custom instructions
                if (project.customInstructions && project.customInstructions.trim()) {
                    projectContext += `\n\n[PROJECT INSTRUCTIONS — "${project.name}"]\n${project.customInstructions}`;
                }
                // Search project knowledge bases
                const kbIds = project.knowledgeBaseIds || [];
                if (kbIds.length > 0) {
                    try {
                        const { quickKBSearch } = require('../../../core/agentRuntime/knowledgeSearch');
                        const kbResults = await quickKBSearch(userId, kbIds, message, { topK: 6, session: req.session });

                        if (kbResults.length > 0) {
                            const kbText = await kbPassagesText(kbResults);
                            // Retrieved against THIS turn's message — volatile.
                            volatileContext += `\n\n[PROJECT KNOWLEDGE BASE — "${project.name}"]\nRelevant information from this project's knowledge base:\n${kbText}`;
                            log.info(`[DirectChat] Injected ${kbResults.length} KB chunks from project "${project.name}"`);
                        }
                    } catch (kbErr) {
                        log.warn('[DirectChat] Project KB search failed:', kbErr.message);
                    }
                }
            }
        }

        // ─── Direct-chat attached KBs ───────────────────────────────
        //
        // The person picked these in the input-area picker, which means the
        // ids arrived from a client and are checked here rather than trusted.
        //
        // This used to be a hand-rolled copy of the access rule with two holes
        // in it. `orgIdsForTiers === null` was read as SUPER ADMIN and short-
        // circuited to "accessible" for every id — so an operator's direct
        // chat could quote any base on the install, and a resolver that failed
        // and returned null would have done the same for anyone. And nothing
        // asked whether the base's owner had made it available to direct chat
        // at all. `core/kb/kbVisibility` is now the one answer to the first
        // question on every surface, and it coerces orgIds to a Set for
        // exactly that reason.
        //
        // WHAT THIS TURN MAY SEARCH COMES FROM THE REQUEST, NEVER FROM THE
        // STORED COLUMN. `direct_conversations.knowledge_base_ids` remembers
        // the selection so the composer can restore it — it is NOT read back
        // here, and it must not be: today's web and mobile clients OMIT the
        // key when the list is empty, so "fall back to what is stored" would
        // turn "I unticked every base" into "keep answering from them", with a
        // picker showing nothing and citations coming out anyway.
        //
        // `usableKbIds` is what survived BOTH checks, and it is also what gets
        // persisted at the end of the turn — so the stored list can only ever
        // be a subset of what was authorised at the moment it was written.
        let usableKbIds = [];
        if (Array.isArray(requestedKbIds) && requestedKbIds.length > 0) {
            const { resolveUsableKbIds } = require('../../../core/kb/kbSelection');
            const userGroupsRaw = await userStore.getUser(userId).then(u => u?.groups).catch(() => null);
            const userGroups = Array.isArray(userGroupsRaw)
                ? userGroupsRaw
                : (() => { try { return JSON.parse(userGroupsRaw || '[]'); } catch (_) { return []; } })();

            usableKbIds = await resolveUsableKbIds(requestedKbIds, {
                userId,
                orgIds: orgIdsForTiers instanceof Set ? orgIdsForTiers : new Set(),
                userGroups,
                surface: 'direct_chat',
            });
            if (usableKbIds.length < requestedKbIds.length) {
                log.warn(`[DirectChat] User ${userId} requested ${requestedKbIds.length} KBs but only ${usableKbIds.length} were usable here`);
            }

            // A retrieval failure is NOT an authorisation failure: the search
            // dying (or simply matching nothing) must not silently detach the
            // bases the person picked. Separate try, so `usableKbIds` keeps
            // meaning "authorised for this turn".
            if (usableKbIds.length > 0) {
                try {
                    const { quickKBSearch } = require('../../../core/agentRuntime/knowledgeSearch');
                    const kbResults = await quickKBSearch(userId, usableKbIds, message, { topK: 6, session: req.session });
                    if (kbResults.length > 0) {
                        const kbText = await kbPassagesText(kbResults);
                        // Retrieved against THIS turn's message — volatile.
                        volatileContext += `\n\n[ATTACHED KNOWLEDGE BASES]\nRelevant information from the knowledge bases attached to this chat:\n${kbText}`;
                        log.info(`[DirectChat] Injected ${kbResults.length} KB chunks from ${usableKbIds.length} attached KBs`);
                    }
                } catch (kbErr) {
                    log.warn('[DirectChat] Direct-chat KB search failed:', kbErr.message);
                }
            }
        }

        // ─── Memory injection ────────────────────────────────────────
        let memoryContext = '';
        try {
            const memoryStore = require('../../../stores/memoryStore');
            // Always pass the project for retrieval (project memories should be available
            // regardless of the extractMemories flag) — but only the VALIDATED id.
            // findRelevantMemories drops its user_id filter when a projectId is present,
            // so an unvalidated id here is a cross-project read.
            const relevantMemories = await memoryStore.findRelevantMemories(userId, null, message, 800, validProjectId);
            if (relevantMemories.length > 0) {
                memoryContext = '\n\n' + memoryStore.formatMemoriesForPrompt(relevantMemories);

                // Defence in depth: scrub PII out of the memory context before
                // it reaches the LLM. Stored memories can contain real values
                // from earlier turns that would otherwise bypass this turn's
                // tokeniser. We replace with generic labels (non-reversible)
                // so the AI can't reconstruct the underlying data.
                try {
                    // Resolve the user's org locally — the outer-scope
                    // `userOrgId` const is only declared further down (≈line
                    // 1560), so referencing it here would hit the TDZ.
                    let scrubOrgId = null;
                    try {
                        const userStoreLocal = require('../../../stores/userStore');
                        const localUser = await userStoreLocal.getUser(userId).catch(() => null);
                        scrubOrgId = localUser?.organizationId || null;
                    } catch { /* best-effort */ }
                    const orgShieldForScrub = scrubOrgId
                        ? await configStore.getConfig(`org_privacy_shield_${scrubOrgId}`)
                        : null;
                    // Shield's master flag is the only switch for PII scrubbing;
                    // detectPii() routes to whichever backend is available.
                    const scrubEnabled = !!orgShieldForScrub?.enabled
                        || !!(await getAIConfig())?.piiDetectionEnabled;
                    if (scrubEnabled) {
                        const { scrubMemoryContext } = require('../../../core/memory/scrubMemoryContext');
                        const { scrubbed, replacedCategories } = await scrubMemoryContext(memoryContext, orgShieldForScrub);
                        if (replacedCategories.length > 0) {
                            log.info(`[DirectChat] Scrubbed memory context: ${replacedCategories.join(', ')}`);
                            memoryContext = scrubbed;
                        }
                    }
                } catch (scrubErr) {
                    log.warn('[DirectChat] Memory scrub failed (fail-open):', scrubErr.message);
                }
            }
        } catch (e) {
            log.warn('[DirectChat] Memory retrieval failed:', e.message);
        }

        // ─── House style awareness ──────────────────────────────────
        // When the org has a default kantoorstijl, tell the model so it can
        // match tone — actual formatting is applied when a .docx is built
        // (create_word_document, or the Notebook's Word export).
        let houseStyleContext = '';
        try {
            if (userOrgForTiers) {
                const houseStyleStore = require('../../../stores/houseStyleStore');
                const houseStyle = await houseStyleStore.getDefaultForOrg(userOrgForTiers);
                if (houseStyle) {
                    const tone = houseStyle.styleMeta?.toneDescription;
                    houseStyleContext = `\n\n[HOUSE STYLE ACTIVE]\nOrg Word/DOCX kantoorstijl "${houseStyle.name}" wordt automatisch toegepast op elk .docx: create_word_document en de Word-export van het Notebook${houseStyle.description ? ` — ${houseStyle.description}` : ''}.${tone ? ` Tone of voice: ${tone}.` : ''} Schrijf de inhoud in Markdown — lettertype, koppen, marges en header/footer komen uit de kantoorstijl; geen inline styling nodig.`;
                }
            }
        } catch (e) {
            log.warn('[DirectChat] house style lookup failed:', e.message);
        }

        // ─── Notebook context injection ─────────────────────────────
        // Two flags from the client:
        //   - notebookspaceAvailable: the Notebook panel exists in this UI
        //     (may be closed). Tells the model the tools are usable; calling
        //     notebook_write auto-opens the panel via the workspace_update SSE.
        //   - notebookspaceContent: the panel is currently open. `undefined`
        //     means closed; `""` is "open but blank".
        let notebookspaceContext = '';
        if (canUseNotebooks && notebookspaceAvailable) {
            notebookspaceContext = `\n\n[NOTEBOOK CAPABILITY]
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
        if (canUseNotebooks && notebookspaceContent !== undefined) {
            notebookspaceContext += `\n\n[NOTEBOOK OPEN]
The Notebook panel is currently open. Current rules for edits: 1) Before notebook_replace, use notebook_read mode="search" or mode="section" to get exact text. 2) Copy find_text EXACTLY from read output. 3) For partial edits always prefer notebook_replace over notebook_write. 4) After any notebook tool call, your chat reply is at most one short confirmation sentence — do not repeat the new or modified content.`;
            // The selection changes as the user clicks around — volatile.
            if (notebookspaceSelection && notebookspaceSelection.trim()) {
                volatileContext += `\n\n[SELECTED TEXT IN NOTEBOOK]\nThe user selected this text:\n\`\`\`\n${notebookspaceSelection}\n\`\`\`\nUse notebook_replace with find_text set to EXACTLY this text. Set replace_text to the new version.`;
            }
        }

        // ─── Side-panel webpage awareness ────────────────────────
        // The user has a webpage open in the right-side panel. Resolve its
        // latest content from storage and inject it into the prompt so the
        // AI can answer questions about "this page" / "deze pagina".
        if (sidePanelWebpage?.id) {
            try {
                const { buildSidePanelWebpageContext } = require('../../../core/webpages/sidePanelWebpageContext');
                // Live page content — volatile.
                const block = await buildSidePanelWebpageContext(sidePanelWebpage, userId);
                if (block) volatileContext += block;
            } catch (e) {
                log.warn('[DirectChat] sidePanelWebpage injection failed:', e.message);
            }
        }

        // ─── Side-panel document awareness ───────────────────────
        // Only which document is open; the model reads it with document_read
        // (allowed for it by core/documents/aiDocumentScope.js).
        if (sidePanelDocument) {
            const { buildDirectNote } = require('../../../core/documents/sidePanelDocumentContext');
            const note = await buildDirectNote(sidePanelDocument, userId);
            if (note) volatileContext += note;
        }

        // ─── Skills injection ────────────────────────────────────
        // Static skills inject their full body into skillsContext. Dynamic
        // skills inject only a manifest line and add an `activate_skill` tool
        // to directChatTools so the model can pull the full body on demand.
        let skillsContext = '';
        try {
            const { buildSkillInjection } = require('../../../core/tools/skillInjection');
            const skillInjection = await buildSkillInjection({
                sessionSkillIds: Array.isArray(activeSkillIds) ? activeSkillIds : [],
                attachedSkillIds: [], // direct chat has no agent => no attached skills
                orgId: userOrgForTiers,
                userId,
                // One skill_activations row per conversation instead of one per
                // turn. No agentId — direct chat has no agent.
                conversationId,
            });
            if (skillInjection.systemPromptAddendum) {
                skillsContext = skillInjection.systemPromptAddendum;
                log.info(`[DirectChat] Skills: ${skillInjection.staticCount} static, ${skillInjection.dynamicSkillIds.length} dynamic`);
            }
            for (const t of skillInjection.tools) directChatTools.push(t);
        } catch (skillErr) {
            log.warn('[DirectChat] Skills injection failed:', skillErr.message);
        }

        // Local time with explicit UTC offset, at MINUTE resolution (see
        // core/llm/clock.js for why seconds were the enemy of every prompt
        // cache in front of a self-hosted model).
        const _nowStr = formatLocalNow(timezone);

        // System prompt is split into two messages so per-provider caching
        // can place a long-lived breakpoint on the stable portion. Everything
        // that varies per turn goes in the second message — a single changing
        // byte in the first one invalidates the entire cached prefix.
        //   1. stable: identity / tool hint / house style / notebook rules /
        //      project instructions / skills / capability honesty
        //   2. volatile: timestamp, today's date, retrieved memories, per-query
        //      KB chunks, notebook selection, side-panel page content
        // Providers that join system messages (Gemini, OpenAI Responses) still
        // see the same effective prompt; Claude's extractSystem emits per-
        // message blocks with the right cache_control on the stable one.
        //
        // The volatile block is a NAMED object (`volatileMessage`) and is
        // returned alongside `messages`: every later per-turn addendum (PII
        // tokens, moderation flag, session-skill state, step-machine guard)
        // appends to it, and the turn handler moves it behind the history just
        // before the first model call (core/llm/promptLayout.js) so a
        // self-hosted prefix cache keeps the history too. It stays at index 1
        // here because compaction hoists system messages in order and several
        // checks read messages[0].role === 'system'.
        // Capability-honesty addenda (BFSF-176/125/127): tell the model the
        // truth about which media tools are actually registered so it doesn't
        // invent an image via HTML/WebGL when generate_image is absent, and
        // steer Gmail attachment reads to the real tool rather than a
        // hallucinated convert_document_to_text.
        const _toolNames = new Set(directChatTools.map(t => t.function?.name).filter(Boolean));
        let capabilityContext = '';
        if (!_toolNames.has('generate_image') && !_toolNames.has('generate_video')) {
            capabilityContext += `\n\n[MEDIA GENERATION UNAVAILABLE]\nYou do NOT currently have an image or video generation tool. If the user asks you to generate, create, or draw an image or video, tell them it is unavailable on this workspace (an admin can enable it). Do NOT attempt to produce the media via HTML, CSS, Canvas, WebGL, SVG, create_webpage, or any other code-based workaround.`;
        }
        if ([..._toolNames].some(n => n.startsWith('gmail_'))) {
            capabilityContext += `\n\n[GMAIL / ATTACHMENTS]\nTo read an email body use gmail_read; to extract text from an email attachment use gmail_read_attachment. Do NOT call any generic convert/terminal/document-conversion tool — those do not exist. Uploaded chat files already have their text provided to you inline.`;
        }

        emitPhaseEnd(send, 'building_prompt', Date.now() - _spT);
        const volatileMessage = { role: 'system', content: `Now: ${_nowStr}` + volatileContext + memoryContext };
        let messages = [
            { role: 'system', content: basePrompt + toolHint + houseStyleContext + notebookspaceContext + projectContext + skillsContext + capabilityContext },
            volatileMessage,
        ];

        // Plan-execution turn: the user clicked Approve & build on a previously
        // proposed webpage plan. Inject an authorisation so the AI proceeds
        // straight to webpage_file_* / create_webpage without proposing a new
        // plan. The propose_webpage_plan tool is also stripped from the
        // toolset above when webpagePlanExecution is set. It rides on the
        // volatile block: a third leading system message hangs llama-server
        // outright (local.js), and this text is one-turn-only anyway.
        if (webpagePlanExecution && webpagePlanExecution.action === 'execute' && webpagePlanExecution.planId) {
            volatileMessage.content += `\n\nThe user APPROVED your previously proposed webpage plan (planId=${webpagePlanExecution.planId}). Execute it now using create_webpage / webpage_file_write / webpage_file_replace / webpage_file_patch. Do NOT call propose_webpage_plan again — the plan is already locked in.`;
        }

        // Add conversation history — preserve the `attachments` sidecar so the
        // hydrator below can rebuild multimodal content (images stay visible
        // across turns). Stripping sidecar fields here is what used to cause
        // the AI to "lose" uploaded images one turn after the upload.
        //
        // Source-of-truth rule:
        //   - If the client sent `history` in the body, use it. This covers
        //     brand-new conversations (no DB row yet) and edit/retry flows
        //     where the client has truncated history before the edit point.
        //   - If `history` is missing/empty AND we have a conversationId,
        //     fall back to the persisted message rows. This eliminates the
        //     class of bugs where the client's in-memory history drifts from
        //     the durable record (e.g. tool messages stripped, page reload).
        let resolvedHistory = Array.isArray(history) ? history : null;
        // Whether the CLIENT supplied history this turn (edit/retry, or a
        // surface that never synced its conversation id) — captured before the
        // DB fallback below reassigns resolvedHistory. Also drives the OpenAI
        // Responses chaining guard: a provider-side chain would replay the
        // pre-edit conversation and ignore the client's truncation.
        const clientHistoryProvided = !!(resolvedHistory && resolvedHistory.length > 0);
        if (clientHistoryProvided && conversationId) {
            // Client copies strip attachment sidecars to {name, type}. Graft
            // the persisted sidecars (extractedText / extractionKey /
            // storageKey) back onto the client history so the hydrator can
            // re-inject real file content instead of a bare
            // "[File previously attached]" placeholder.
            try {
                const { mergeAttachmentSidecars } = require('../../../core/conversation/historyMerge');
                const persisted = await agentStore.getDirectConversation(conversationId, userId, { restore: false, ...encryptionOpts(req) });
                if (persisted && Array.isArray(persisted.messages) && persisted.messages.length > 0) {
                    resolvedHistory = mergeAttachmentSidecars(resolvedHistory, persisted.messages);
                }
            } catch (mergeErr) {
                log.warn('[DirectChat] Attachment sidecar merge failed:', mergeErr.message);
            }
        }
        if ((!resolvedHistory || resolvedHistory.length === 0) && conversationId) {
            try {
                // restore:false — keep [email_N] tokens in the history we
                // hand to Claude on follow-up turns so PII never re-leaks
                // into the model context. UI fetch paths still default to
                // restore:true so users see their original values.
                const persisted = await agentStore.getDirectConversation(conversationId, userId, { restore: false, ...encryptionOpts(req) });
                if (persisted && Array.isArray(persisted.messages) && persisted.messages.length > 0) {
                    resolvedHistory = persisted.messages;
                    log.info(`[DirectChat] No client history — loaded ${resolvedHistory.length} persisted messages from DB`);
                }
            } catch (loadErr) {
                log.warn('[DirectChat] Failed to load persisted history:', loadErr.message);
            }
        }
        if (resolvedHistory && resolvedHistory.length > 0) {
            for (const msg of resolvedHistory) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                    const entry = { role: msg.role, content: msg.content };
                    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
                        entry.attachments = msg.attachments;
                    }
                    messages.push(entry);
                }
            }
            try {
                const { hydrateHistoryAttachments } = require('../../../core/agentRuntime/historyHydrator');
                await hydrateHistoryAttachments(messages, { userId, skipLast: false });
            } catch (hydrateErr) {
                log.warn('[DirectChat] History hydration failed:', hydrateErr.message);
            }
        }
        return { messages, volatileMessage, resolvedHistory, clientHistoryProvided, validProjectId, extractMemoriesEnabled, usableKbIds };
}

module.exports = { buildPromptAndHistory };
