// @typecheck
/**
 * A Cowork schedule run AS ITS AGENT (executeTask in core/aiTaskRunner.js
 * hands it here): dispatch through the full agent runtime so the agent's
 * system prompt, attached skills, knowledge bases, integrations and
 * guardrails all participate.
 *
 * What the two run modes share — the schedule description, the session
 * lookup, the repeat rule, the failure path and the notification shape — is
 * handed in by aiTaskRunner as `deps`, so this module does not require it
 * back.
 */
const terminationStore = require('../../stores/terminationStore');
const { sanitizeError } = require('../privacy/errorSanitizer');
const log = require('../../telemetry/log');
const { extractCoverageTopics } = require('./coverageTopics');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * Execute a schedule as its agent: dispatch through the full agent runtime so
 * the agent's system prompt, attached skills, knowledge bases, integrations,
 * and guardrails all participate. Result lands in a persistent conversation
 * thread so the user can open it from the notification and continue chatting.
 */
async function executeAgentRun(task, { manual = false, store = require('../../stores/coworkStore') } = {}, deps) {
    const { scheduleText, resolveUserSession, isRepeating, failRun, NOTIFICATION } = deps;
    const startTime = Date.now();
    log.info(`[AITaskRunner] Executing "${task.title}" (${task.id}) as agent ${task.agentId}`);

    try {
        // coworkStore labels the history row it opens for this attempt with it.
        await store.markRunning(task.id, { triggerKind: manual ? 'manual' : 'schedule' });

        const agentStore = require('../../stores/agentStore');
        const agent = await agentStore.getForRuntime(task.agentId);
        if (!agent) throw new Error(`Linked agent ${task.agentId} no longer exists`);
        if (agent.owner_id !== task.userId) throw new Error('Schedule agent owner mismatch — refusing to run');
        if (!(await agentRoutinesAllowed(task, agent, store))) return;

        const userAuth = await buildScheduleUserAuth(task, agent, resolveUserSession);
        const { result, finalResponse: streamed, collected, replaced } = await runScheduleAgent(task, agent, userAuth, scheduleText);

        let finalResponse = streamed;
        if (!finalResponse || !finalResponse.trim()) {
            finalResponse = await recoverOutcomeFromConversation(task, result, agentStore, userAuth) || finalResponse;
        }

        if (!finalResponse || !finalResponse.trim()) {
            log.warn(`[AITaskRunner] Schedule "${task.title}" (${task.id}) produced no outcome text. ` +
                `result.message=${result?.message?.length || 0} chars, ` +
                `streamed=${collected.length} chars, ` +
                `replaced=${replaced?.length || 0} chars, ` +
                `convoId=${result?.conversationId || task.conversationId || 'none'}, ` +
                `guardrailViolation=${result?.guardrailViolation || 'none'}, ` +
                `toolCalls=${result?.toolCalls?.length || 0}`);
            finalResponse = `_(Deze cowork is uitgevoerd, maar er is geen tekstresultaat geproduceerd. Open de chat om de uitvoering te bekijken.)_`;
        }

        const truncated = finalResponse.length > 50000
            ? finalResponse.substring(0, 50000) + '\n\n… (truncated)'
            : finalResponse;

        // Persist conversation id back onto the task so future runs append to
        // the same chat thread.
        if (result?.conversationId && result.conversationId !== task.conversationId) {
            try { await store.updateTask(task.id, { conversationId: result.conversationId }); }
            catch (err) { bestEffort('core/cowork/agentScheduleRun:executeAgentRun', err); /* non-fatal */ }
        }

        await store.markCompleted(task.id, truncated);
        await storeScheduleCoverage(task, agent, truncated);

        // Notification with deep link to the conversation so the user can open
        // it and continue chatting.
        try {
            const notificationStore = require('../../stores/notificationStore');
            const shape = NOTIFICATION;
            await notificationStore.createNotification({
                userId: task.userId,
                taskId: task.id,
                category: shape.category,
                title: `${shape.prefix}${agent.name || 'Agent'}: ${task.title}`,
                message: truncated,
                link: shape.link,
            });
        } catch (err) { bestEffort('core/cowork/agentScheduleRun:executeAgentRun#2', err); /* non-fatal */ }

        // Schedule advance — same rules as legacy tasks.
        if (isRepeating(task) && !manual) {
            const next = await store.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval, task.daysOfWeek);
            log.info(`[AITaskRunner] Schedule "${task.title}" completed (${Date.now() - startTime}ms), next run: ${next}`);
        } else if (isRepeating(task) && manual) {
            log.info(`[AITaskRunner] Schedule "${task.title}" completed manually (${Date.now() - startTime}ms)`);
        } else {
            await store.updateTask(task.id, { isActive: false });
            log.info(`[AITaskRunner] Schedule "${task.title}" completed (one-time, ${Date.now() - startTime}ms)`);
        }
    } catch (err) {
        log.error(`[AITaskRunner] Schedule "${task.title}" failed:`, /** @type {Error} */ (err).message);
        if (!err?._terminationLogged) {
            terminationStore.logTermination({
                user_id: task.userId || null,
                agent_id: task.agentId || null,
                agent_name: task.title || null,
                source: 'schedule',
                conversation_id: task.conversationId || task.id || null,
                duration_ms: Date.now() - startTime,
                termination_type: 'error',
                ...sanitizeError(err),
            }).catch((e) => bestEffort('core/cowork/agentScheduleRun:executeAgentRun#3', e));
        }
        await failRun(task, err, { manual, store });
    }
}

