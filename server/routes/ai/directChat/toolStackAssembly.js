/**
 * Direct Chat — assembly of the per-turn tool stack: prior tool-group
 * activations, skill-scoped app enablement, the shared direct-chat tool
 * builder, built-in tools (reminders, AI tasks, notebook, webpage builder),
 * the user/org media + web-search filters, the deterministic notebook-write
 * gate and progressive tool disclosure. Moved verbatim out of streamTurn.js.
 */

const agentStore = require('../../../stores/agentStore');
const configStore = require('../../../stores/configStore');
const { WORKSPACE_TOOLS } = require('../../../integrations/workspaceTools');
const { BUILDER_TOOLS } = require('../../../integrations/webpageBuilderTools');
const { DOCUMENT_TOOLS } = require('../../../integrations/documentBuilderTools');
const { WEBPAGE_DB_TOOLS } = require('../../../integrations/webpageDbTools');
const { buildDirectChatToolStack } = require('../../../core/tools/directChatToolStack');
const { emitPhase, emitPhaseEnd } = require('../../../core/agentRuntime/phaseEvents');
const { hasPermission } = require('../../../auth/permissions');
const { evaluateNotebookWriteGate } = require('./notebookWriteGate');
const { encryptionOpts } = require('./shared');
const log = require('../../../telemetry/log');

