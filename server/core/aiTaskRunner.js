/**
 * AI Task Runner — the execution engine behind Cowork schedules.
 *
 * coworkRunner.js polls cowork_schedules every 60 seconds and hands each due
 * schedule to `executeTask` here, which runs it via the LLM (non-streaming)
 * and delivers the result as a notification. A schedule with an agent runs
 * through that agent's full runtime.
 *
 * Runs use the owner's connected integrations (Gmail, Calendar, Drive, etc.)
 * by resolving their active session from the DB.
 *
 * The old `ai_tasks` table (prompt tasks and agent schedules) has no poller of
 * its own any more: both moved to Cowork (migrations/prompt-tasks-to-cowork-
 * 2026-08 and agent-tasks-to-cowork-2026-10).
 */

const { featureModule } = require('./featureModules');
const { utcOffsetString } = require('./llm/clock');
const { resolveModelForTier, resolveEffectiveOrgId, TIER_DEFAULTS } = require('./llm/modelResolver');
const { getProviderForModel } = require('./aiAgent');
const { getAdapter } = require('./providers');
const { pool } = require('../db');
const terminationStore = require('../stores/terminationStore');
const { sanitizeError } = require('./privacy/errorSanitizer');
const log = require('../telemetry/log');
const { createUsageAccumulator, usageLogFields } = require('./providers/usageNormalizer');

const { executeAgentRun } = require('./cowork/agentScheduleRun');
const { runPromptToolLoop, MAX_TOOL_ITERATIONS } = require('./cowork/promptTaskLoop');
const { fallback, bestEffort } = require('../utils/bestEffort');

const REPEAT_WORDS = {
    hourly: 'every hour',
    daily: 'every day',
    weekdays: 'every weekday',
    weekly: 'every week',
    biweekly: 'every two weeks',
    monthly: 'every month',
    quarterly: 'every quarter',
    yearly: 'every year',
};

const DOW_WORDS = {
    sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
    thu: 'Thursday', fri: 'Friday', sat: 'Saturday',
};

/**
 * State this run's own schedule in plain words.
 *
 * Without it the model only knows it is "a scheduled task" — not that the
 * repeat the brief asks for is already in place. Faced with "every morning,
 * send me X" it would do the work and then append a caveat explaining that it
 * cannot repeat itself and that the user should go set up a recurring
 * automation — advice for something the user had already done, on every single
 * run. Telling it the schedule removes the reason to guess.
 */
function describeTaskSchedule(task) {
    const parts = [];
    const days = Array.isArray(task.daysOfWeek) && task.daysOfWeek.length > 0
        ? task.daysOfWeek.map(d => DOW_WORDS[String(d).toLowerCase().slice(0, 3)]).filter(Boolean)
        : null;

    if (days && days.length > 0) {
        parts.push(`This task runs automatically on ${days.join(', ')}`);
    } else if (task.repeatInterval && REPEAT_WORDS[task.repeatInterval]) {
        parts.push(`This task runs automatically ${REPEAT_WORDS[task.repeatInterval]}`);
    } else {
        return 'This is a one-time run that the user scheduled deliberately.';
    }

    if (task.timeOfDay) parts.push(`at ${task.timeOfDay}`);
    return `${parts.join(' ')} — the repeat is already set up and will keep running without any further action.`;
}

/**
 * Build a minimal system prompt for task execution.
 */