/**
 * Per-org beta-feature gate. The HTTP create/edit surfaces already refuse to
 * create schedules run as an agent without `agent_routines`, but an org that
 * *had* the feature enabled and later disabled it would keep firing
 * previously-scheduled schedules without this check. False when the run is
 * skipped: disabled (the run is marked as an error), or the feature service
 * degraded (FeatureServiceUnavailableError → don't burn the attempt; leave
 * the task to be retried on the next tick, 60s).
 */
async function agentRoutinesAllowed(task, agent, store) {
    if (!agent.organization_id) return true;
    try {
        const { orgHasBetaFeature } = require('../entitlements/betaFeatures');
        const allowed = await orgHasBetaFeature(agent.organization_id, 'agent_routines');
        if (!allowed) {
            await store.markError(task.id, 'agent_routines beta disabled for organisation');
            log.info(`[AITaskRunner] skipped schedule ${task.id} — agent_routines disabled for org ${agent.organization_id}`);
            return false;
        }
        return true;
    } catch (e) {
        if (e && /** @type {Error} */ (e).name === 'FeatureServiceUnavailableError') {
            log.warn(`[AITaskRunner] beta lookup degraded — deferring schedule ${task.id}: ${/** @type {Error} */ (e).message}`);
            return false; // markRunning already set; ticks pick it back up on retry
        }
        throw e;
    }
}

/**
 * Resolve OAuth credentials for this schedule. Default path: long-lived
 * encrypted vault (`automation_credentials`) with auto-refresh, so the
 * schedule works even when the user is offline. The legacy session-borrow
 * path is kept behind AUTOMATION_AUTH_LEGACY=1 for one release in case of
 * regressions.
 */
async function buildScheduleUserAuth(task, agent, resolveUserSession) {
    const useLegacy = require('../../utils/automationAuthLegacy').automationAuthLegacy() === '1';
    if (useLegacy) {
        const session = await resolveUserSession(task.userId);
        return {
            accessToken: session?.accessToken || null,
            nextcloudUrl: null,
            appPasswordUsername: session?.appPassword?.username || null,
            appPassword: session?.appPassword?.password || null,
            encryptionKey: session?.encryptionKey || null,
            userId: task.userId,
            session,
            userOrgId: session?.user?.organizationId || agent.organization_id || null,
        };
    }
    const automationAuth = require('../../auth/automationAuth');
    const enabledIntegrations = Array.isArray(agent?.config?.enabledIntegrations)
        ? agent.config.enabledIntegrations
        : [];
    const built = await automationAuth.buildUserAuth(task.userId, { enabledIntegrations });
    if (!built) {
        // buildUserAuth already paused dependent schedules + emitted a
        // reauth notification. Surface the error on this run so the
        // task row reflects the failure.
        throw new Error('needs_reauth: required OAuth provider expired or revoked');
    }
    return {
        accessToken: built.accessToken,
        refreshToken: built.refreshToken,
        oauthProvider: built.oauthProvider,
        automationProviders: built.automationProviders,
        nextcloudUrl: null,
        appPasswordUsername: null,
        appPassword: null,
        encryptionKey: null,
        userId: task.userId,
        userOrgId: agent.organization_id || null,
    };
}

/**
 * Run the schedule's prompt through the agent's streaming runtime. Resolves to
 * the runtime's result, the answer as best the stream gave it, and what was
 * streamed / replaced (for the no-outcome log line).
 */
