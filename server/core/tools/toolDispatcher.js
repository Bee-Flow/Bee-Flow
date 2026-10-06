/**
 * Tool Dispatcher — Unified tool execution registry
 * 
 * All integration tools (Gmail, Calendar, Sheets, Docs, Drive, Slides,
 * Fireflies, YouTrack, Gamma, N8N, Agent Search, Image Gen, Video Gen,
 * ElevenLabs, Terminal, Regex Generator)
 * and component tools register here. Both directChat and agentRuntime use
 * `executeTool()` instead of maintaining separate if/else chains.
 */

const { executeComponentTool } = require('./toolExecution');
const configStore = require('../../stores/configStore');

// ─── Integration imports ────────────────────────────────────────
const { isGmailTool, executeGmailTool } = require('../../integrations/gmailTools');
const { isCalendarTool, executeCalendarTool } = require('../../integrations/calendarTools');
const { isDriveTool, executeDriveTool } = require('../../integrations/driveTools');
const { isDocsTool, executeDocsTool } = require('../../integrations/docsTools');
const { isSheetsTool, executeSheetsTool } = require('../../integrations/sheetsTools');
const { isSlidesTool, executeSlidesTool } = require('../../integrations/slidesTools');
const { isContactsTool, executeContactsTool } = require('../../integrations/contactsTools');
const { isKeepTool, executeKeepTool } = require('../../integrations/keepTools');
const { isGoogleGroupsTool, executeGoogleGroupsTool } = require('../../integrations/googleGroupsTools');
const { isFirefliesTool, executeFirefliesTool } = require('../../integrations/firefliesTools');
const { isYouTrackTool, executeYouTrackTool } = require('../../integrations/youtrackTools');
const { isSignRequestTool, executeSignRequestTool } = require('../../integrations/signrequestTools');
const { isGammaTool, executeGammaTool } = require('../../integrations/gammaTools');
const { isAfasTool, executeAfasTool } = require('../../integrations/afasTools');
const { isNmbrsTool, executeNmbrsTool } = require('../../integrations/nmbrsTools');
const { isVplanTool, executeVplanTool } = require('../../integrations/vplanTools');
const { isScalewayBillingTool, executeScalewayBillingTool } = require('../../integrations/scalewayBillingTools');
const { isN8nTool, executeN8nTool } = require('../../integrations/n8nTools');
const { isN8nWorkflowTool, executeN8nWorkflowTool, getN8nToolPermission } = require('../../integrations/n8nWorkflowTools');
const { hasPermission } = require('../../auth/permissions');
const { isAgentSearchTool, executeWebSearch } = require('../../integrations/agentSearchTools');
const { isBrowseWebTool, executeBrowseWebTool } = require('../../integrations/browserFetchTools');
const { isRegexGeneratorTool, executeRegexGeneratorTool } = require('../../integrations/regexGeneratorTools');
const { executeWorkspaceTool } = require('../../integrations/workspaceTools');
const { isKbSearchTool, executeKbSearchTool } = require('../../integrations/kbSearchTools');
const { isDatatableTool, executeDatatableTool } = require('./datatableTools');
const { isKbIngestTool, executeKbIngestTool } = require('../../integrations/kbIngestTools');
const { isMapsTool, executeMapsTool } = require('../../integrations/mapsTools');
const { isLinkedInTool, executeLinkedInTool } = require('../../integrations/linkedinTools');
const { isGitHubTool, executeGitHubTool } = require('../../integrations/githubTools');
const { isOutlookTool, executeOutlookTool } = require('../../integrations/outlookTools');
const { isMsCalendarTool, executeMsCalendarTool } = require('../../integrations/msCalendarTools');
const { isOneDriveTool, executeOneDriveTool } = require('../../integrations/oneDriveTools');
const { isMsContactsTool, executeMsContactsTool } = require('../../integrations/msContactsTools');
const { isTranscriptionTool, executeTranscriptionTool } = require('../../integrations/transcriptionTools');
const { isNextcloudTool, executeNextcloudTool } = require('../../integrations/nextcloudTools');
const { isNextcloudCalendarTool, executeNextcloudCalendarTool } = require('../../integrations/nextcloudCalendarTools');
const { isNextcloudContactsTool, executeNextcloudContactsTool } = require('../../integrations/nextcloudContactsTools');
const { isNextcloudDeckTool, executeNextcloudDeckTool } = require('../../integrations/nextcloudDeckTools');
const { isNextcloudNotificationsTool, executeNextcloudNotificationsTool } = require('../../integrations/nextcloudNotificationsTools');
const { isNextcloudTalkTool, executeNextcloudTalkTool } = require('../../integrations/nextcloudTalkTools');
const { isNextcloudTasksTool, executeNextcloudTasksTool } = require('../../integrations/nextcloudTasksTools');
const { isNextcloudNotesTool, executeNextcloudNotesTool } = require('../../integrations/nextcloudNotesTools');
const { isNextcloudMailTool, executeNextcloudMailTool } = require('../../integrations/nextcloudMailTools');
const { isNextcloudActivityTool, executeNextcloudActivityTool } = require('../../integrations/nextcloudActivityTools');
const { isNextcloudTablesTool, executeNextcloudTablesTool } = require('../../integrations/nextcloudTablesTools');
const { isNextcloudFormsTool, executeNextcloudFormsTool } = require('../../integrations/nextcloudFormsTools');
const { isNextcloudTeamsTool, executeNextcloudTeamsTool } = require('../../integrations/nextcloudTeamsTools');
const { isNextcloudStatusTool, executeNextcloudStatusTool } = require('../../integrations/nextcloudStatusTools');
const { isSupportTool, executeSupportTool } = require('../../integrations/supportTools');
const { isWebpageAutomationTool, executeWebpageAutomationTool } = require('../../integrations/webpageAutomationTools');
const log = require('../../telemetry/log');
const { createEgressChokepoint } = require('./toolEgress');