function buildTaskSystemPrompt(task, toolHint) {
    // Compute "Now:" in the task's timezone with explicit offset. The long
    // weekday format stays (a scheduled task reasons about "next Tuesday");
    // the seconds went, for the same reason as everywhere else (core/llm/
    // clock.js): a prompt that changes every second is never a cache hit.
    const tz = task.timezone || 'Europe/Amsterdam';
    let nowStr;
    try {
        const now = new Date();
        // Format: "Tuesday, April 8, 2026, 15:12"
        const datePart = now.toLocaleString('en-US', {
            timeZone: tz,
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
            hour12: false,
        });
        nowStr = `${datePart} (UTC${utcOffsetString(now, tz)}, ${tz})`;
    } catch (_) {
        nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
    }

    return `You are BeeFlow AI Task Runner — executing a scheduled task on behalf of a user.
Your job is to complete the task described below concisely and deliver actionable results.

## This run's schedule
${describeTaskSchedule(task)}

## Guidelines
- Be concise and structured. Use bullet points, headings, and numbered lists.
- Focus on the most important, relevant information.
- If the task requires web search, use the search tool proactively.
- Do NOT ask follow-up questions — this runs unattended.
- Include sources/links when available.
- Use the user's connected integrations when relevant to the task.
- IMPORTANT: The current time shown below is in the USER'S local timezone. Use this time for all time references.
- Deliver ONLY the result. The user set this schedule up themselves and sees it
  in Bee Flow, so never add closing notes about how often this runs, never say
  you cannot repeat or reschedule yourself, and never suggest creating a
  recurring automation or reminder. No meta-commentary about your own
  capabilities or about this being a single run.
${toolHint ? '\n' + toolHint : ''}

Now: ${nowStr}`;
}

/**
 * Resolve the user's active session from the PostgreSQL session store.
 * Returns a session-like object with oauthProvider, accessToken, refreshToken.
 */
async function resolveUserSession(userId) {
    try {
        const { rows } = await pool.query(
            `SELECT sess FROM user_sessions 
             WHERE sess::jsonb -> 'user' ->> 'id' = $1
             AND expire > NOW()
             ORDER BY expire DESC LIMIT 1`,
            [userId]
        );
        if (rows.length === 0) {
            log.info(`[AITaskRunner] No active session found for user ${userId}`);
            return null;
        }
        const sess = typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess;
        return sess;
    } catch (err) {
        log.error(`[AITaskRunner] Session lookup error for user ${userId}:`, err.message);
        return null;
    }
}

/**
 * How a finished (or failed) run announces itself.
 *
 * Its own notification category so the bell can label it "Cowork" and link
 * back to /app/cowork/<id> — the run notification was the one place a user
 * could see their cowork and have no way to reach it.
 */
const NOTIFICATION = Object.freeze({
    category: 'cowork',
    // No link: the notification IS the result, and the one thing you
    // want next is to talk about it. The client offers "Open result in
    // chat" instead of bouncing you to the schedule you already know
    // about. Failures are the exception — see below.
    link: null,
    failureTitle: 'Cowork failed',
    noun: 'cowork item',
    // Titles carry no 🤖: the emoji said "a robot did this" on every
    // single result, which is the one thing the user already knew.
    prefix: '',
});

/** `source` and `agent_type` of the usage and termination rows a run writes. */
const SOURCE = 'cowork';

/**
 * A schedule repeats either via repeatInterval or via a daysOfWeek list —
 * cowork composes "every Monday at 09:00" as daysOfWeek with a null interval,
 * so keying repeat-vs-one-off on repeatInterval alone silently turns those
 * into one-shots.
 */
function isRepeating(task) {
    return !!(task.repeatInterval || (Array.isArray(task.daysOfWeek) && task.daysOfWeek.length > 0));
}

/**
 * Execute one Cowork schedule.
 *
 * Two execution modes:
 *   - A plain prompt (`task.agentId == null`): inline LLM loop with the
 *     user's integration tools, no agent context.
 *   - Run as an agent (`task.agentId` set): dispatch through the full agent
 *     runtime so the agent's system prompt, attached skills, knowledge bases,
 *     guardrails, memory, and integrations all participate. Result lands in a
 *     persistent conversation thread on that agent.
 *
 * `store` is the persistence side of a run — markRunning / markCompleted /
 * markError / advanceSchedule / updateTask. It is coworkStore, which opens a
 * history row per attempt; a test hands in a fake.
 */
