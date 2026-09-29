/**
 * AI Tasks Routes — REST API for user-bound scheduled AI tasks.
 *
 * GET    /              → list user's AI tasks (`?agentId=` narrows to one agent)
 * POST   /              → create AI task (pass `startNow` to also run it right away)
 * PUT    /:id           → update AI task
 * DELETE /:id           → delete AI task
 * POST   /:id/toggle    → toggle active/inactive
 * POST   /:id/run-now   → force immediate execution
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * The list query and both bodies are zod schemas, `.strict()`, so a
 * misspelled key is a 400 that names it instead of a 200 that ignored it.
 * What the hand-rolled readers let through, each under a 200:
 *
 *   - `?agentId=` sent twice, left empty or misspelled listed EVERY task of
 *     the user instead of one agent's routines;
 *   - a `daysOfWeek` token that is not a weekday (`['mo', 'di']`) was
 *     dropped, and a list with nothing left became null: "every Monday and
 *     Tuesday" with no `repeatInterval` was stored as a ONE-OFF that ran
 *     once and switched itself off;
 *   - `startNow` read "no repeatInterval" as "one-off" and switched a
 *     daysOfWeek-only routine off before firing it — "every Monday, and run
 *     it now" ran now and never again. The runner (isRepeating) and
 *     cowork.js already count a day list as repeating; this route now too;
 *   - `timeOfDay: '25:99'` passed a two-digits-colon-two-digits check;
 *   - a `nextRunAt` that is not a date reached the database as a 500;
 *   - a PUT could blank the title or the prompt, which a POST refuses;
 *   - `startNow: 'true'` was a 200 that started nothing.
 *
 * NOT closed here: `modelTier` stays free text. Which tiers exist is
 * configuration (custom org tiers included), and the runner answers a tier
 * it cannot find with the fast tier.
 */

const express = require('express');
const { z } = require('zod');
const log = require('../telemetry/log');
const router = express.Router();
const aiTaskStore = require('../stores/aiTaskStore');
const agentStore = require('../stores/agentStore');
const configStore = require('../stores/configStore');
const { executeTask } = require('../core/aiTaskRunner');
const { userHasBetaFeature } = require('../core/entitlements/betaFeatures');
const { validate } = require('../core/http/validate');

// Default max tasks per user (admin-configurable via configStore)
const DEFAULT_MAX_TASKS = 10;

const REPEAT_INTERVALS = ['hourly', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
const DOW_TOKENS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_NAMES = { sunday: 'sun', monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat' };

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });
/** '' has always meant "clear this field" here; the schemas keep that. */
const blankIsNull = (schema) => z.preprocess((v) => (v === '' ? null : v), schema.nullable());

const TITLE_TEXT = 'Title is required';
const PROMPT_TEXT = 'Prompt is required';
const NEXT_RUN_TEXT = 'nextRunAt is the first run as an ISO date-time, like 2026-10-01T09:00:00Z.';
const REPEAT_TEXT = `repeatInterval is one of ${REPEAT_INTERVALS.join(', ')} — or empty for a one-off.`;
const DOW_TEXT = 'daysOfWeek is a list of weekdays: sun, mon, tue, wed, thu, fri, sat.';
const TIME_TEXT = 'timeOfDay is a time of day as HH:MM, like 09:00.';
const TZ_TEXT = 'timezone is an IANA zone name, like Europe/Amsterdam.';
const TIER_TEXT = 'modelTier is the name of a model tier.';
const AGENT_TEXT = 'agentId is the id of one of your agents.';
const FILTER_TEXT = 'agentId names one agent — send it once, and not empty.';

// An invalid zone would make the runner's Intl.DateTimeFormat construction
// throw, silently breaking the cron with no UI signal.
function isKnownTimeZone(tz) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
        return true;
    } catch (_) {
        return false;
    }
}

const Title = worded(TITLE_TEXT).trim().min(1, TITLE_TEXT).max(500, 'A title is at most 500 characters.');
const Prompt = worded(PROMPT_TEXT).trim().min(1, PROMPT_TEXT).max(50_000, 'A prompt is at most 50,000 characters.');
// Normalised to ISO on the way in, so what reaches the TIMESTAMPTZ column is
// a value it parses rather than whatever Date.parse happened to accept.
const NextRunAt = worded(NEXT_RUN_TEXT)
    .refine((v) => !Number.isNaN(Date.parse(v)), NEXT_RUN_TEXT)
    .transform((v) => new Date(v).toISOString());
const RepeatInterval = blankIsNull(z.enum(REPEAT_INTERVALS, { errorMap: () => ({ message: REPEAT_TEXT }) }));
// 'mon' or 'Monday': a full English name still maps onto its token, as the
// old reader's slice(0, 3) did. Anything else is refused, not dropped.
const Weekday = z.string({ invalid_type_error: DOW_TEXT })
    .transform((d) => d.trim().toLowerCase())
    .transform((d) => DOW_NAMES[d] || d)
    .refine((d) => DOW_TOKENS.includes(d), DOW_TEXT);