async function runScheduleAgent(task, agent, userAuth, scheduleText) {
    const { chatWithAgentStream } = require('../agentRuntime');

    // Per-schedule tier override (optional). Falls back to whatever the
    // agent itself is configured with.
    const modelTier = task.modelTier && task.modelTier !== 'fast'
        ? task.modelTier
        : (typeof agent.model === 'string' && agent.model.startsWith('tier:') ? agent.model.slice(5) : (task.modelTier || null));

    const messageMetadata = {
        conversationId: task.conversationId || undefined,
        timezone: task.timezone || 'Europe/Amsterdam',
        modelTier: modelTier || undefined,
        userOrgId: userAuth.userOrgId,
        orgId: userAuth.userOrgId,
        // R3: contextBuilder reads this to inject the "previously covered"
        // addendum from past runs of the SAME schedule.
        scheduleId: task.id,
        // The schedule in plain words (describeTaskSchedule in
        // core/aiTaskRunner.js, handed in).
        scheduleText,
        // See the executeTool call in the non-agent path: an unattended run
        // has no one to approve a composed email, so it must send rather
        // than leave a draft that never goes anywhere.
        autoSend: true,
        // Schedules are unattended — never block on streaming back to a UI.
        ephemeral: false,
    };

    // Capture both the streaming token deltas AND any post-stream content
    // replacements (the runtime emits `content_replace` after stripping
    // tool-call XML or after content moderation rewrites the response —
    // missing those events used to leave schedules with an empty outcome).
    let collected = '';
    let replaced = null;
    const result = await chatWithAgentStream(
        task.agentId,
        task.userId,
        task.prompt,
        userAuth,
        (type, data) => {
            if (type === 'content' && data?.text) collected += data.text;
            else if (type === 'content_replace' && typeof data?.text === 'string') replaced = data.text;
        },
        null,
        messageMetadata,
    );

    const finalResponse = (result?.message && result.message.length > 0)
        ? result.message
        : (replaced && replaced.trim() ? replaced : collected);
    return { result, finalResponse, collected, replaced };
}

/**
 * Fallback: if the runtime returned no assistant text (e.g. the model ended
 * on a tool call, hit max iterations, or content moderation emptied the
 * buffer), recover the last assistant message from the conversation that the
 * schedule just wrote to. Without this, the notification card renders blank
 * and the user has no way to see the outcome of the run. Null when nothing
 * was recovered.
 */
async function recoverOutcomeFromConversation(task, result, agentStore, userAuth) {
    try {
        const convoId = result?.conversationId || task.conversationId;
        if (!convoId) return null;
        const convo = await agentStore.getConversationById(convoId, userAuth.encryptionKey);
        const msgs = Array.isArray(convo?.messages) ? convo.messages : [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
                log.info(`[AITaskRunner] Recovered schedule outcome from conversation ${convoId} (${m.content.length} chars)`);
                return m.content;
            }
        }
    } catch (recoverErr) {
        log.warn(`[AITaskRunner] Outcome recovery failed: ${/** @type {Error} */ (recoverErr).message}`);
    }
    return null;
}

/**
 * R3: extract topics this run surfaced and write them to the schedule's
 * coverage memory bucket so the next run knows not to repeat them. Only fires
 * when the agent has memory enabled — opt-in by design.
 * @param {string} text
 */
async function storeScheduleCoverage(task, agent, text) {
    if (agent?.config?.memoryEnabled !== true) return;
    try {
        const topics = extractCoverageTopics(text);
        if (topics.length > 0) {
            const memoryStore = require('../../stores/memoryStore');
            await Promise.all(topics.slice(0, 30).map(t => memoryStore.upsertScheduleCoverage({
                userId: task.userId,
                agentId: task.agentId,
                scheduleId: task.id,
                subject: t.subject,
                title: t.title,
                summary: t.summary,
            })));
            log.info(`[AITaskRunner] R3: stored ${Math.min(topics.length, 30)} coverage memorie(s) for schedule ${task.id}`);
        }
    } catch (err) {
        log.warn(`[AITaskRunner] R3 coverage extraction failed: ${/** @type {Error} */ (err).message}`);
    }
}

module.exports = { executeAgentRun };

/**
 * The schedule fields a run as agent reads (coworkStore's rowToSchedule shape).
 * @typedef {import('../aiTaskRunner').CoworkTask & { conversationId?: string | null }} ScheduleTask
 */

/** @typedef {NonNullable<Awaited<ReturnType<typeof import('../../stores/agentStore').getForRuntime>>>} RuntimeAgent */

/**
 * What aiTaskRunner hands in (see the module docblock).
 * @typedef {{
 *   scheduleText: string,
 *   resolveUserSession: (userId: string) => Promise<Record<string, any> | null>,
 *   isRepeating: (task: ScheduleTask) => boolean,
 *   failRun: (task: ScheduleTask, err: Error, opts: { manual: boolean, store: typeof import('../../stores/coworkStore') }) => Promise<void>,
 *   NOTIFICATION: { category: string, link: string | null, prefix: string },
 * }} AgentRunDeps
 */