async function executeTask(task, { manual = false, store = require('../stores/coworkStore') } = {}) {
    if (task.agentId) {
        // Same reason as buildTaskSystemPrompt's schedule section: an agent
        // that doesn't know the repeat is already in place tends to close
        // every run by advising the user to set one up.
        return executeAgentRun(task, { manual, store }, {
            scheduleText: describeTaskSchedule(task), resolveUserSession, isRepeating, failRun, NOTIFICATION,
        });
    }
    const startTime = Date.now();
    log.info(`[AITaskRunner] Executing task "${task.title}" (${task.id})`);

    // Spend state for this run — outside the try so the error path can still
    // account for tokens burned before the failure: a run that dies on
    // iteration 19 has paid for 18 real model rounds. One accumulator over
    // every round of the loop (providers/usageNormalizer.js): tokens, cache
    // read/write (with the 5m/1h split), tier and tool counts.
    const run = { userOrgForTier: null, modelId: null, usageAcc: createUsageAccumulator(), lastIter: 0, usageLogged: false };

    try {
        // coworkStore labels the history row it opens for this attempt with it.
        await store.markRunning(task.id, { triggerKind: manual ? 'manual' : 'schedule' });

        const prep = await prepareTaskRun(task, run);
        const terminationBase = () => ({
            user_id: task.userId || null,
            agent_id: task.agentId || null,
            agent_name: task.title || null,
            model: run.modelId,
            source: 'schedule',
            conversation_id: task.id || null,
            iteration_count: run.lastIter,
            duration_ms: Date.now() - startTime,
            prompt_tokens: run.usageAcc.total().prompt_tokens,
            completion_tokens: run.usageAcc.total().completion_tokens,
            total_tokens: run.usageAcc.total().prompt_tokens + run.usageAcc.total().completion_tokens,
        });

        // Tool-calling loop (max iterations) — see ./cowork/promptTaskLoop.
        const tierDefaults = TIER_DEFAULTS[task.modelTier] || TIER_DEFAULTS.thinking;
        const loop = await runPromptToolLoop({
            ...prep, modelId: run.modelId, tierDefaults, usageAcc: run.usageAcc, run,
            dispatchTool: (toolName, toolArgs) => dispatchTaskTool(task, run, prep.session, toolName, toolArgs),
            logTermination: (type) => terminationStore.logTermination({ ...terminationBase(), termination_type: type }).catch((e) => fallback('core/aiTaskRunner:logTermination', e)),
        });

        // Account for the spend the moment the model loop is over — before any
        // of the persistence below can throw and divert to the catch path
        // (usageLogged guards against double-logging in that case).
        logRunUsage(task, run, startTime);

        // If we exited via the iteration cap, the model kept calling tools
        // without ever producing a final answer. Do NOT fall back to interim
        // assistant text — that text is usually a thinking-aloud sentence
        // ("Ik zoek tegelijkertijd het laatste nieuws…") and surfacing it as
        // the result is more misleading than a clear failure message.
        if (loop.hitIterationCap) {
            terminationStore.logTermination({ ...terminationBase(), termination_type: 'max_iterations', iteration_count: MAX_TOOL_ITERATIONS }).catch((e) => bestEffort('core/aiTaskRunner:executeTask', e));
        }
        const finalResponse = promptRunOutcome(task, loop, { messages: prep.messages, tools: prep.tools });

        // Store result
        await store.markCompleted(task.id, finalResponse);

        // Create notification
        const notificationStore = require('../stores/notificationStore');
        const shape = NOTIFICATION;
        await notificationStore.createNotification({
            userId: task.userId,
            taskId: task.id,
            category: shape.category,
            title: `${shape.prefix}${task.title}`,
            message: finalResponse,
            link: shape.link,
        });

        await advanceAfterTaskRun(task, { manual, store, startTime });
    } catch (err) {
        log.error(`[AITaskRunner] Task "${task.title}" failed:`, err.message);
        // The tokens spent before the failure are still spent — account for
        // them (no-op when the run never reached the model, or already logged).
        logRunUsage(task, run, startTime);
        terminationStore.logTermination({
            user_id: task.userId || null,
            agent_id: task.agentId || null,
            agent_name: task.title || null,
            source: 'schedule',
            conversation_id: task.id || null,
            duration_ms: Date.now() - startTime,
            termination_type: 'error',
            ...sanitizeError(err),
        }).catch((e) => bestEffort('core/aiTaskRunner:executeTask#2', e));
        await failRun(task, err, { manual, store });
    }
}

