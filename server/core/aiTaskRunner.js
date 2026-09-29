/**
 * AI Task Runner — Background execution engine for scheduled AI tasks.
 *
 * Runs every 60 seconds, picks up due tasks, executes them via the
 * LLM (non-streaming), and delivers results as notifications.
 *
 * Tasks now use the owner's connected integrations (Gmail, Calendar,
 * Drive, etc.) by resolving their active session from the DB.
 */

const aiTaskStore = require('../stores/aiTaskStore');
const { utcOffsetString } = require('./llm/clock');
const { resolveModelForTier, resolveEffectiveOrgId, TIER_DEFAULTS } = require('./llm/modelResolver');
const { getProviderForModel } = require('./aiAgent');
const { getAdapter } = require('./providers');
const { pool } = require('../db');
const terminationStore = require('../stores/terminationStore');
const { sanitizeError } = require('./privacy/errorSanitizer');
const log = require('../telemetry/log');

const RUNNER_INTERVAL_MS = 60_000; // 60 seconds
const MAX_CONCURRENT = 5;
// Routines that fan out across several topics (news digests, multi-source
// research) routinely chain 6-8 tool calls before producing a final answer.
// Capping at 5 used to silently truncate them — the loop would exit with no
// final assistant text and the user got a blank notification. Bumped to 20
// after Opus 4.7 agent runs were hitting the cap at ~15 rounds.
const MAX_TOOL_ITERATIONS = 20;

/**
 * R3: cheap, deterministic topic extraction from a routine result. Looks for
 * markdown headings (### Topic) and numbered list items (1) Topic — summary)
 * — the two patterns the wizard's routines tend to emit. Falls back to
 * top-level headings only when no enumeration is found.
 *
 * Returns `[{ subject, title, summary }]`. `subject` is a stable slug used
 * as the dedupe key across runs.
 */
function _slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}
function extractCoverageTopics(text) {
    if (!text || typeof text !== 'string') return [];
    const out = [];
    const seen = new Set();
    const push = (title, summary) => {
        const cleanTitle = String(title).replace(/\*\*|__|\[|\]\(.*?\)/g, '').trim();
        if (cleanTitle.length < 4 || cleanTitle.length > 200) return;
        const subject = _slugify(cleanTitle);
        if (!subject || seen.has(subject)) return;
        seen.add(subject);
        out.push({ subject, title: cleanTitle, summary: summary ? String(summary).trim().slice(0, 280) : null });
    };

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        // Numbered item:  "1) Title — summary"  or  "1. Title: summary"
        const numbered = line.match(/^\s*\d+[\.\)]\s+(.+?)(?:\s*[—:\-]\s+(.*))?$/);
        if (numbered) { push(numbered[1], numbered[2] || lines[i + 1]); continue; }
        // Bold-led bullet:  "**Title** — summary"
        const boldBullet = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*\s*[—:\-]\s+(.+)$/);
        if (boldBullet) { push(boldBullet[1], boldBullet[2]); continue; }
        // Markdown heading at level 3+ (level 1/2 tend to be section names like "Beleid & defensie")
        const heading = line.match(/^\s*#{3,6}\s+(.+?)\s*$/);
        if (heading) { push(heading[1], lines[i + 1]); continue; }
    }
    return out;
}

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
 * How a finished (or failed) run announces itself, per surface.
 *
 * Cowork gets its own notification category so the bell can label it "Cowork"
 * and link back to /app/cowork/<id> — the run notification was the one place
 * a user could see their cowork and have no way to reach it. Agent routines
 * keep 'ai_task', which the client still labels "Routine".
 */
function notificationShape(surface) {
    if (surface === 'cowork') {
        return {
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
        };
    }
    return {
        category: 'ai_task',
        link: null,
        failureTitle: 'Routine failed',
        noun: 'routine',
        prefix: '🤖 ',
    };
}