/**
 * Execute a tool by name.
 *
 * `toolArgs` MUST ALREADY BE DE-TOKENISED. This dispatcher has no conversation
 * identity, so it cannot look up the Privacy Shield token map itself — every
 * caller runs `untokeniseToolArgs` before handing the args over, or the tool
 * writes the literal `[email_1]` placeholder wherever the real value belonged
 * (BFSF-171). The callers that do it today:
 *
 *   - core/agentRuntime/toolRoundExecutor.js — every tool, with the tool-PII
 *     block policy (on the REAL values) as the only thing that withholds PII;
 *   - routes/ai/directChat/toolExec.js       — every tool except web/agent
 *     search, whose queries deliberately keep their tokens;
 *   - routes/ai/webpageChat.js               — same carve-out as direct chat.
 *
 * routes/ai/notebookChat.js is the deliberate exception: it dispatches in token
 * space and restores at the document write boundary instead.
 *
 * @param {string} toolName - Name of the tool to execute
 * @param {Object} toolArgs - Arguments for the tool
 * @param {Object} context  - Execution context:
 *   @param {string}  context.userId       - Current user ID
 *   @param {Object}  context.session      - Express session (for OAuth tokens)
 *   @param {Object}  context.userAuth     - User auth info (encryptionKey, etc.)
 *   @param {Object}  context.fixedParams  - Pre-configured params for this tool (tier overrides etc)
 *   @param {string}  context.agentId      - Agent ID (or null for direct chat)
 *   @param {string}  context.orgId        - Organization ID for n8n/org-scoped tools
 *   @param {Function} context.send        - SSE send helper (for image gen streaming)
 *   @param {Object}  context.imageGenSettings - Image generation settings
 *   @param {Object}  context.req          - Express request (for image gen API access)
 *   @param {Array}   context.attachments  - File attachments (for n8n)
 *   @param {Function} context.onImageGenerated - Callback when image is generated
 *   @param {Object}  context.terminalCtx  - Terminal tool context (containerKey, etc.)
 *   @param {Object|false} context.egress  - Attribution for the egress row the
 *                                          chokepoint writes when no probe is active:
 *                                          { source, model, isDryRun, ids }. `false`
 *                                          opts a UI-only read out (see toolEgress.js).
 * @returns {*} Tool result
 */