/**
 * Log this run's spend through the SAME sink as interactive chats
 * (usageStore.logUsage → ai_usage_log; it derives cost, FX and PAYG itself),
 * so scheduled work shows up on the org dashboard and counts against quota
 * instead of running for free. Attribution is an explicit field list — the
 * allow-list form — under the owner and the effective org the tier was
 * already resolved with. SOURCE ('cowork') is both source and agent_type,
 * matching the notification and the termination log.
 *
 * Fire-and-forget with a warn (the terminationStore pattern): usage logging
 * is bookkeeping, not a gatekeeper — a failing log must never fail the run.
 * Logs once per run, and not at all before the first model call.
 */
function logRunUsage(task, run, startTime) {
    if (run.usageLogged || run.lastIter === 0) return; // nothing spent before the first model call
    run.usageLogged = true;
    const warn = (err) => log.warn(
        `[AITaskRunner] Usage log failed for cowork ${task.id} (run unaffected): ${err.message}`);
    try {
        require('../stores/usageStore').logUsage({
            user_id: task.userId || null,
            agent_id: task.agentId || null,
            agent_name: task.title || null,
            agent_type: SOURCE,
            model: run.modelId,
            source: SOURCE,
            conversation_id: task.id || null,
            ...usageLogFields(run.usageAcc.total()),
            duration_ms: Date.now() - startTime,
            organization_id: run.userOrgForTier || null,
        }).catch(warn);
    } catch (err) {
        warn(err);
    }
}

/**
 * Everything a plain-prompt run needs before its first model round: the
 * model and adapter for the task's tier, the owner's session and integration
 * tools, the messages (through the Cowork privacy shield) and the tool gate.
 * Writes `run.userOrgForTier` and `run.modelId`.
 */
async function prepareTaskRun(task, run) {
    // Resolve the model for this task's tier — WITH the owner's org and
    // user id. Without them the resolver sees no org, applyEUOverrides
    // never fires and an org custom tier can't resolve: an org that
    // switched EU mode on got EU models in chat while its scheduled runs
    // silently kept calling the non-EU model. `{}` rather than null —
    // resolveUserOrgIds reads `req.session` off the object. A failed org
    // lookup degrades to the global tier map (the old behaviour), never
    // to a failed task.
    run.userOrgForTier = await resolveEffectiveOrgId({}, { userId: task.userId }).catch((e) => fallback('core/aiTaskRunner:prepareTaskRun', e, null));
    run.modelId = await resolveModelForTier(`tier:${task.modelTier || 'fast'}`, {
        userOrgId: run.userOrgForTier,
        userId: task.userId,
    });
    if (!run.modelId) {
        throw new Error(`Could not resolve model for tier: ${task.modelTier || 'fast'}`);
    }

    const config = await getProviderForModel(run.modelId);
    const adapter = getAdapter(config.providerType, config.url);

    if (!adapter || typeof adapter.chat !== 'function') {
        throw new Error(`Provider adapter does not support non-streaming chat`);
    }

    // ── Resolve user session & integrations ─────────────────
    const session = await resolveUserSession(task.userId);
    const { tools, toolHint } = await loadTaskTools(task, session);

    const messages = [
        { role: 'system', content: buildTaskSystemPrompt(task, toolHint) },
        { role: 'user', content: task.prompt },
    ];

    // ── Privacy shield on the non-agent path (CW-10) ─────────
    // Behind the per-org opt-in flag (core/entitlements/coworkShieldFlag):
    // when ON, the input runs through the exact PII passage the agent
    // runtime applies before its first model call — resolveShieldFor +
    // validateInputForPii, with the agent path's failmode semantics
    // (BFSF-269: fail-closed on a degraded guard unless the org chose
    // fail_open). A masking action swaps task.prompt for its tokenized
    // form in-place; a block ('PII Detected') or a fail-closed outage
    // throws — before any adapter call — into the caller's catch, so the run
    // fails visibly (urgent notification) instead of sending unscanned
    // text to the model. Flag OFF or no org: the helper returns null
    // without touching the shield stack — byte-identical behaviour.
    // Lazy require, like the other optional collaborators in this file.
    await require('./cowork/coworkShield').applyCoworkShieldToInput({
        orgId: run.userOrgForTier,
        userId: task.userId,
        messages,
    });
    // The same opt-in decides whether the shield's tool block lists
    // ("Outside tools" / "Own server") hold in the tool loop (BFSF-354).
    // Flag OFF: null, and the loop runs exactly as before.
    const shieldGate = require('./privacy/toolPiiGate').toolLoopGate({
        shield: tools.length > 0
            ? await require('./cowork/coworkShield').resolveCoworkToolShield({ orgId: run.userOrgForTier, userId: task.userId })
            : null,
        tag: 'AITaskRunner',
        audit: (fields) => require('../stores/guardrailEventStore').logGuardrailEvent({
            organization_id: run.userOrgForTier || null, user_id: task.userId || null,
            agent_name: task.title || null, conversation_id: task.id || null,
            ...fields, source: SOURCE, model: run.modelId,
        }),
    });
    return { config, adapter, session, tools, messages, shieldGate };
}