/**
 * Execute a single AI task.
 *
 * Two execution modes:
 *   - Legacy user-scoped task (`task.agentId == null`): inline LLM loop with
 *     the user's integration tools, no agent context.
 *   - Agent routine (`task.agentId` set): dispatch through the full agent
 *     runtime so the agent's system prompt, attached skills, knowledge bases,
 *     guardrails, memory, and integrations all participate. Result lands in a
 *     persistent conversation thread on that agent.
 *
 * `store` is the persistence side of a run — markRunning / markCompleted /
 * markError / advanceSchedule / updateTask. It defaults to aiTaskStore; Cowork
 * passes coworkStore, which writes the same state to its own tables and opens
 * a history row per attempt. Everything above that line — model resolution,
 * the tool loop, credential handling, outcome recovery, notifications — is
 * identical for both, which is exactly why it is injected rather than forked.
 *
 * `surface` is what the *user* calls this thing, and it only reaches the
 * notification (see notificationShape). Sharing the runner is right; sharing
 * the vocabulary was not — a cowork item's result used to arrive labelled
 * "Routine", which is the name of a different feature in a different part of
 * the app.
 */
/**
 * A schedule repeats either via repeatInterval or via a daysOfWeek list —
 * cowork composes "every Monday at 09:00" as daysOfWeek with a null interval,
 * so keying repeat-vs-one-off on repeatInterval alone silently turns those
 * into one-shots.
 */
function isRepeating(task) {
    return !!(task.repeatInterval || (Array.isArray(task.daysOfWeek) && task.daysOfWeek.length > 0));
}

