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
const defaultTerminationStore = require('../../stores/terminationStore');
const { sanitizeError } = require('../privacy/errorSanitizer');
const log = require('../../telemetry/log');
const { extractCoverageTopics } = require('./coverageTopics');
const { bestEffort, fallback } = require('../../utils/bestEffort');
const { createRunActivity } = require('./runActivity.mts');
const { skillNamesOf, conversationForRun, runCloseOf, runNotification } = require('./agentRunRecord.mts');
const { startRunDeadline } = require('./runDeadline.mts');
const { claimAttempt } = require('./runClaim.mts');
const { agentRoutinesAllowed } = require('./agentRoutinesGate.mts');

/**
 * Execute a schedule as its agent: dispatch through the full agent runtime so
 * the agent's system prompt, attached skills, knowledge bases, integrations,
 * and guardrails all participate. Result lands in a persistent conversation
 * thread so the user can open it from the notification and continue chatting.
 *
 * `trigger` marks a run started by an event (a new mail) rather than the clock: see EventRunTrigger.
 */
async function executeAgentRun(task, { manual = false, store = require('../../stores/coworkStore'), trigger = /** @type {EventRunTrigger | null} */ (null), due = false, maxMs = /** @type {number | undefined} */ (undefined) } = {}, deps) {
    const { scheduleText, resolveUserSession, isRepeating, failRun, NOTIFICATION } = deps;
    const services = servicesOf(deps);
    const startTime = Date.now();
    log.info(`[AITaskRunner] Executing ${task.id} as agent ${task.agentId}`);

    // What the run does, in names and counts (./runActivity.mts); a follow-up carries the ceiling of the run it continues.
    const coworkRun = createRunActivity({ toolCeiling: trigger?.toolCeiling ?? null });
    /** @type {{ runId: string | null, agent: RuntimeAgent | null, conversationId: string | null, parts: ReturnType<typeof eventRunParts> | null }} */
    const run = { runId: trigger?.runId ?? null, agent: null, conversationId: null, parts: null };
    // The time limit of this run (./runDeadline.mts): the agent runtime takes the signal and stops the turn on it.
    const deadline = startRunDeadline(maxMs);

    try {
        // The claim (./runClaim.mts): refused when another attempt holds this schedule or (`due`, the tick) its
        // moment was already run; nothing ran here then. An event run's row was opened at its own claim.
        if (!trigger) {
            const attempt = await claimAttempt(store, task, { manual, due });
            if (!attempt) return;
            run.runId = attempt.runId;
        }

        const agent = await services.agentStore.getForRuntime(task.agentId);
        if (!agent) throw new Error(`Linked agent ${task.agentId} no longer exists`);
        run.agent = agent;
        if (!(await services.canRunAgent(agent, task.userId))) throw new Error('Schedule agent is no longer available to this user — refusing to run');
        if (!(await agentRoutinesAllowed(task, agent, store, { runId: run.runId, eventRun: !!trigger, orgHasBetaFeature: services.orgHasBetaFeature }))) {
            if (trigger) await store.markError(task.id, 'agent_routines unavailable', { runId: run.runId }); // an event is not retried: close its row
            return;
        }

        const userAuth = await buildScheduleUserAuth(task, agent, resolveUserSession, services.buildUserAuth);
        run.parts = eventRunParts(task, scheduleText, trigger);
        run.parts.extraMetadata = { ...run.parts.extraMetadata, coworkRun, conversationOrigin: 'cowork', signal: deadline.signal };
        const thread = { ...task, conversationId: await conversationForRun(task, services.agentStore) };
        const { result, finalResponse: streamed, collected, replaced } = await runScheduleAgent(thread, agent, userAuth, run.parts, services.chatWithAgentStream);
        run.conversationId = result?.conversationId || task.conversationId || null;

        let finalResponse = streamed;
        if (!finalResponse || !finalResponse.trim()) {
            finalResponse = await recoverOutcomeFromConversation(task, result, services.agentStore, userAuth) || finalResponse;
        }

        if (!finalResponse || !finalResponse.trim()) {
            log.warn(`[AITaskRunner] Schedule ${task.id} produced no outcome text. ` +
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

        await store.markCompleted(task.id, truncated, await runCloseOf(task, run, coworkRun, trigger, services.skillNames));
        await storeScheduleCoverage(task, agent, truncated);

        // The notification opens the run in Cowork, where its conversation, its activity and a review live.
        try {
            await services.notificationStore.createNotification(runNotification(task, agent, truncated, { trigger, review: coworkRun.review, shape: NOTIFICATION }));
        } catch (err) { bestEffort('core/cowork/agentScheduleRun:executeAgentRun#2', err); /* non-fatal */ }

        // Schedule advance — same rules as legacy tasks; an event run touches neither the clock nor is_active.
        if (trigger) {
            log.info(`[AITaskRunner] Event run for ${task.id} completed (${Date.now() - startTime}ms)`);
        } else if (isRepeating(task) && !manual) {
            const next = await store.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval, task.daysOfWeek);
            log.info(`[AITaskRunner] Schedule ${task.id} completed (${Date.now() - startTime}ms), next run: ${next}`);
        } else if (isRepeating(task) && manual) {
            log.info(`[AITaskRunner] Schedule ${task.id} completed manually (${Date.now() - startTime}ms)`);
        } else {
            await store.updateTask(task.id, { isActive: false });
            log.info(`[AITaskRunner] Schedule ${task.id} completed (one-time, ${Date.now() - startTime}ms)`);
        }
    } catch (caught) {
        // A run stopped by its deadline surfaces as the runtime's abort error; the owner reads why it stopped.
        await failAgentRun(task, deadline.reasonFor(caught), caught, { run, coworkRun, trigger, manual, store, startTime, services, failRun });
    } finally {
        deadline.clear();
    }
}

/**
 * A run as an agent that failed: write its termination row unless the runtime already did, close its own history row
 * with what it did, and hand it to failRun (mark, move on, notify). `err` is what the owner reads; `caught` is what
 * was thrown (an abort error, when the deadline passed).
 */
async function failAgentRun(task, reason, caught, { run, coworkRun, trigger, manual, store, startTime, services, failRun }) {
    const err = /** @type {Error} */ (reason);
    log.error(`[AITaskRunner] Schedule ${task.id} failed:`, err.message);
    if (!(/** @type {{ _terminationLogged?: boolean } | null} */ (caught))?._terminationLogged) {
        services.terminationStore.logTermination({
            user_id: task.userId || null,
            agent_id: task.agentId || null,
            agent_name: task.title || null,
            source: 'schedule',
            conversation_id: task.conversationId || task.id || null,
            duration_ms: Date.now() - startTime,
            termination_type: 'error',
            ...sanitizeError(err),
        }).catch((e) => bestEffort('core/cowork/agentScheduleRun:failAgentRun', e));
    }
    // An event run is never a one-off: a failure must not take the trigger off (failRun deactivates a failed one-off).
    const close = await runCloseOf(task, run, coworkRun, trigger, services.skillNames).catch((e) => fallback('core/cowork/agentScheduleRun:failAgentRun#2', e, { runId: run.runId }));
    await failRun(task, err, { manual: manual || !!trigger, store, close: { ...close, review: null } });
}

/**
 * Resolve OAuth credentials for this schedule. Default path: long-lived
 * encrypted vault (`automation_credentials`) with auto-refresh, so the
 * schedule works even when the user is offline. The legacy session-borrow
 * path is kept behind AUTOMATION_AUTH_LEGACY=1 for one release in case of
 * regressions.
 */
async function buildScheduleUserAuth(task, agent, resolveUserSession, buildUserAuth) {
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
    const enabledIntegrations = Array.isArray(agent?.config?.enabledIntegrations)
        ? agent.config.enabledIntegrations
        : [];
    const built = await buildUserAuth(task.userId, { enabledIntegrations });
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
 * The collaborators of a run: the real ones, unless the caller (a test) hands others in `deps.services`.
 * @param {AgentRunDeps} deps
 */
function servicesOf(deps) {
    const own = deps.services || {};
    return {
        agentStore: own.agentStore || require('../../stores/agentStore'),
        notificationStore: own.notificationStore || require('../../stores/notificationStore'),
        terminationStore: own.terminationStore || defaultTerminationStore,
        chatWithAgentStream: own.chatWithAgentStream || require('../agentRuntime').chatWithAgentStream,
        buildUserAuth: own.buildUserAuth || require('../../auth/automationAuth').buildUserAuth,
        canRunAgent: own.canRunAgent || require('./coworkAgentAccess.mts').canRunCoworkAgent,
        // Undefined unless handed in: agentRoutinesAllowed then reads the entitlement service itself.
        orgHasBetaFeature: own.orgHasBetaFeature,
        skillNames: own.skillNames || skillNamesOf,
    };
}

/**
 * What a run feeds the agent: the schedule's own prompt and text, or — for an event run — the event's.
 * @param {ScheduleTask} task
 * @param {string} scheduleText
 * @param {EventRunTrigger | null} trigger
 * @returns {{ scheduleText: string, prompt: string, extraMetadata: Record<string, unknown> }}
 */
function eventRunParts(task, scheduleText, trigger) {
    if (!trigger) return { scheduleText, prompt: /** @type {string} */ (task.prompt), extraMetadata: {} };
    return { scheduleText: trigger.scheduleText || scheduleText, prompt: trigger.prompt, extraMetadata: trigger.metadata };
}

/**
 * A run started by a mail: whether a reply in the thread may also go to the others on To and Cc is the agent
 * owner's setting (`replyAll` on the Gmail / Outlook entry), put on the mail-trigger context the reply tools read.
 * @param {Record<string, unknown> | undefined} extraMetadata
 * @param {{ config?: { tools?: unknown } | null } | null | undefined} agent
 */
function applyOwnerMailSettings(extraMetadata, agent) {
    const mailTrigger = /** @type {{ provider?: string, replyAll?: boolean } | undefined} */ (extraMetadata?.mailTrigger);
    if (!mailTrigger || typeof mailTrigger !== 'object') return;
    const tools = /** @type {Record<string, unknown> | null} */ (agent?.config?.tools ?? null);
    mailTrigger.replyAll = require('../agentRuntime/toolPolicy/mailRun.mts').replyAllAllowed(tools, mailTrigger.provider);
}

/**
 * Run the schedule's prompt through the agent's streaming runtime. Resolves to
 * the runtime's result, the answer as best the stream gave it, and what was
 * streamed / replaced (for the no-outcome log line).
 */
async function runScheduleAgent(task, agent, userAuth, { scheduleText, prompt, extraMetadata }, chatWithAgentStream) {

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
        // An event run adds what it knows (unattended, mailTrigger): the tool stack and the reply tools read it.
        ...extraMetadata,
    };
    applyOwnerMailSettings(extraMetadata, agent);

    // Capture both the streaming token deltas AND any post-stream content
    // replacements (the runtime emits `content_replace` after stripping
    // tool-call XML or after content moderation rewrites the response —
    // missing those events leaves schedules with an empty outcome).
    let collected = '';
    let replaced = null;
    const result = await chatWithAgentStream(
        task.agentId,
        task.userId,
        prompt,
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
 * A run started by an event instead of the clock (core/cowork/mailTriggerRun.mts), or a follow-up of a reviewed run
 * (usecases/coworkReview.mts): the prompt to run (the schedule's text plus the event as marked data, or the reviewer's
 * answer), the extra message metadata (`unattended`, `mailTrigger`), and how its notification reads. Its history row
 * is already open: `runId` names it. A follow-up also carries `toolCeiling`, the tool names the run it continues was
 * offered, and a mail run the subject for the review queue.
 * @typedef {{
 *   prompt: string,
 *   scheduleText?: string,
 *   metadata: Record<string, unknown>,
 *   notification: (info: { agentName: string, task: ScheduleTask }) => { title: string, message: string },
 *   runId?: string | null,
 *   toolCeiling?: string[] | null,
 *   mailSubject?: string | null,
 * }} EventRunTrigger
 */

/**
 * What aiTaskRunner hands in (see the module docblock).
 * @typedef {{
 *   scheduleText: string,
 *   resolveUserSession: (userId: string) => Promise<Record<string, any> | null>,
 *   isRepeating: (task: ScheduleTask) => boolean,
 *   failRun: (task: ScheduleTask, err: Error, opts: { manual: boolean, store: typeof import('../../stores/coworkStore'), close?: Record<string, unknown> }) => Promise<void>,
 *   NOTIFICATION: { category: string, link: string | null, prefix: string },
 *   services?: { agentStore?: any, notificationStore?: any, terminationStore?: any, chatWithAgentStream?: any, buildUserAuth?: any, canRunAgent?: (agent: any, userId: string) => Promise<boolean>, skillNames?: (ids: string[], orgId: string | null, userId: string) => Promise<Map<string, string>>, orgHasBetaFeature?: (orgId: string, feature: string) => Promise<boolean> },
 * }} AgentRunDeps
 */