/** The owner's integration tools and their system-prompt hint; at least web search when that fails. */
async function loadTaskTools(task, session) {
    let tools = [];
    let toolHint = '';
    try {
        const { getIntegrationTools, buildToolHint } = require('./integrations/integrationTools');
        const result = await getIntegrationTools({
            userId: task.userId,
            session: session,
            isAdmin: false,
            // A cowork item can carry its own, narrower app list — "this
            // one may read my mail, that one may not". null (every prompt
            // task, and any cowork that never set one) means the user's
            // workspace-wide preference decides, as it always did.
            enabledAppsOverride: Array.isArray(task.enabledApps) ? task.enabledApps : null,
        });
        tools = result.tools || [];
        toolHint = await buildToolHint(tools, task.userId);
        log.info(`[AITaskRunner] Loaded ${tools.length} integration tools for user ${task.userId}`);
    } catch (err) {
        log.warn(`[AITaskRunner] Failed to load integration tools: ${err.message}`);
        // Fallback: try to load at least web search
        try {
            const { AGENT_SEARCH_TOOLS } = featureModule('integrations/agentSearchTools');
            tools = [...AGENT_SEARCH_TOOLS];
        } catch (err) { fallback('core/aiTaskRunner:loadTaskTools', err); /* no search available */ }
    }
    return { tools, toolHint };
}

/** Execute one tool call of a plain-prompt run via the unified dispatcher. */
async function dispatchTaskTool(task, run, session, toolName, toolArgs) {
    const { executeTool } = require('./tools/toolDispatcher');
    const result = await executeTool(toolName, toolArgs, {
        userId: task.userId,
        session: session,
        // Nobody is watching a scheduled run. Without this,
        // gmail_compose returns an "email draft prepared —
        // waiting for user approval" object, and there is
        // no approval surface for a task run: the mail is
        // never sent, while the run reports success and
        // tells the user it drafted something. A cowork
        // whose whole brief is "email me every morning"
        // then silently does nothing. Scheduling the job is
        // the authorisation — same call the automation
        // runner makes on a live run.
        autoSend: true,
        // ...but keep custom integrations dispatching
        // exactly as they did before: their runner refuses
        // unattended calls, so inheriting autoSend here
        // would turn working schedules into hard failures.
        unattended: false,
        // The dispatcher's chokepoint writes this call's
        // egress row; these say whose run it was.
        egress: {
            source: SOURCE,
            model: run.modelId,
            ids: {
                organization_id: run.userOrgForTier || null,
                user_id: task.userId || null,
                agent_name: task.title || null,
                conversation_id: task.id || null,
            },
        },
    });
    return result;
}

/** The result text of a plain-prompt run: never empty, at most 50,000 chars. */
function promptRunOutcome(task, { finalResponse, lastAssistantContent, hitIterationCap }, { messages, tools }) {
    if (!finalResponse || !finalResponse.trim()) {
        log.warn(`[AITaskRunner] Schedule "${task.title}" (${task.id}) produced no outcome text. ` +
            `hitIterationCap=${hitIterationCap}, ` +
            `messages=${messages.length}, ` +
            `tools=${tools.length}, ` +
            `lastInterim=${lastAssistantContent.length} chars`);
        finalResponse = hitIterationCap
            ? `_(Deze cowork bereikte de limiet van ${MAX_TOOL_ITERATIONS} tool-aanroepen voordat een eindresultaat werd geproduceerd. Splits de prompt op of koppel een agent met grotere context.)_`
            : `_(Deze cowork is uitgevoerd, maar er is geen tekstresultaat geproduceerd.)_`;
    }

    // Truncate if needed (safety net — ignore task.maxResultLength since DB defaults to 2000)
    const maxLen = 50000;
    if (finalResponse.length > maxLen) {
        finalResponse = finalResponse.substring(0, maxLen) + '\n\n… (truncated)';
    }
    return finalResponse;
}