// An empty list still means "no day restriction", stored as null.
const DaysOfWeek = z.array(Weekday, { invalid_type_error: DOW_TEXT }).max(7, DOW_TEXT).nullable()
    .transform((days) => (days && days.length ? [...new Set(days)] : null));
const TimeOfDay = blankIsNull(z.string({ invalid_type_error: TIME_TEXT }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, TIME_TEXT));
const TimeZone = blankIsNull(z.string({ invalid_type_error: TZ_TEXT }).trim().max(64, TZ_TEXT).refine(isKnownTimeZone, TZ_TEXT));
const ModelTier = z.string({ invalid_type_error: TIER_TEXT }).trim().max(100, TIER_TEXT);
const AgentId = z.string({ invalid_type_error: AGENT_TEXT }).trim().max(200, AGENT_TEXT).nullable();

const ListQuery = z.object({
    agentId: worded(FILTER_TEXT).trim().min(1, FILTER_TEXT).optional(),
}).strict();

const CreateBody = z.object({
    title: Title,
    prompt: Prompt,
    nextRunAt: z.preprocess((v) => (v === '' || v === null ? undefined : v), NextRunAt),
    repeatInterval: RepeatInterval.optional(),
    modelTier: ModelTier.optional(),
    timezone: TimeZone.optional(),
    agentId: AgentId.optional(),
    daysOfWeek: DaysOfWeek.optional(),
    timeOfDay: TimeOfDay.optional(),
    startNow: z.boolean({ invalid_type_error: 'startNow is true or false.' }).optional(),
}).strict();

const UpdateBody = z.object({
    title: Title,
    prompt: Prompt,
    nextRunAt: NextRunAt,
    repeatInterval: RepeatInterval,
    modelTier: ModelTier,
    timezone: TimeZone,
    isActive: z.boolean({ invalid_type_error: 'isActive is true or false.' }),
    daysOfWeek: DaysOfWeek,
    timeOfDay: TimeOfDay,
    agentId: AgentId,
}).partial().strict();

/** Repeats by interval OR by a day list — the runner's isRepeating, verbatim. */
function isRepeating({ repeatInterval, daysOfWeek }) {
    return !!(repeatInterval || (Array.isArray(daysOfWeek) && daysOfWeek.length > 0));
}

async function getMaxTasks() {
    const limit = await configStore.getConfig('ai_tasks_max_per_user');
    return (typeof limit === 'number' && limit > 0) ? limit : DEFAULT_MAX_TASKS;
}

// Auth middleware
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

router.use(requireAuth);

// GET / — list tasks. Optional `?agentId=<id>` filter for routines.
// Tasks with `agentId` are enriched with `agentName` + `agentAvatar` so the
// list view can show which agent each routine belongs to without a separate
// fetch round-trip.
router.get('/', validate({ query: ListQuery }), async (req, res) => {
    const userId = req.session.user.id;
    const agentId = req.query.agentId || null;
    const tasks = agentId
        ? await aiTaskStore.getTasksByAgent(userId, agentId)
        : await aiTaskStore.getTasks(userId);

    // Enrich agent-scoped tasks with name+avatar. Single-pass lookup keyed
    // by agentId, so we hit agentStore once per distinct agent.
    const agentIds = Array.from(new Set(tasks.map(t => t.agentId).filter(Boolean)));
    if (agentIds.length > 0) {
        const agentMap = new Map();
        await Promise.all(agentIds.map(async (id) => {
            try {
                const a = await agentStore.getAgent(id);
                if (a) agentMap.set(id, { name: a.name, avatar: a.avatar || a.config?.avatar || '🤖' });
            } catch (_) { /* missing agent → leave unenriched */ }
        }));
        for (const t of tasks) {
            if (t.agentId && agentMap.has(t.agentId)) {
                const a = agentMap.get(t.agentId);
                t.agentName = a.name;
                t.agentAvatar = a.avatar;
            }
        }
    }

    const maxTasks = await getMaxTasks();
    res.json({ tasks, maxTasks });
});