async function executeTask(task, { manual = false, store = aiTaskStore, surface = 'routine' } = {}) {
    if (task.agentId) {
        return executeAgentRoutine(task, { manual, store, surface });
    }
    const startTime = Date.now();
    log.info(`[AITaskRunner] Executing task "${task.title}" (${task.id})`);

    // Spend state for this run — outside the try so the error path can still
    // account for tokens burned before the failure: a run that dies on
    // iteration 19 has paid for 18 real model rounds.
    let userOrgForTier = null;
    let modelId = null;
    let promptTokensTotal = 0;
    let completionTokensTotal = 0;
    let lastIter = 0;
    let usageLogged = false;

    /**
     * Log this run's spend through the SAME sink as interactive chats
     * (usageStore.logUsage → ai_usage_log; it derives cost, FX and PAYG
     * itself), so scheduled work shows up on the org dashboard and counts
     * against quota instead of running for free. Attribution is an explicit
     * field list — the allow-list form — under the owner and the effective
     * org the tier was already resolved with. `surface` ('routine'|'cowork')
     * doubles as source/agent_type, matching the vocabulary of the
     * notification and the termination log.
     *
     * Fire-and-forget with a warn (the terminationStore pattern above):
     * usage logging is bookkeeping, not a gatekeeper — a failing log must
     * never fail the run.
     */
    const logRunUsage = () => {
        if (usageLogged || lastIter === 0) return; // nothing spent before the first model call
        usageLogged = true;
        const warn = (err) => log.warn(
            `[AITaskRunner] Usage log failed for ${surface} ${task.id} (run unaffected): ${err.message}`);
        try {
            require('../stores/usageStore').logUsage({
                user_id: task.userId || null,
                agent_id: task.agentId || null,
                agent_name: task.title || null,
                agent_type: surface,
                model: modelId,
                source: surface,
                conversation_id: task.id || null,
                prompt_tokens: promptTokensTotal,
                completion_tokens: completionTokensTotal,
                total_tokens: promptTokensTotal + completionTokensTotal,
                duration_ms: Date.now() - startTime,
                organization_id: userOrgForTier || null,
            }).catch(warn);
        } catch (err) {
            warn(err);
        }
    };

    try {
        // The second argument is ignored by aiTaskStore; coworkStore uses it to
        // label the history row it opens for this attempt.
        await store.markRunning(task.id, { triggerKind: manual ? 'manual' : 'schedule' });

        // Resolve the model for this task's tier — WITH the owner's org and
        // user id. Without them the resolver sees no org, applyEUOverrides
        // never fires and an org custom tier can't resolve: an org that
        // switched EU mode on got EU models in chat while its scheduled runs
        // silently kept calling the non-EU model. `{}` rather than null —
        // resolveUserOrgIds reads `req.session` off the object. A failed org
        // lookup degrades to the global tier map (the old behaviour), never
        // to a failed task.
        userOrgForTier = await resolveEffectiveOrgId({}, { userId: task.userId }).catch(() => null);
        modelId = await resolveModelForTier(`tier:${task.modelTier || 'fast'}`, {
            userOrgId: userOrgForTier,
            userId: task.userId,
        });
        if (!modelId) {
            throw new Error(`Could not resolve model for tier: ${task.modelTier || 'fast'}`);
        }

        const config = await getProviderForModel(modelId);
        const adapter = getAdapter(config.providerType, config.url);

        if (!adapter || typeof adapter.chat !== 'function') {
            throw new Error(`Provider adapter does not support non-streaming chat`);
        }

        // ── Resolve user session & integrations ─────────────────
        const session = await resolveUserSession(task.userId);
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
                const { buildAgentSearchTool } = require('../integrations/agentSearchTools');
                if (typeof buildAgentSearchTool === 'function') {
                    tools = [buildAgentSearchTool()];
                }
            } catch (_) { /* no search available */ }
        }

        const systemPrompt = buildTaskSystemPrompt(task, toolHint);

        let messages = [
            { role: 'system', content: systemPrompt },
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
        // throws — before any adapter call — into the catch below, so the run
        // fails visibly (urgent notification) instead of sending unscanned
        // text to the model. Flag OFF or no org: the helper returns null
        // without touching the shield stack — byte-identical behaviour.
        // Lazy require, like the other optional collaborators in this file.
        await require('./cowork/coworkShield').applyCoworkShieldToInput({
            orgId: userOrgForTier,
            userId: task.userId,
            messages,
        });
        // The same opt-in decides whether the shield's tool block lists
        // ("Outside tools" / "Own server") hold in the tool loop below
        // (BFSF-354). Flag OFF: null, and the loop runs exactly as before.
        const shieldGate = require('./privacy/toolPiiGate').toolLoopGate({
            shield: tools.length > 0
                ? await require('./cowork/coworkShield').resolveCoworkToolShield({ orgId: userOrgForTier, userId: task.userId })
                : null,
            tag: 'AITaskRunner',
            audit: (fields) => require('../stores/guardrailEventStore').logGuardrailEvent({
                organization_id: userOrgForTier || null, user_id: task.userId || null,
                agent_name: task.title || null, conversation_id: task.id || null,
                ...fields, source: surface, model: modelId,
            }),
        });

        let finalResponse = '';
        let lastAssistantContent = ''; // tracks any non-empty assistant text seen across iterations
        let hitIterationCap = true;    // flipped to false if the loop exits via `break`

        const terminationBase = () => ({
            user_id: task.userId || null,
            agent_id: task.agentId || null,
            agent_name: task.title || null,
            model: modelId,
            source: 'routine',
            conversation_id: task.id || null,
            iteration_count: lastIter,
            duration_ms: Date.now() - startTime,
            prompt_tokens: promptTokensTotal,
            completion_tokens: completionTokensTotal,
            total_tokens: promptTokensTotal + completionTokensTotal,
        });

        // Tool-calling loop (max iterations)
        const tierDefaults = TIER_DEFAULTS[task.modelTier] || TIER_DEFAULTS.thinking;
        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            lastIter = iter + 1;
            const response = await adapter.chat(config.apiKey, config.url, modelId, messages, {
                maxTokens: tierDefaults.maxTokens,
                temperature: tierDefaults.temperature ?? 0.7,
                tools: tools.length > 0 ? tools : undefined,
                toolChoice: tools.length > 0 ? 'auto' : undefined,
            });
            promptTokensTotal += response?.usage?.prompt_tokens || 0;
            completionTokensTotal += response?.usage?.completion_tokens || 0;

            // Track any assistant text the model produced alongside tool
            // calls — if we later exhaust iterations without a clean break,
            // this is the best outcome we can surface to the user.
            if (response.content && response.content.trim()) {
                lastAssistantContent = response.content;
            }

            if (response.stop_reason === 'max_tokens' || response.stopReason === 'max_tokens' || response.finish_reason === 'length') {
                terminationStore.logTermination({ ...terminationBase(), termination_type: 'max_tokens' }).catch(() => {});
            }

            // Handle tool calls if present
            if (response.toolCalls && response.toolCalls.length > 0) {
                // Add assistant message with tool calls
                // Preserve _thought_signature — required by Gemini 3.x for multi-turn tool calls
                messages.push({
                    role: 'assistant',
                    content: response.content || null,
                    tool_calls: response.toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.function.name,
                            arguments: typeof tc.function.arguments === 'string'
                                ? tc.function.arguments
                                : JSON.stringify(tc.function.arguments),
                        },
                        _thought_signature: tc._thought_signature || undefined,
                        _raw_content_parts: tc._raw_content_parts || undefined,
                    })),
                });

                // Execute each tool call via the unified dispatcher
                const { executeTool } = require('./tools/toolDispatcher');
                for (const tc of response.toolCalls) {
                    const toolName = tc.function.name;
                    let toolArgs;
                    try {
                        toolArgs = typeof tc.function.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : tc.function.arguments;
                    } catch (_) {
                        toolArgs = {};
                    }

                    log.info(`[AITaskRunner]   Tool call: ${toolName}(${JSON.stringify(toolArgs).substring(0, 100)})`);

                    const refusal = await shieldGate.refuse(toolName, toolArgs);
                    if (refusal) {
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: refusal.modelError }) });
                        continue;
                    }

                    let result;
                    try {
                        result = await executeTool(toolName, toolArgs, {
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
                            // would turn working routines into hard failures.
                            unattended: false,
                            // The dispatcher's chokepoint writes this call's
                            // egress row; these say whose run it was.
                            egress: {
                                source: surface,
                                model: modelId,
                                ids: {
                                    organization_id: userOrgForTier || null,
                                    user_id: task.userId || null,
                                    agent_name: task.title || null,
                                    conversation_id: task.id || null,
                                },
                            },
                        });
                    } catch (toolErr) {
                        log.error(`[AITaskRunner]   Tool error (${toolName}):`, toolErr.message);
                        result = { error: toolErr.message };
                    }

                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        // What the model reads, with the categories this
                        // tool's class forbids stripped out (BFSF-354).
                        content: await shieldGate.forModel(typeof result === 'string' ? result : JSON.stringify(result), toolName),
                    });
                }
                // Continue the loop to let the model process tool results
                continue;
            }

            // No tool calls — this is the final response
            finalResponse = response.content || '';
            hitIterationCap = false;
            break;
        }

        // Account for the spend the moment the model loop is over — before any
        // of the persistence below can throw and divert to the catch path
        // (usageLogged guards against double-logging in that case).
        logRunUsage();

        // If we exited via the iteration cap, the model kept calling tools
        // without ever producing a final answer. Do NOT fall back to interim
        // assistant text — that text is usually a thinking-aloud sentence
        // ("Ik zoek tegelijkertijd het laatste nieuws…") and surfacing it as
        // the result is more misleading than a clear failure message.
        if (hitIterationCap) {
            terminationStore.logTermination({ ...terminationBase(), termination_type: 'max_iterations', iteration_count: MAX_TOOL_ITERATIONS }).catch(() => {});
        }

        if (!finalResponse || !finalResponse.trim()) {
            log.warn(`[AITaskRunner] Routine "${task.title}" (${task.id}) produced no outcome text. ` +
                `hitIterationCap=${hitIterationCap}, ` +
                `messages=${messages.length}, ` +
                `tools=${tools.length}, ` +
                `lastInterim=${lastAssistantContent.length} chars`);
            finalResponse = hitIterationCap
                ? `_(${surface === 'cowork' ? 'Deze cowork' : 'De routine'} bereikte de limiet van ${MAX_TOOL_ITERATIONS} tool-aanroepen voordat een eindresultaat werd geproduceerd. Splits de prompt op of koppel een agent met grotere context.)_`
                : `_(${surface === 'cowork' ? 'Deze cowork is' : 'De routine is'} uitgevoerd, maar er is geen tekstresultaat geproduceerd.)_`;
        }

        // Truncate if needed (safety net — ignore task.maxResultLength since DB defaults to 2000)
        const maxLen = 50000;
        if (finalResponse.length > maxLen) {
            finalResponse = finalResponse.substring(0, maxLen) + '\n\n… (truncated)';
        }

        // Store result
        await store.markCompleted(task.id, finalResponse);

        // Create notification
        const notificationStore = require('../stores/notificationStore');
        const shape = notificationShape(surface);
        await notificationStore.createNotification({
            userId: task.userId,
            taskId: task.id,
            category: shape.category,
            title: `${shape.prefix}${task.title}`,
            message: finalResponse,
            link: shape.link,
        });

        // Advance schedule (skip if this was a manual run-now trigger)
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
    } catch (err) {
        log.error(`[AITaskRunner] Task "${task.title}" failed:`, err.message);
        // The tokens spent before the failure are still spent — account for
        // them (no-op when the run never reached the model, or already logged).
        logRunUsage();
        terminationStore.logTermination({
            user_id: task.userId || null,
            agent_id: task.agentId || null,
            agent_name: task.title || null,
            source: 'routine',
            conversation_id: task.id || null,
            duration_ms: Date.now() - startTime,
            termination_type: 'error',
            ...sanitizeError(err),
        }).catch(() => {});
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
            const shape = notificationShape(surface);
            await notificationStore.createNotification({
                userId: task.userId,
                taskId: task.id,
                category: 'urgent',
                title: `⚠️ ${shape.failureTitle}: ${task.title}`,
                message: `The scheduled ${shape.noun} "${task.title}" failed to execute: ${err.message}`,
                // A failure is the one case where the schedule itself is what
                // you need to reach, so this one does link back.
                link: surface === 'cowork' ? require('../utils/appPaths').coworkTaskPath(task.id) : null,
            });
        } catch (_) { /* don't fail on notification failure */ }
    }
}