async function dispatchTool(toolName, toolArgs, context = {}) {
    // Guard: some providers return tool_calls without a valid function name
    if (!toolName) {
        log.warn('[ToolDispatcher] Skipping tool with undefined name');
        return { error: 'Tool call had no function name — emit a fresh tool_call with the function.name field set, or answer in plain text.' };
    }

    const {
        userId,
        session,
        userAuth,
        fixedParams,
        agentId,
        orgId,
        send,
        imageGenSettings,
        nanoBananaSettings,
        req,
        attachments,
        onImageGenerated,
        // { runId, rootRunId } inside an automation run; null in a chat. Lets the
        // upload tools resolve a `generated_file` handle against that journey.
        runScope,
    } = context;

    // Media-gen prompt moderation was removed when Azure Content Safety
    // was dropped. The upstream media-gen providers (Azure OpenAI image,
    // FAL, ElevenLabs) still apply their own safety filters.

    // ─── Terminal Tools (removed — module no longer exists) ────
    // Terminal container system has been removed from the platform

    // ─── Custom Integrations (AI Integration Builder) ───────────
    // Org-scoped cint_<slug>_<tool> calls go straight to the hardened runner
    // — org match, status, capability backstop, origin pin, SSRF re-check,
    // method gate and secret scrub all live there. Dispatched BEFORE the
    // per-integration chain so no prefix collision can shadow it.
    // `unattended`: context.autoSend is the dispatch-side headless marker —
    // the automation runner sets it on LIVE automation runs and webpageApiRuntime
    // sets it on backend handler calls. The custom-integration runner refuses
    // unattended===true outright for now, and the capability backstop still
    // gates every call regardless of path.
    //
    // The task/cowork runner needs the two halves apart. It must auto-send
    // email (nobody is there to approve a draft — see the aiTaskRunner call
    // site), but flipping its custom-integration calls to unattended would
    // turn working automations into refusals, which is a policy change and not
    // this fix's business. So `unattended` can be set explicitly and only
    // falls back to autoSend when it wasn't.
    const customRunner = require('../../integrations/customIntegrationRunner');
    if (customRunner.isCustomIntegrationTool(toolName)) {
        return await customRunner.executeCustomIntegrationTool(toolName, toolArgs, {
            userId,
            unattended: context.unattended !== undefined ? !!context.unattended : !!context.autoSend,
        });
    }

    // ─── Skill Activation (dynamic skill loading) ──────────────
    const { ACTIVATE_SKILL_TOOL_NAME, executeActivateSkill } = require('./skillInjection');
    if (toolName === ACTIVATE_SKILL_TOOL_NAME) {
        // agentId/conversationId attribute the skill_activations row this path
        // records with source 'activate_skill' — without them the activation
        // belongs to no agent and no conversation.
        return await executeActivateSkill({
            args: toolArgs,
            orgId,
            userId,
            onSkillsActivated: context.onSkillsActivated,
            agentId: context.agentId || null,
            conversationId: context.conversationId || null,
            // Who starts an automation-linked skill (handoff 5 caller trace).
            callerAgentId: context.callerAgentId || context.agentId || null,
            runScope: runScope || null,
        });
    }
    // ─── Session Skill Runtime (direct-chat local skills) ───────
    const {
        ACTIVATE_SESSION_SKILL_TOOL_NAME,
        COMPLETE_SESSION_SKILL_TOOL_NAME,
        PUBLISH_SESSION_SKILL_TOOL_NAME,
        executeActivateSessionSkill,
        executeCompleteSessionSkill,
        executePublishSessionSkill,
    } = require('./sessionSkillRuntime');
    if (toolName === ACTIVATE_SESSION_SKILL_TOOL_NAME) {
        return await executeActivateSessionSkill({
            args: toolArgs,
            sessionSkills: context.sessionSkills || [],
            activatedSkillIds: context.activatedSessionSkillIds || [],
            completedSkillIds: context.completedSessionSkillIds || [],
        });
    }
    if (toolName === COMPLETE_SESSION_SKILL_TOOL_NAME) {
        return await executeCompleteSessionSkill({
            args: toolArgs,
            sessionSkills: context.sessionSkills || [],
            activatedSessionSkillIds: context.activatedSessionSkillIds || [],
            completedSessionSkillIds: context.completedSessionSkillIds || [],
            roundsInCurrentStep: typeof context.roundsInCurrentStep === 'number' ? context.roundsInCurrentStep : null,
        });
    }
    if (toolName === PUBLISH_SESSION_SKILL_TOOL_NAME) {
        return await executePublishSessionSkill({
            args: toolArgs,
            sessionSkills: context.sessionSkills || [],
            orgId,
            userId,
        });
    }

    // ─── Image Generation ───────────────────────────────────────
    if (toolName === 'generate_image') {
        // Lazy import to avoid circular deps
        const { executeImageGenTool } = require('./imageGenTool');
        let capturedImageData = null;
        const imgSend = (type, data) => {
            if (type === 'image' && data?.data) {
                capturedImageData = data;
            }
            if (send) send(type, data);
        };
        const result = await executeImageGenTool(toolArgs, imageGenSettings, imgSend, req);
        // Enrich captured image data with proxy URL for persistent storage
        if (capturedImageData && onImageGenerated) {
            if (result?.imageUrl) capturedImageData.url = result.imageUrl;
            onImageGenerated(capturedImageData);
        }
        return result;
    }

    // ─── Presentations (.pptx) ──────────────────────────────────
    if (toolName === 'create_presentation') {
        // "Save it in Nextcloud": the same deck through the Nextcloud tool, so
        // the file lands where the user asked and the reply gets a webUrl. A
        // Nextcloud that is not connected answers with its own error, and the
        // deck is then built locally with that error alongside — never lost.
        const ncPath = typeof toolArgs?.nextcloudPath === 'string' ? toolArgs.nextcloudPath.trim() : '';
        if (ncPath) {
            const { nextcloudPath, fileName, ...rest } = toolArgs;
            const path = /\.(pptx|odp)$/i.test(ncPath) ? ncPath : `${ncPath.replace(/\/+$/, '')}/${String(fileName || rest.title || 'presentation').replace(/\.pptx$/i, '')}.pptx`;
            // Through the scope guard, exactly like a direct nextcloud_* call.
            const ncScopeGuard = require('../integrations/ncScopeGuard');
            const ncArgs = { ...rest, path };
            const nc = (await ncScopeGuard.checkToolCall({ toolName: 'nextcloud_create_presentation', toolArgs: ncArgs, userId, orgId }))
                || await executeNextcloudFamilyTool('nextcloud_create_presentation', ncArgs, userId, session, { runScope: runScope || null });
            if (nc && !nc.error) return nc;
            const { executePresentationTool } = require('../../integrations/presentationTools');
            const local = await executePresentationTool(toolArgs, { userId, session, orgId: orgId || session?.connectorOrgId || session?.user?.organizationId || null });
            return { ...local, nextcloud: { error: (nc && nc.error) || 'Nextcloud is not available' }, message: `${local.message || ''} It could NOT be saved to Nextcloud (${(nc && nc.error) || 'not connected'}) — tell the user and give the download link.` };
        }
        const { executePresentationTool } = require('../../integrations/presentationTools');
        return await executePresentationTool(toolArgs, {
            userId,
            session,
            orgId: orgId || session?.connectorOrgId || session?.user?.organizationId || null,
        });
    }

    // ─── Word documents (.docx) ─────────────────────────────────
    if (toolName === 'create_word_document') {
        const { executeWordDocumentTool, nextcloudDocxPath } = require('../../integrations/wordDocumentTools');
        const wordCtx = { userId, session, orgId: orgId || session?.connectorOrgId || session?.user?.organizationId || null };
        // "Save it in Nextcloud": the destination passes the same scope guard
        // a direct nextcloud_create_document call would. Denied or not
        // connected, the document is still built and kept in Bee Flow storage
        // with the reason alongside (as create_presentation does) — never lost,
        // and nothing reaches Nextcloud.
        const ncPath = nextcloudDocxPath(toolArgs?.nextcloudPath, toolArgs || {});
        if (ncPath) {
            const ncScopeGuard = require('../integrations/ncScopeGuard');
            const denied = await ncScopeGuard.checkToolCall({ toolName: 'nextcloud_create_document', toolArgs: { path: ncPath }, userId, orgId });
            if (denied) wordCtx.nextcloudError = denied.error || 'Nextcloud access was denied';
            else wordCtx.nextcloudPath = ncPath;
        }
        return await executeWordDocumentTool(toolArgs, wordCtx);
    }

    // ─── Video Generation ───────────────────────────────────────
    if (toolName === 'generate_video') {
        const { executeVideoGenTool } = require('./videoGenTool');
        const videoSend = (type, data) => {
            if (send) send(type, data);
        };
        return await executeVideoGenTool(toolArgs, videoSend, req, nanoBananaSettings);
    }

    // ─── ElevenLabs Tools (Music, TTS, SFX) ─────────────────────
    const { isElevenLabsTool, executeElevenLabsTool } = require('./elevenLabsTools');
    if (isElevenLabsTool(toolName)) {
        const elSend = (type, data) => {
            if (send) send(type, data);
        };
        return await executeElevenLabsTool(toolName, toolArgs, elSend, req, nanoBananaSettings);
    }

    // ─── Integration Tools ──────────────────────────────────────
    if (isFirefliesTool(toolName)) {
        return await executeFirefliesTool(toolName, toolArgs, userId);
    }
    if (isRegexGeneratorTool(toolName)) {
        return await executeRegexGeneratorTool(toolName, toolArgs);
    }
    if (isYouTrackTool(toolName)) {
        return await executeYouTrackTool(toolName, toolArgs, userId);
    }
    if (isSignRequestTool(toolName)) {
        return await executeSignRequestTool(toolName, toolArgs, userId);
    }
    if (isGammaTool(toolName)) {
        return await executeGammaTool(toolName, toolArgs, userId);
    }
    if (isAfasTool(toolName)) {
        return await executeAfasTool(toolName, toolArgs, userId);
    }
    if (isNmbrsTool(toolName)) {
        return await executeNmbrsTool(toolName, toolArgs, userId);
    }
    if (isVplanTool(toolName)) {
        return await executeVplanTool(toolName, toolArgs, userId);
    }
    if (isScalewayBillingTool(toolName)) {
        // The run scope lets scaleway_download_invoice keep the PDF for this
        // automation run and hand on a generated_file handle.
        return await executeScalewayBillingTool(toolName, toolArgs, userId, {
            automationId: context.automationId || null,
            runScope: runScope || null,
        });
    }
    {
        // Lazily required: withingsTools pulls in automationAuth (and through it the
        // credential vault), which nothing else on this hot path needs.
        const { isWithingsTool, executeWithingsTool } = require('../../integrations/withingsTools');
        if (isWithingsTool(toolName)) {
            return await executeWithingsTool(toolName, toolArgs, userId);
        }
    }
    if (isGmailTool(toolName)) {
        // `autoSend` is opt-in per-call: only the automation runner sets it
        // (no user is present to confirm a draft). Direct chat / agent chat
        // leave it false so the email_draft → user approves → send flow stays.
        return await executeGmailTool(toolName, toolArgs, session, { autoSend: !!context.autoSend });
    }
    if (isCalendarTool(toolName)) {
        // BFSF-254: pass the requester's IANA timezone through so drafts and
        // the approved create/update carry it — Google rejects bare local
        // dateTimes ("Missing time zone definition for start time").
        return await executeCalendarTool(toolName, toolArgs, session, { timezone: context.timezone || null });
    }
    if (isDocsTool(toolName)) {
        return await executeDocsTool(toolName, toolArgs, session);
    }
    if (isSheetsTool(toolName)) {
        return await executeSheetsTool(toolName, toolArgs, session);
    }
    if (isSlidesTool(toolName)) {
        return await executeSlidesTool(toolName, toolArgs, session);
    }
    if (isDriveTool(toolName)) {
        return await executeDriveTool(toolName, toolArgs, session, { runScope: runScope || null });
    }
    if (isContactsTool(toolName)) {
        return await executeContactsTool(toolName, toolArgs, session);
    }
    if (isKeepTool(toolName)) {
        return await executeKeepTool(toolName, toolArgs, session);
    }
    if (isGoogleGroupsTool(toolName)) {
        return await executeGoogleGroupsTool(toolName, toolArgs, session);
    }
    if (isN8nWorkflowTool(toolName)) {
        // Read-only n8n tools are implicit for every member of an org with n8n
        // configured (umbrella 'n8n' integration toggle gates injection). Only
        // the write/execute bucket is permission-gated via modify_n8n_workflows.
        // Non-LLM callers (pipelines, schedules) also flow through here, so we
        // re-check writes as defense-in-depth vs. the registration-time filter.
        if (userId) {
            const requiredPerm = getN8nToolPermission(toolName);
            if (requiredPerm === 'modify_n8n_workflows') {
                const granted = await hasPermission(userId, requiredPerm, session);
                if (!granted) {
                    return { error: 'You do not have permission to modify n8n workflows. Ask your organisation admin to grant the "Modify n8n Workflows" permission.' };
                }
            }
        }
        return await executeN8nWorkflowTool(toolName, toolArgs, orgId);
    }
    if (isN8nTool(toolName)) {
        // Webhook-trigger tools are implicit for every member once the org has
        // n8n configured — gated only by the umbrella 'n8n' integration toggle
        // at injection time (see integrationTools.js).
        return await executeN8nTool(toolName, toolArgs, orgId, attachments);
    }
    if (isAgentSearchTool(toolName)) {
        // Route by admin-configured search provider (bing / node-search /
        // agent-search service, with node-search fallback for CPU-only deploys).
        // Single source of truth lives in agentSearchTools.executeWebSearch.
        return await executeWebSearch(toolName, toolArgs);
    }
    if (isBrowseWebTool(toolName)) {
        // `send` streams browser_session_queued/start/frame/action/end events so
        // the chat UI shows a live preview while the interactive browser runs.
        // userId/orgId let the inner agent resolve the thinking-tier model.
        //
        // Outside the capture context: this process only talks to the private
        // browser container, so its socket would put "local" on a call that
        // went to the web. The pages the browser read are recorded instead,
        // by host (basis 'browser'); their addresses live in that container.
        const { outsideProbe } = require('../http/egressCapture');
        const answer = await outsideProbe(() => executeBrowseWebTool(toolName, toolArgs, { send, userId, orgId }));
        recordBrowserPeers(toolArgs?.url, answer);
        return answer;
    }

    // ─── Reminder Tool ──────────────────────────────────────────
    if (toolName === 'set_reminder') {
        const reminderStore = require('../../stores/reminderStore');
        if (!userId) return { error: 'Not authenticated' };
        if (!toolArgs.title) return { error: 'Title is required' };
        if (!toolArgs.remind_at) return { error: 'remind_at is required' };
        try {
            const reminder = await reminderStore.createReminder({
                userId,
                title: toolArgs.title,
                message: toolArgs.message || '',
                remindAt: toolArgs.remind_at,
                repeatInterval: toolArgs.repeat_interval || null,
            });
            return { success: true, reminder_id: reminder.id, title: reminder.title, remind_at: reminder.remindAt, repeat_interval: reminder.repeatInterval || 'none' };
        } catch (err) {
            return { error: `Failed to create reminder: ${err.message}` };
        }
    }

    // ─── Cowork Tool ────────────────────────────────────────────
    // Writes to cowork_schedules, not ai_tasks. The plain prompt tasks this
    // used to create were migrated into Cowork and that table no longer has a
    // UI, so anything landing there would be invisible and unmanageable. The
    // tool name stays `set_ai_task`: it is in every model's tool schema and in
    // saved agent configs, and renaming it would silently drop the capability
    // from existing agents.
    if (toolName === 'set_ai_task') {
        const coworkStore = require('../../stores/coworkStore');
        if (!userId) return { error: 'Not authenticated' };
        if (!toolArgs.title) return { error: 'Title is required' };
        if (!toolArgs.prompt) return { error: 'Prompt is required' };
        if (!toolArgs.first_run_at) return { error: 'first_run_at is required' };
        try {
            // Same ceiling as the /api/cowork route — one budget for "how much
            // unattended work may a user queue", however it got queued.
            const maxTasks = (await configStore.getConfig('ai_tasks_max_per_user')) || 10;
            const currentCount = await coworkStore.getScheduleCount(userId);
            if (currentCount >= maxTasks) {
                return { error: `Maximum number of cowork items reached (${maxTasks}). The user needs to delete or pause an existing one first.` };
            }
            const task = await coworkStore.createSchedule({
                userId,
                title: toolArgs.title,
                prompt: toolArgs.prompt,
                repeatInterval: toolArgs.repeat_interval || null,
                nextRunAt: toolArgs.first_run_at,
                modelTier: toolArgs.model_tier || 'fast',
                timezone: context?.timezone || 'UTC',
            });
            return {
                success: true,
                task_id: task.id,
                title: task.title,
                next_run: task.nextRunAt,
                repeat: task.repeatInterval || 'one-time',
                model_tier: task.modelTier,
            };
        } catch (err) {
            return { error: `Failed to create cowork item: ${err.message}` };
        }
    }

    // ─── Notebook Tools (formerly Workspace) ──────────────────────
    if (toolName === 'notebook_read' || toolName === 'notebook_write' || toolName === 'notebook_replace' || toolName === 'notebook_insert' ||
        toolName === 'workspace_read' || toolName === 'workspace_write' || toolName === 'workspace_replace') {
        // BFSF-207 backstop: notebook tools are entitlement-gated at registration;
        // re-check at dispatch so no other injection path can execute them.
        // Mirror registration's org resolution (user's own org — context.orgId is
        // absent in agent chat and may be the LENDER's org under connection lending).
        try {
            const { hasCapability } = require('../entitlements/entitlements');
            const { hasPermission } = require('../../auth/permissions');
            let resolveOrgId = null;
            try { resolveOrgId = (await require('../../stores/userStore').getUser(userId))?.organizationId || null; } catch (_) {}
            const ok = !!userId
                && await hasCapability('notebooks', { userId, orgId: resolveOrgId, session })
                && await hasPermission(userId, 'use_notebooks', session);
            if (!ok) {
                return { error: 'The notebook is not available for this user — the notebooks feature is not included in their plan or has not been enabled for them. Briefly let the user know the notebook is unavailable and continue helping them directly in chat.' };
            }
        } catch (_) {
            return { error: 'The notebook is temporarily unavailable. Continue helping the user directly in chat.' };
        }
        // `userId` is REQUIRED here: the tool's cross-user guard keys off it, and
        // conversationId arrives from the client, so without a caller identity the
        // guard has nothing to compare against and every notebook is reachable.
        return await executeWorkspaceTool(toolName, toolArgs, {
            conversationId: context.conversationId,
            agentId: context.agentId,
            userId,
            session,
        });
    }

    // ─── KB Search Tool ─────────────────────────────────────────
    if (require('../../integrations/memoryTools').isMemoryTool(toolName)) {
        return await require('../../integrations/memoryTools').executeMemoryTool(toolName, toolArgs, { userId, orgId, agentId, session });
    }
    if (require('../../integrations/automationEvolutionTools').isAutomationEvolutionTool(toolName)) {
        // Self-scoped: context.automationId is set by the automation runner only.
        return await require('../../integrations/automationEvolutionTools').executeAutomationEvolutionTool(toolName, toolArgs, { userId, orgId, automationId: context.automationId || null, autoSend: context.autoSend === true });
    }
    if (isKbSearchTool(toolName)) {
        // `testAs` HAS to be forwarded, and this line is the whole reason the
        // simulation is not a false green. `toolRoundExecutor` puts it on the
        // dispatch context and `kbSearchTools` reads `context.testAs` off the
        // one it is handed here — but this branch builds a FRESH object, so a
        // key that is not named here simply does not exist downstream. Without
        // it the tool filters as the plain asker: the auto-injected knowledge
        // is narrowed to the simulated group while the model fetches back
        // exactly what the preview just hid, one tool call later.
        //
        // It is not an identity and it never widens anything — `visibleKbIdsFor`
        // only removes bases from a list the real person may already read.
        return await executeKbSearchTool(toolName, toolArgs, {
            userId,
            agentId,
            conversationId: context.conversationId,
            testAs: context.testAs || null,
        });
    }

    // ─── Datatable as knowledge (read-only, live, as the asker) ──
    // `context.askerUserId`, NOT the `userId` above. That one is the
    // INTEGRATION identity: callers overwrite it with an acting operator
    // (`userAuth.integrationUserId`, which the Support inbox sets) or with a
    // lent connection's owner, so that per-user OAuth tokens resolve. Right
    // for a token, wrong for a row: keyed on it, this tool would read a table
    // as the operator while the person who asked watches the answer.
    // There is no fallback to `userId` on purpose — a caller that does not say
    // who is asking gets a refusal, which is the narrow reading of "I could
    // not tell". `agentId` is load-bearing too: the grants come off that
    // agent's published config.
    if (isDatatableTool(toolName)) {
        return await executeDatatableTool(toolName, toolArgs, {
            userId: context.askerUserId, agentId,
        });
    }

    // ─── KB Ingest Tool (automation-only WRITE; Support Studio template) ───
    if (isKbIngestTool(toolName)) {
        return await executeKbIngestTool(toolName, toolArgs, { orgId, userId });
    }

    // ─── Maps Tools ─────────────────────────────────────────────
    if (isMapsTool(toolName)) {
        return await executeMapsTool(toolName, toolArgs);
    }
    if (isLinkedInTool(toolName)) {
        return await executeLinkedInTool(toolName, toolArgs, session);
    }
    if (isGitHubTool(toolName)) {
        return await executeGitHubTool(toolName, toolArgs, userId);
    }
    // ─── Nextcloud (scope-guarded) ──────────────────────────────
    // ONE enforcement point for the per-user Nextcloud access scope: every
    // nextcloud_* tool — chat, automations, AI tasks, cowork, Studio apps
    // all funnel through executeTool — passes ncScopeGuard.checkToolCall
    // before its family executor runs, and 'filter'-policy list tools get
    // their results trimmed afterwards. The guard can only deny or filter
    // (narrow-only relative to isAppOn/entitlements) and fails CLOSED when
    // the scope store is unreadable. See core/integrations/ncScopeGuard.js.
    if (toolName.startsWith('nextcloud_')) {
        const ncScopeGuard = require('../integrations/ncScopeGuard');
        const denial = await ncScopeGuard.checkToolCall({ toolName, toolArgs, userId, orgId });
        if (denial) return denial;
        const raw = await executeNextcloudFamilyTool(toolName, toolArgs, userId, session, { runScope: runScope || null });
        if (raw !== undefined) {
            return await ncScopeGuard.filterResult({ toolName, result: raw, userId, orgId });
        }
        // No family matched (a nextcloud_-prefixed tool owned elsewhere) —
        // fall through to the remaining dispatchers below.
    }
    if (isSupportTool(toolName)) {
        return await executeSupportTool(toolName, toolArgs, {
            userId, session, userAuth,
            supportThreadId: context.supportThreadId,
            supportActionPolicy: userAuth?.supportActionPolicy || null,
        });
    }
    if (isWebpageAutomationTool(toolName)) {
        return await executeWebpageAutomationTool(toolName, toolArgs, {
            userId,
            organizationId: orgId,
            userGroupIds: context.userGroupIds || [],
            userOrgIds: context.userOrgIds || (orgId ? [orgId] : []),
        });
    }
    if (isOutlookTool(toolName)) {
        // A Google (or Nextcloud) session may carry Outlook tools when the user
        // connected Microsoft 365 separately (getIntegrationTools adds them off
        // the vault credential). Graph must then get a Microsoft-only shim,
        // never this session's foreign token; a Microsoft session passes
        // through unchanged. `autoSend` follows gmail_compose exactly.
        const { resolveMicrosoftSession } = require('../../auth/microsoftSessionHydration');
        const msSession = (await resolveMicrosoftSession(session, userId)) || session;
        return await executeOutlookTool(toolName, toolArgs, msSession, { autoSend: !!context.autoSend });
    }
    if (isMsCalendarTool(toolName)) {
        return await executeMsCalendarTool(toolName, toolArgs, session);
    }
    if (isOneDriveTool(toolName)) {
        return await executeOneDriveTool(toolName, toolArgs, session);
    }
    if (isMsContactsTool(toolName)) {
        return await executeMsContactsTool(toolName, toolArgs, session);
    }
    if (isTranscriptionTool(toolName)) {
        return await executeTranscriptionTool(toolName, toolArgs, { userId, session, attachments, req });
    }

    // ─── Agent-Callable Automations (trigger.kind === 'agent_call') ─
    // These tools are per-user and named dynamically (toolName or
    // automation_<id>), so they can't be matched by a static isXxxTool guard.
    // Look the caller's active automations up by name and dispatch to the runner.
    //
    // Handoff 5: the call carries who is calling (the agent, the
    // conversation, and the run when an AI step inside an automation calls it),
    // and an automation that is already three agent starts deep is refused
    // (automation/automationCallDepth.js). A failure of the START comes back
    // as `{ error, code }` for the model to read; only a failed LOOKUP falls
    // through to the next matcher, as before.
    const automationCallCtx = {
        userId,
        agentId: context.agentId || null,
        callerAgentId: context.callerAgentId || null,
        conversationId: context.conversationId || null,
        runScope: runScope || null,
    };
    if (userId) {
        let match = null;
        let tools = null;
        try {
            tools = require('../../automation/agentCallableTools');
            const agentTools = await tools.getAgentCallableToolsForUser(userId);
            match = agentTools.find(t => t?.function?.name === toolName) || null;
        } catch (e) {
            log.warn('[ToolDispatcher] agent-callable automation lookup failed:', e.message);
        }
        if (match) {
            try {
                return await tools.dispatchAgentCallableTool(match.__automation, toolArgs, automationCallCtx);
            } catch (e) {
                log.warn(`[ToolDispatcher] agent-callable automation ${match.__automation?.id} not started: ${e.message}`);
                return require('../../automation/automationCallDepth').toolErrorFor(e);
            }
        }
    }

    // ─── Reusable Steps (kind='block') exposed as chat tools ────
    // Named step_<title>; matched the same dynamic way as agent-callable
    // automations and dispatched to runStepAsTool (owner-only, runs as caller).
    if (userId) {
        let match = null;
        let tools = null;
        try {
            tools = require('../../automation/agentCallableTools');
            const stepTools = await tools.getStepToolsForUser(userId);
            match = stepTools.find(t => t?.function?.name === toolName) || null;
        } catch (e) {
            log.warn('[ToolDispatcher] Step tool lookup failed:', e.message);
        }
        if (match) {
            try {
                return await tools.dispatchStepTool(match.__step, toolArgs, automationCallCtx);
            } catch (e) {
                log.warn(`[ToolDispatcher] Step tool ${match.__step?.id} not started: ${e.message}`);
                return require('../../automation/automationCallDepth').toolErrorFor(e);
            }
        }
    }

    // ─── Progressive-disclosure safety net ─────────────────────
    // If the name belongs to a heavy integration group but no executor above
    // claimed it, the model likely referenced a tool it never loaded. Hand
    // back a recoverable hint instead of a confusing "unknown tool" so it can
    // self-correct via load_tools. (No-op for the normal Claude path, which
    // can only emit tools that were actually sent.)
    try {
        const { toolNameToGroupKey } = require('./toolDisclosure');
        const grp = toolNameToGroupKey(toolName);
        if (grp) {
            return { error: `Tool "${toolName}" belongs to the "${grp}" group, which isn't loaded yet. Call load_tools({groups:["${grp}"]}) first, then call this tool.` };
        }
    } catch (_) { /* non-fatal — fall through to component lookup */ }

    // ─── Fallback: Component Tools ──────────────────────────────
    return await executeComponentTool(toolName, toolArgs, userAuth, fixedParams, agentId);
}