async function assembleToolStack({ req, send, userId, conversationId, resolvedTier, attachments, history, disabledMedia, webSearchEnabled, disableSearchOnUpload, message, notebookspaceContent, activeSkillIds, userOrgForTiers }) {
        // ─── Progressive tool disclosure: prior activations ─────────────
        // Which heavy integration groups has this conversation already
        // expanded? Those keep their full schemas (eager) instead of being
        // re-advertised in the catalog. Fetched here (before tool assembly)
        // because the main conversation-metadata load happens much later.
        const toolDisclosure = require('../../../core/tools/toolDisclosure');
        let activatedToolGroups = new Set();
        let disclosureLazyByGroup = null;
        if (conversationId) {
            try {
                const _convGroups = await agentStore.getDirectConversation(conversationId, userId, { restore: false, ...encryptionOpts(req) });
                if (Array.isArray(_convGroups?.activatedToolGroups)) {
                    activatedToolGroups = new Set(_convGroups.activatedToolGroups);
                }
            } catch (_) { /* non-fatal — fall back to no pre-activations */ }
        }

        // ─── Skill-scoped app enablement ─────────────────────────
        // Library skills can carry their own enabledIntegrations. Static
        // skills contribute their apps for the whole conversation; dynamic
        // skills only after the model calls activate_skill (activations
        // persist in conversation meta, key distinct from the session-skill
        // activatedSessionSkillIds). Entitlement + credential gates stay
        // inside getIntegrationTools — this only bypasses the per-user toggle.
        let activatedLibrarySkillIds = [];
        if (conversationId) {
            try {
                const _skillMeta = await agentStore.getDirectConversationMeta(conversationId, userId, encryptionOpts(req));
                if (Array.isArray(_skillMeta?.activatedSkillIds)) activatedLibrarySkillIds = [..._skillMeta.activatedSkillIds];
            } catch (_) { /* best-effort — worst case dynamic skill apps need re-activation */ }
        }
        let skillApps = { allowedApps: [], dynamicSkillApps: new Map(), mergedIds: [] };
        try {
            const { resolveSkillAppAllowlist } = require('../../../core/tools/skillInjection');
            skillApps = await resolveSkillAppAllowlist({
                attachedSkillIds: [], // direct chat has no agent => no attached skills
                sessionSkillIds: Array.isArray(activeSkillIds) ? activeSkillIds : [],
                activatedSkillIds: activatedLibrarySkillIds,
                orgId: userOrgForTiers,
                userId,
                forceDynamicSkills: false, // matches the buildSkillInjection call below
            });
        } catch (skillErr) {
            log.warn('[DirectChat] Skill app allowlist resolution failed:', skillErr.message);
        }

        // Load tier components + integration tools via the shared builder
        // (core/directChatToolStack — the same stack the Swarm workers see).
        // Wrapped in a phase so the UI shows "Loading tools…" instead of a
        // silent stall when a user has many integrations and OAuth-token
        // resolution is slow. strict: an integration-tools failure must fail
        // the turn exactly as the old inline code did (SSE error via the
        // route's outer catch) instead of silently degrading.
        emitPhase(send, 'loading_tools');
        const _toolsT = Date.now();
        const { tools: builtTools, n8nOrgId } = await buildDirectChatToolStack({
            userId,
            session: req.session,
            isAdmin: req.session?.isAdmin,
            resolvedTier,
            strict: true,
            extraEnabledApps: skillApps.allowedApps,
        });
        let directChatTools = builtTools;
        // First-pass tool names — the mid-turn skill-activation refresh diffs
        // against this so tools stripped or replaced after assembly can never
        // re-enter through a skill activation.
        const baseDirectToolNames = new Set(builtTools.map(t => t.function?.name).filter(Boolean));

        // MCP-server tools are integrations now — getIntegrationTools() inside
        // the builder already injected the entitled ones (gated by
        // effective.integration).

        // ─── Built-in: set_reminder tool ────────────────────────────
        directChatTools.push({
            type: 'function',
            function: {
                name: 'set_reminder',
                description: 'Set a reminder for the user. Use this when the user asks to be reminded about something at a specific time. Returns confirmation with the reminder details. IMPORTANT: Use the timezone from the "Now:" line in the system prompt — do NOT use UTC/Z unless the user is in UTC.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Short title for the reminder' },
                        message: { type: 'string', description: 'Optional detailed message for the reminder' },
                        remind_at: { type: 'string', description: 'ISO 8601 datetime string for when to remind. MUST include the user\'s timezone offset from the system prompt (e.g. "2026-03-09T15:00:00+01:00" for CET). Do NOT use "Z" unless the user is in UTC. Use the current date/time context to calculate the correct time.' },
                        repeat_interval: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Optional repeat interval. Only set if user asks for recurring reminders.' },
                    },
                    required: ['title', 'remind_at'],
                },
            },
        });

        // ─── Built-in: set_ai_task tool ────────────────────────────
        directChatTools.push({
            type: 'function',
            function: {
                name: 'set_ai_task',
                description: 'Create a scheduled AI task that runs automatically at specified times. Use this when the user wants recurring AI-generated content like news summaries, reports, digests, or any automated information gathering. The task runs in the background using web search and delivers results as notifications. IMPORTANT: Write a detailed, specific prompt for the AI to execute. Use the timezone from the "Now:" line.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Short descriptive title (e.g., "Weekly AI News Digest")' },
                        prompt: { type: 'string', description: 'Detailed instruction for the AI to execute each time. Be specific about what to search, summarize, or analyze. Example: "Search for the most important AI and machine learning news from the past week. Provide a summary of the top 5 developments with source links."' },
                        repeat_interval: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'How often to run the task. Use daily for morning digests, weekly for weekly summaries, monthly for monthly reports.' },
                        first_run_at: { type: 'string', description: 'ISO 8601 datetime for the first execution. MUST include timezone offset from system prompt. For "every Monday at 8 AM" → calculate next Monday at 08:00 in user\'s timezone.' },
                        model_tier: { type: 'string', enum: ['fast', 'thinking'], description: 'AI model quality tier. "fast" for simple lookups, "thinking" for analysis and deep research. Default: fast.' },
                    },
                    required: ['title', 'prompt', 'repeat_interval', 'first_run_at'],
                },
            },
        });

        // Simple Mode strips the agent's toolbelt — same set we hide in the
        // shared integration tools loader. Notebooks + webpages must not be
        // injected here either since direct chat wires them up separately.
        const userSimpleMode = !!(await configStore.getConfig(`simple_mode_user_${userId}`));

        // ─── Built-in: workspace tools ────────────────────────────────
        // Only inject notebook tools if the feature is enabled AND the user
        // actually has the use_notebooks permission. Without the permission
        // check, a user with no notebook access still received the tools and
        // could trigger a write that force-opened a panel they aren't entitled
        // to (BFSF-207). This is the authoritative gate — if the tool isn't in
        // the toolset, the model cannot call it.
        const notebooksEnabled = (await configStore.getConfig('feature_notebooks_enabled')) !== false;
        const { hasCapability } = require('../../../core/entitlements/entitlements');
        const canUseNotebooks = notebooksEnabled
            && await hasCapability('notebooks', { userId, orgId: req.session?.user?.organizationId || req.session?.user?.orgId || null, session: req.session, req })
            && await hasPermission(userId, 'use_notebooks', req.session);
        if (!userSimpleMode && canUseNotebooks) {
            for (const wsTool of WORKSPACE_TOOLS) {
                if (!directChatTools.find(t => t.function.name === wsTool.function.name)) {
                    directChatTools.push(wsTool);
                }
            }
        }

        // ─── Built-in: document tools ────────────────────────────────
        // Not behind the webpages beta: a document is its own thing. Since the
        // enterprise split (2026-10) it is the Enterprise capability
        // `studio_documents`, and these tools create and change documents, so
        // they are offered only to someone who holds it: the same line
        // routes/studioDocuments.js draws for its write routes. Simple mode
        // still opts out: it exists to keep the tool list short.
        if (await documentToolsAllowed({ userId, req, userSimpleMode })) {
            for (const tool of DOCUMENT_TOOLS) {
                if (!directChatTools.find(t => t.function.name === tool.function.name)) {
                    directChatTools.push(tool);
                }
            }
        }

        // ─── Built-in: webpage builder tools (gated on webpages beta) ─
        let webpageBetaEnabled = false;
        try {
            const { userHasBetaFeature: userHasWebpagesBetaForBuilder } = require('../../../core/entitlements/betaFeatures');
            webpageBetaEnabled = !userSimpleMode && await userHasWebpagesBetaForBuilder(userId, 'webpages', req.session);
            if (webpageBetaEnabled) {
                for (const tool of BUILDER_TOOLS) {
                    if (!directChatTools.find(t => t.function.name === tool.function.name)) {
                        directChatTools.push(tool);
                    }
                }
                // DB tools — the editor binds webpageId via the request URL, but
                // direct chat can target any webpage in the same turn, so we
                // require webpageId as an explicit arg on each call.
                for (const tool of WEBPAGE_DB_TOOLS) {
                    if (directChatTools.find(t => t.function.name === tool.function.name)) continue;
                    const params = tool.function.parameters || { type: 'object', properties: {}, required: [] };
                    const directTool = {
                        ...tool,
                        function: {
                            ...tool.function,
                            parameters: {
                                ...params,
                                properties: {
                                    webpageId: {
                                        type: 'string',
                                        description: 'The webpage ID returned by create_webpage (or referenced by the user).',
                                    },
                                    ...(params.properties || {}),
                                },
                                required: Array.from(new Set(['webpageId', ...(params.required || [])])),
                            },
                        },
                    };
                    directChatTools.push(directTool);
                }
                // No `propose_webpage_plan` in direct chat — the Approve/Reject
                // card lives in the Webpages editor's chat, not here. Without
                // that UI, planning would silently stall the conversation, so
                // we just go straight to create_webpage + webpage_file_write*.
                // Planning is preserved in /ai/chat/webpage/stream (editor) and
                // in the side-panel webpage chat which is routed there.
                log.info('[DirectChat] Webpage builder + db tools enabled for user');
            }
        } catch (builderErr) {
            log.warn('[DirectChat] Failed to check webpages beta for builder tools:', builderErr.message);
        }

        // Filter out user-disabled media tools
        if (disabledMedia && typeof disabledMedia === 'object') {
            const disabledToolNames = new Set();
            if (disabledMedia.image) disabledToolNames.add('generate_image');
            if (disabledMedia.music) disabledToolNames.add('generate_music');
            if (disabledMedia.video) disabledToolNames.add('generate_video');
            if (disabledMedia.elevenlabs) {
                disabledToolNames.add('elevenlabs_music');
                disabledToolNames.add('elevenlabs_tts');
                disabledToolNames.add('elevenlabs_sfx');
            }
            if (disabledToolNames.size > 0) {
                directChatTools = directChatTools.filter(t => !disabledToolNames.has(t.function.name));
                log.info(`[DirectChat] Disabled media tools: ${[...disabledToolNames].join(', ')}`);
            }
        }

        // Filter out web search tool if user disabled it
        if (webSearchEnabled === false) {
            directChatTools = directChatTools.filter(t => t.function.name !== 'agent_search');
            log.info('[DirectChat] Web search disabled by user');
        }

        // Filter out web search if org policy disables it on file uploads
        // Check both current attachments AND past messages in this conversation
        if (disableSearchOnUpload) {
            const hasCurrentAttachments = attachments && attachments.length > 0;
            // Check conversation history for past file uploads
            const hasHistoryAttachments = history && Array.isArray(history) && history.some(m => m.attachments && m.attachments.length > 0);
            if (hasCurrentAttachments || hasHistoryAttachments) {
                directChatTools = directChatTools.filter(t => t.function.name !== 'agent_search');
                log.info(`[DirectChat] Web search disabled — ${hasCurrentAttachments ? 'current files attached' : 'files in conversation history'} (org policy)`);
            }
        }

        emitPhaseEnd(send, 'loading_tools', Date.now() - _toolsT);

        // ─── Deterministic notebook-write gate (BFSF-169) ────────────────
        // Two failure modes are guarded here. (1) The notebook system prompt
        // steers Claude toward `notebook_write` when output looks long, and
        // Privacy Shield tokenisation makes a PDF answer look long — so a short
        // question like "what is in the file?" produced a tool-only response
        // the user read as "Error generating response". (2) Writes used to be
        // guarded by prompt text alone, so the model occasionally wrote to the
        // user's document unprompted.
        //
        // Both used to be handled by STRIPPING notebook_* from the turn's tool
        // list. Tools render before the system prompt, so a per-turn tool list
        // rebuilt the prompt cache on every intent flip. The tools now stay in
        // the list and the gate is enforced at dispatch
        // (directChat/toolExec.js) — same guarantee that an unrequested write
        // is impossible, stable prefix.
        const _hasAttachmentThisTurn = Array.isArray(attachments) && attachments.length > 0;
        const _notebookPanelOpen = notebookspaceContent !== undefined;
        const notebookWriteGate = evaluateNotebookWriteGate({
            message,
            hasAttachment: _hasAttachmentThisTurn,
            notebookPanelOpen: _notebookPanelOpen,
        });
        if (!notebookWriteGate.allowed) {
            log.info('[DirectChat] Notebook writes gated for this turn (tools still offered, dispatch will reject)');
        }

        // ─── Progressive tool disclosure ─────────────────────────────────
        // Swap heavy integration groups for a compact catalog + a `load_tools`
        // meta-tool; keep small/frequent tools (web search, KB, notebook,
        // built-ins, media, components) eager. Groups already activated on a
        // prior turn stay eager with full schemas. The model calls load_tools
        // mid-turn to pull a group on demand (see applyLoadTools below). Skipped
        // for light users and when the feature flag is off.
        let toolCatalogText = '';
        try {
            const disclosureOn = (await configStore.getConfig('feature_progressive_tool_disclosure')) !== false;
            if (disclosureOn && toolDisclosure.countLazyTools(directChatTools) >= toolDisclosure.MIN_TOOLS_FOR_DISCLOSURE) {
                const { eager, lazyByGroup } = toolDisclosure.partitionTools(directChatTools);
                disclosureLazyByGroup = lazyByGroup;
                const next = [...eager];
                for (const key of activatedToolGroups) {
                    const entry = lazyByGroup.get(key);
                    if (entry) for (const t of entry.tools) {
                        const tn = t.function?.name || t.name;
                        if (!next.find(x => (x.function?.name || x.name) === tn)) next.push(t);
                    }
                }
                next.push(toolDisclosure.loadToolsDefinition);
                directChatTools = next;
                toolCatalogText = toolDisclosure.buildToolCatalog(lazyByGroup, activatedToolGroups);
                log.info(`[DirectChat] Tool disclosure: ${eager.length} eager + ${lazyByGroup.size} lazy group(s), ${activatedToolGroups.size} pre-activated → ${directChatTools.length} tools sent`);
            }
        } catch (discErr) {
            log.warn('[DirectChat] Tool disclosure failed (sending full toolset):', discErr.message);
        }
        return { toolDisclosure, activatedToolGroups, disclosureLazyByGroup, activatedLibrarySkillIds, skillApps, directChatTools, baseDirectToolNames, n8nOrgId, notebooksEnabled, canUseNotebooks, toolCatalogText, notebookWriteGate };
}

/**
 * Whether this turn offers the Studio Documents tools (create_document,
 * document_read, document_write, document_edit).
 *
 * Simple mode says no before anything is resolved. Otherwise the answer is
 * the `studio_documents` capability, asked the way requireCapability asks it
 * (the session's user and organisation). hasCapability fails closed, so an
 * entitlement outage leaves the tools out rather than offering tools whose
 * every call the document routes would refuse. `hasCapability` is injectable
 * for the test beside this file.
 */
async function documentToolsAllowed({ userId, req = null, userSimpleMode = false, hasCapability = null } = {}) {
    if (userSimpleMode) return false;
    const check = hasCapability || require('../../../core/entitlements/entitlements').hasCapability;
    const user = req?.session?.user || {};
    try {
        return !!(await check('studio_documents', {
            userId, orgId: user.organizationId || user.orgId || null, session: req?.session || null, req,
        }));
    } catch (e) {
        log.warn('[DirectChat] document tools left out, the licence check failed:', e?.message);
        return false;
    }
}

module.exports = { assembleToolStack, documentToolsAllowed };