/**
 * Execute an agent-scoped routine: dispatch through the full agent runtime so
 * the agent's system prompt, attached skills, knowledge bases, integrations,
 * and guardrails all participate. Result lands in a persistent conversation
 * thread so the user can open it from the notification and continue chatting.
 */
async function executeAgentRoutine(task, { manual = false, store = aiTaskStore, surface = 'routine' } = {}) {
    const startTime = Date.now();
    log.info(`[AITaskRunner] Executing routine "${task.title}" (${task.id}) for agent ${task.agentId}`);

    try {
        // The second argument is ignored by aiTaskStore; coworkStore uses it to
        // label the history row it opens for this attempt.
        await store.markRunning(task.id, { triggerKind: manual ? 'manual' : 'schedule' });

        const agentStore = require('../stores/agentStore');
        const agent = await agentStore.getForRuntime(task.agentId);
        if (!agent) throw new Error(`Linked agent ${task.agentId} no longer exists`);
        if (agent.owner_id !== task.userId) throw new Error('Routine agent owner mismatch — refusing to run');

        // Per-org beta-feature gate. The HTTP create/edit surfaces already
        // refuse to schedule routines without `agent_routines`, but an org
        // that *had* the feature enabled and later disabled it would keep
        // firing previously-scheduled routines without this check.
        // FeatureServiceUnavailableError → don't burn the attempt; leave
        // the task to be retried on the next tick (60s).
        if (agent.organization_id) {
            try {
                const { orgHasBetaFeature } = require('./entitlements/betaFeatures');
                const allowed = await orgHasBetaFeature(agent.organization_id, 'agent_routines');
                if (!allowed) {
                    await store.markError(task.id, 'agent_routines beta disabled for organisation');
                    log.info(`[AITaskRunner] skipped routine ${task.id} — agent_routines disabled for org ${agent.organization_id}`);
                    return;
                }
            } catch (e) {
                if (e && e.name === 'FeatureServiceUnavailableError') {
                    log.warn(`[AITaskRunner] beta lookup degraded — deferring routine ${task.id}: ${e.message}`);
                    return; // markRunning already set; ticks pick it back up on retry
                }
                throw e;
            }
        }

        // Resolve OAuth credentials for this routine. Default path: long-lived
        // encrypted vault (`routine_credentials`) with auto-refresh, so the
        // routine works even when the user is offline. The legacy
        // session-borrow path is kept behind ROUTINE_AUTH_LEGACY=1 for one
        // release in case of regressions.
        const useLegacy = process.env.ROUTINE_AUTH_LEGACY === '1';
        let userAuth;
        if (useLegacy) {
            const session = await resolveUserSession(task.userId);
            userAuth = {
                accessToken: session?.accessToken || null,
                nextcloudUrl: null,
                appPasswordUsername: session?.appPassword?.username || null,
                appPassword: session?.appPassword?.password || null,
                encryptionKey: session?.encryptionKey || null,
                userId: task.userId,
                session,
                userOrgId: session?.user?.organizationId || agent.organization_id || null,
            };
        } else {
            const routineAuth = require('../auth/routineAuth');
            const enabledIntegrations = Array.isArray(agent?.config?.enabledIntegrations)
                ? agent.config.enabledIntegrations
                : [];
            const built = await routineAuth.buildUserAuth(task.userId, { enabledIntegrations });
            if (!built) {
                // buildUserAuth already paused dependent routines + emitted a
                // reauth notification. Surface the error on this run so the
                // task row reflects the failure.
                throw new Error('needs_reauth: required OAuth provider expired or revoked');
            }
            userAuth = {
                accessToken: built.accessToken,
                refreshToken: built.refreshToken,
                oauthProvider: built.oauthProvider,
                routineProviders: built.routineProviders,
                nextcloudUrl: null,
                appPasswordUsername: null,
                appPassword: null,
                encryptionKey: null,
                userId: task.userId,
                userOrgId: agent.organization_id || null,
            };
        }

        const { chatWithAgentStream } = require('./agentRuntime');

        // Per-routine tier override (optional). Falls back to whatever the
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
            // addendum from past runs of the SAME routine.
            routineId: task.id,
            // Same reason as buildTaskSystemPrompt's schedule section: an agent
            // that doesn't know the repeat is already in place tends to close
            // every run by advising the user to set one up.
            routineSchedule: describeTaskSchedule(task),
            // See the executeTool call in the non-agent path: an unattended run
            // has no one to approve a composed email, so it must send rather
            // than leave a draft that never goes anywhere.
            autoSend: true,
            // Routines are unattended — never block on streaming back to a UI.
            ephemeral: false,
        };

        // Capture both the streaming token deltas AND any post-stream content
        // replacements (the runtime emits `content_replace` after stripping
        // tool-call XML or after content moderation rewrites the response —
        // missing those events used to leave routines with an empty outcome).
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

        let finalResponse = (result?.message && result.message.length > 0)
            ? result.message
            : (replaced && replaced.trim() ? replaced : collected);

        // Fallback: if the runtime returned no assistant text (e.g. the model
        // ended on a tool call, hit max iterations, or content moderation
        // emptied the buffer), recover the last assistant message from the
        // conversation that the routine just wrote to. Without this, the
        // notification card renders blank and the user has no way to see the
        // outcome of the run.
        if (!finalResponse || !finalResponse.trim()) {
            try {
                const convoId = result?.conversationId || task.conversationId;
                if (convoId) {
                    const convo = await agentStore.getConversationById(convoId, userAuth.encryptionKey);
                    const msgs = Array.isArray(convo?.messages) ? convo.messages : [];
                    for (let i = msgs.length - 1; i >= 0; i--) {
                        const m = msgs[i];
                        if (m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
                            finalResponse = m.content;
                            log.info(`[AITaskRunner] Recovered routine outcome from conversation ${convoId} (${finalResponse.length} chars)`);
                            break;
                        }
                    }
                }
            } catch (recoverErr) {
                log.warn(`[AITaskRunner] Outcome recovery failed: ${recoverErr.message}`);
            }
        }

        if (!finalResponse || !finalResponse.trim()) {
            log.warn(`[AITaskRunner] Routine "${task.title}" (${task.id}) produced no outcome text. ` +
                `result.message=${result?.message?.length || 0} chars, ` +
                `streamed=${collected.length} chars, ` +
                `replaced=${replaced?.length || 0} chars, ` +
                `convoId=${result?.conversationId || task.conversationId || 'none'}, ` +
                `guardrailViolation=${result?.guardrailViolation || 'none'}, ` +
                `toolCalls=${result?.toolCalls?.length || 0}`);
            finalResponse = `_(${surface === 'cowork' ? 'Deze cowork is' : 'De routine is'} uitgevoerd, maar er is geen tekstresultaat geproduceerd. Open de chat om de uitvoering te bekijken.)_`;
        }

        const truncated = finalResponse.length > 50000
            ? finalResponse.substring(0, 50000) + '\n\n… (truncated)'
            : finalResponse;

        // Persist conversation id back onto the task so future runs append to
        // the same chat thread.
        if (result?.conversationId && result.conversationId !== task.conversationId) {
            try { await store.updateTask(task.id, { conversationId: result.conversationId }); }
            catch (_) { /* non-fatal */ }
        }

        await store.markCompleted(task.id, truncated);

        // R3: extract topics this run surfaced and write them to the routine's
        // coverage memory bucket so the next run knows not to repeat them.
        // Only fires when the agent has memory enabled — opt-in by design.
        if (agent?.config?.memoryEnabled === true) {
            try {
                const topics = extractCoverageTopics(truncated);
                if (topics.length > 0) {
                    const memoryStore = require('../stores/memoryStore');
                    await Promise.all(topics.slice(0, 30).map(t => memoryStore.upsertRoutineCoverage({
                        userId: task.userId,
                        agentId: task.agentId,
                        routineId: task.id,
                        subject: t.subject,
                        title: t.title,
                        summary: t.summary,
                    })));
                    log.info(`[AITaskRunner] R3: stored ${Math.min(topics.length, 30)} coverage memorie(s) for routine ${task.id}`);
                }
            } catch (err) {
                log.warn(`[AITaskRunner] R3 coverage extraction failed: ${err.message}`);
            }
        }

        // Notification with deep link to the conversation so the user can open
        // it and continue chatting.
        try {
            const notificationStore = require('../stores/notificationStore');
            const shape = notificationShape(surface);
            await notificationStore.createNotification({
                userId: task.userId,
                taskId: task.id,
                category: shape.category,
                title: `${shape.prefix}${agent.name || 'Agent'}: ${task.title}`,
                message: truncated,
                link: shape.link,
            });
        } catch (_) { /* non-fatal */ }

        // Schedule advance — same rules as legacy tasks.
        if (isRepeating(task) && !manual) {
            const next = await store.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval, task.daysOfWeek);
            log.info(`[AITaskRunner] Routine "${task.title}" completed (${Date.now() - startTime}ms), next run: ${next}`);
        } else if (isRepeating(task) && manual) {
            log.info(`[AITaskRunner] Routine "${task.title}" completed manually (${Date.now() - startTime}ms)`);
        } else {
            await store.updateTask(task.id, { isActive: false });
            log.info(`[AITaskRunner] Routine "${task.title}" completed (one-time, ${Date.now() - startTime}ms)`);
        }
    } catch (err) {
        log.error(`[AITaskRunner] Routine "${task.title}" failed:`, err.message);
        if (!err?._terminationLogged) {
            terminationStore.logTermination({
                user_id: task.userId || null,
                agent_id: task.agentId || null,
                agent_name: task.title || null,
                source: 'routine',
                conversation_id: task.conversationId || task.id || null,
                duration_ms: Date.now() - startTime,
                termination_type: 'error',
                ...sanitizeError(err),
            }).catch(() => {});
        }
        await store.markError(task.id, err);
        if (isRepeating(task) && !manual) {
            await store.advanceSchedule(task.id, task.nextRunAt, task.repeatInterval, task.daysOfWeek);
        } else if (!manual) {
            // Same as executeTask: a failed one-off stays active with a stale
            // next_run_at and would be retried by the minute tick forever.
            await store.updateTask(task.id, { isActive: false });
        }
        try {
            const notificationStore = require('../stores/notificationStore');
            const shape = notificationShape(surface);
            await notificationStore.createNotification({
                userId: task.userId,
                taskId: task.id,
                category: 'urgent',
                title: `⚠️ ${shape.failureTitle}: ${task.title}`,
                message: `The scheduled ${shape.noun} "${task.title}" failed to execute: ${err.message}`,
                // A failure is the one case where the schedule itself is what
                // you need to reach, so this one does link back.
                link: surface === 'cowork' ? require('../utils/appPaths').coworkTaskPath(task.id) : null,
            });
        } catch (_) { /* don't fail on notification failure */ }
    }
}