/**
 * The hosts a browse_web call read, as egress peers of the current probe:
 * the start URL, and the "Pages read" list executeBrowseWebTool appends. Only
 * that list is parsed, never the answer above it (page text can say anything).
 */
function recordBrowserPeers(startUrl, answer) {
    try {
        const { recordPeer } = require('../http/egressCapture');
        const urls = [];
        if (typeof startUrl === 'string' && startUrl.trim()) urls.push(startUrl.trim());
        const text = typeof answer === 'string' ? answer : '';
        const marker = text.lastIndexOf('**Pages read:**');
        if (marker !== -1) {
            for (const m of text.slice(marker).matchAll(/^- (https?:\/\/\S+)$/gm)) urls.push(m[1]);
        }
        for (const u of urls) {
            let host = null;
            try { host = new URL(u).hostname; } catch (_) { continue; }
            recordPeer({ host, ip: null, basis: 'browser', method: 'GET', sentBody: false });
        }
    } catch (_) { /* a missing peer must never fail the browse */ }
}

/**
 * The Nextcloud family chain, extracted so the scope guard wraps it at one
 * site. Sub-apps must dispatch BEFORE the generic nextcloud check —
 * isNextcloudTool matches the broad "nextcloud_*" prefix. Returns undefined
 * when no family matched (the caller falls through to other dispatchers).
 */