/** Advance the schedule after a successful plain-prompt run (not for a manual run-now). */
async function advanceAfterTaskRun(task, { manual, store, startTime }) {
    if (isRepeating(task) && !manual) {
        const next = await store.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval, task.daysOfWeek);
        log.info(`[AITaskRunner] Task "${task.title}" completed (${Date.now() - startTime}ms), next run: ${next}`);
    } else if (isRepeating(task) && manual) {
        log.info(`[AITaskRunner] Task "${task.title}" completed manually (${Date.now() - startTime}ms), next scheduled run unchanged: ${task.nextRunAt}`);
    } else {
        // One-time task → deactivate
        await store.updateTask(task.id, { isActive: false });
        log.info(`[AITaskRunner] Task "${task.title}" completed (one-time, ${Date.now() - startTime}ms)`);
    }
}

/**
 * A failed run of either kind: mark the error, keep the schedule moving, and
 * tell the owner.
 */
async function failRun(task, err, { manual, store }) {
    await store.markError(task.id, err);

    // Still advance schedule on error (don't let errors block future runs) — but not for manual runs
    if (isRepeating(task) && !manual) {
        await store.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval, task.daysOfWeek);
    } else if (!manual) {
        // A failed one-off must come off the scheduler: markError leaves it
        // active with next_run_at in the past, so the minute tick would
        // retry it — one model call and one urgent notification per minute
        // — forever. The failure notification below is the retry signal.
        await store.updateTask(task.id, { isActive: false });
    }

    // Notify user about failure
    try {
        const notificationStore = require('../stores/notificationStore');
        const shape = NOTIFICATION;
        await notificationStore.createNotification({
            userId: task.userId,
            taskId: task.id,
            category: 'urgent',
            title: `⚠️ ${shape.failureTitle}: ${task.title}`,
            message: `The scheduled ${shape.noun} "${task.title}" failed to execute: ${err.message}`,
            // A failure is the one case where the schedule itself is what
            // you need to reach, so this one does link back.
            link: require('../utils/appPaths').coworkTaskPath(task.id),
        });
    } catch (err) { bestEffort('core/aiTaskRunner:failRun', err); /* don't fail on notification failure */ }
}

// ── Background timer ─────────────────────────────────────
// Unref'd: a janitor timer has no business keeping the process alive on its
// own (it hung `node --test` on every suite that merely required this module).

// R3: prune expired schedule_coverage memories once per hour. Keeps the
// "previously covered" addendum from suppressing topics forever (default TTL
// is 30 days inside memoryStore).
const _coveragePruneInterval = setInterval(async () => {
    try {
        const memoryStore = require('../stores/memoryStore');
        const expired = await memoryStore.pruneExpiredCoverage();
        if (expired > 0) log.info(`[AITaskRunner] R3: pruned ${expired} expired coverage memorie(s)`);
    } catch (err) {
        log.warn(`[AITaskRunner] R3 prune failed: ${err.message}`);
    }
}, 60 * 60_000);
if (_coveragePruneInterval.unref) _coveragePruneInterval.unref();

log.info('[AITaskRunner] Coverage prune armed (hourly)');

/**
 * Stop every timer this module armed at require time.
 *
 * Unref'ing keeps the timers from holding the process open, but it does not
 * make them cancellable, and a background sweep that nothing can ever call off
 * is a defect in its own right in a long-running server. A caller that is
 * shutting down, or a test that wants the module inert, now has a way.
 */
function stop() {
    clearInterval(_coveragePruneInterval);
}

module.exports = {
    executeTask,
    stop,
};