/**
 * Process all due tasks (called every 60s by setInterval).
 */
async function processDueTasks() {
    try {
        const dueTasks = await aiTaskStore.getDueTasks();
        if (dueTasks.length === 0) return;

        log.info(`[AITaskRunner] Found ${dueTasks.length} due task(s)`);

        // Process with concurrency limit
        const batches = [];
        for (let i = 0; i < dueTasks.length; i += MAX_CONCURRENT) {
            batches.push(dueTasks.slice(i, i + MAX_CONCURRENT));
        }

        for (const batch of batches) {
            await Promise.allSettled(batch.map(task => executeTask(task)));
        }
    } catch (err) {
        log.error('[AITaskRunner] Background checker error:', err.message);
    }
}

// ── Start background runner ──────────────────────────────
// All three handles are UNREF'd. A janitor timer has no business keeping the
// process alive on its own: nothing here is worth delaying a shutdown for, and
// a 60s interval that the event loop must wait on is what hung `node --test`
// on every suite that merely required this module — three of them, silently,
// until the runner stopped cutting its own output short.
//
// The shape is coworkRunner.js:96-109, whose comment already says it copied
// its start-up from here. This file was the straggler: `_coveragePruneInterval`
// below was unref'd and these two were not.
const _interval = setInterval(processDueTasks, RUNNER_INTERVAL_MS);
if (_interval.unref) _interval.unref();
// First run after 10s (let stores initialize)
const _firstRun = setTimeout(processDueTasks, 10_000);
if (_firstRun.unref) _firstRun.unref();

// R3: prune expired routine_coverage memories once per hour. Keeps the
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

log.info('[AITaskRunner] Background runner started (60s interval)');

/**
 * Stop every timer this module armed at require time.
 *
 * Unref'ing keeps the timers from holding the process open, but it does not
 * make them cancellable, and a background sweep that nothing can ever call off
 * is a defect in its own right in a long-running server. A caller that is
 * shutting down, or a test that wants the module inert, now has a way.
 */
function stop() {
    clearInterval(_interval);
    clearTimeout(_firstRun);
    clearInterval(_coveragePruneInterval);
}

module.exports = {
    processDueTasks,
    executeTask,
    stop,
};