async function executeNextcloudFamilyTool(toolName, toolArgs, userId, session, extra = {}) {
    if (isNextcloudCalendarTool(toolName)) {
        return await executeNextcloudCalendarTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudContactsTool(toolName)) {
        return await executeNextcloudContactsTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudDeckTool(toolName)) {
        return await executeNextcloudDeckTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudNotificationsTool(toolName)) {
        return await executeNextcloudNotificationsTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudTalkTool(toolName)) {
        return await executeNextcloudTalkTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudTasksTool(toolName)) {
        return await executeNextcloudTasksTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudNotesTool(toolName)) {
        return await executeNextcloudNotesTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudMailTool(toolName)) {
        return await executeNextcloudMailTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudActivityTool(toolName)) {
        return await executeNextcloudActivityTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudTablesTool(toolName)) {
        return await executeNextcloudTablesTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudFormsTool(toolName)) {
        return await executeNextcloudFormsTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudTeamsTool(toolName)) {
        return await executeNextcloudTeamsTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudStatusTool(toolName)) {
        return await executeNextcloudStatusTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudTool(toolName)) {
        return await executeNextcloudTool(toolName, toolArgs, userId, session, extra);
    }
    return undefined;
}

// The one entry point: the dispatcher behind the egress chokepoint, which
// writes the ledger row for callers that have no capture context of their own.
const executeTool = createEgressChokepoint(dispatchTool);

module.exports = { executeTool, executeNextcloudFamilyTool };