// POST / — create task. Pass `agentId` (beta-gated) to make it an agent routine.
// Pass `startNow: true` (Work composer → "Run now") to also kick the first run
// off immediately instead of waiting for the 60s scheduler tick. A one-off
// (no `repeatInterval` and no `daysOfWeek`) is deactivated first so the
// scheduler can't pick the same row up a second time; a repeating one keeps
// its schedule and its `nextRunAt` is expected to already point at the *next*
// occurrence.
router.post('/', validate({ body: CreateBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { title, prompt, repeatInterval, nextRunAt, modelTier, timezone, agentId, daysOfWeek, timeOfDay, startNow } = req.body;

    // Beta gate + agent ownership check for agent-scoped routines.
    // (agentStore returns the raw row; the column is `owner_id`. The prior
    // `agent.userId` check was always undefined → rejected every call.)
    let resolvedAgentId = null;
    if (agentId) {
        const allowed = await userHasBetaFeature(userId, 'agent_routines', req.session).catch(() => false);
        if (!allowed) return res.status(403).json({ error: 'Agent routines beta is not enabled for this account' });
        const agent = await agentStore.getAgent(agentId);
        if (!agent || agent.owner_id !== userId) {
            return res.status(403).json({ error: 'Agent not found or not owned by you' });
        }
        resolvedAgentId = agent.id;
    }

    // Check task limit
    const maxTasks = await getMaxTasks();
    const currentCount = await aiTaskStore.getTaskCount(userId);
    if (currentCount >= maxTasks) {
        return res.status(400).json({
            error: `Maximum number of routines reached (${maxTasks}). Delete or deactivate existing routines to create new ones.`
        });
    }

    const task = await aiTaskStore.createTask({
        userId,
        title,
        prompt,
        repeatInterval: repeatInterval ?? null,
        nextRunAt,
        modelTier: modelTier || 'fast',
        timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        agentId: resolvedAgentId,
        daysOfWeek: daysOfWeek ?? null,
        timeOfDay: timeOfDay ?? null,
    });

    if (startNow === true) {
        // One-off: take it off the scheduler before firing, otherwise the
        // next processDueTasks() tick would run the very same row again
        // (next_run_at is "now" and is_active is TRUE on a fresh insert).
        if (!isRepeating({ repeatInterval, daysOfWeek })) {
            await aiTaskStore.updateTask(task.id, { isActive: false });
            task.isActive = false;
        }
        // manual:true leaves next_run_at untouched — exactly what a
        // repeating task wants (its schedule already points forward).
        setImmediate(async () => {
            try {
                await executeTask(task, { manual: true });
            } catch (err) {
                log.error(`[AITasks] startNow failed for ${task.id}:`, err.message);
            }
        });
    }

    res.json(task);
});

// PUT /:id — update task
router.put('/:id', validate({ body: UpdateBody }), async (req, res) => {
    const userId = req.session.user.id;
    const existing = await aiTaskStore.getTask(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const { title, prompt, repeatInterval, nextRunAt, modelTier, timezone, isActive, daysOfWeek, timeOfDay, agentId } = req.body;

    // Allow attaching/detaching/changing the linked agent. Same beta + ownership
    // gate as POST. `agentId === undefined` means "don't touch"; `null` or ''
    // means "detach"; a string means "switch to this agent".
    let resolvedAgentId;
    if (agentId !== undefined) {
        if (!agentId) {
            resolvedAgentId = null;
        } else {
            const allowed = await userHasBetaFeature(userId, 'agent_routines', req.session).catch(() => false);
            if (!allowed) return res.status(403).json({ error: 'Agent routines beta is not enabled for this account' });
            const agent = await agentStore.getAgent(agentId);
            if (!agent || agent.owner_id !== userId) {
                return res.status(403).json({ error: 'Agent not found or not owned by you' });
            }
            resolvedAgentId = agent.id;
        }
    }

    const ok = await aiTaskStore.updateTask(req.params.id, {
        title, prompt,
        repeatInterval,
        nextRunAt, modelTier, timezone, isActive,
        daysOfWeek,
        timeOfDay,
        ...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
    });
    res.json({ success: ok });
});

// DELETE /:id — delete task
router.delete('/:id', async (req, res) => {
    const userId = req.session.user.id;
    const existing = await aiTaskStore.getTask(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const ok = await aiTaskStore.deleteTask(req.params.id);
    res.json({ success: ok });
});

// POST /:id/toggle — toggle active/inactive
router.post('/:id/toggle', async (req, res) => {
    const userId = req.session.user.id;
    const existing = await aiTaskStore.getTask(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const ok = await aiTaskStore.updateTask(req.params.id, { isActive: !existing.isActive });
    res.json({ success: ok, isActive: !existing.isActive });
});

// POST /:id/run-now — force immediate execution
router.post('/:id/run-now', async (req, res) => {
    const userId = req.session.user.id;
    const existing = await aiTaskStore.getTask(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    if (existing.lastStatus === 'running') return res.status(400).json({ error: 'Task is already running' });

    // Execute asynchronously — don't block the response
    setImmediate(async () => {
        try {
            await executeTask(existing, { manual: true });
        } catch (err) {
            log.error(`[AITasks] Run-now failed for ${req.params.id}:`, err.message);
        }
    });

    res.json({ success: true, message: 'Task execution started. Results will appear in notifications.' });
});

module.exports = router;
