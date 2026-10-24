/**
 * Cowork Routes — REST API for scheduled cowork and its execution history.
 *
 * GET    /              → list the user's cowork schedules
 * POST   /              → create one (pass `startNow` to also run it immediately)
 * PUT    /:id           → update
 * DELETE /:id           → delete (its history cascades)
 * POST   /:id/toggle    → pause / resume
 * POST   /:id/run-now   → force an immediate run
 * GET    /:id/runs      → execution history, newest first
 * GET    /:id/stats     → the aggregate behind the figure cards
 *
 * Validation keeps the schedule vocabulary of the old /api/ai-tasks (same
 * limits), so a payload built for that route is valid here too.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * One `.strict()` zod schema per body and one for the run-history query, so a
 * key this API does not know is refused by name. The callers are the Work
 * composer and edit form in agent-hub and ComposeCowork in the Expo app; what
 * they send stays valid. What the schemas closed:
 *
 *   - daysOfWeek kept whatever read as a weekday after `slice(0, 3)` and
 *     dropped the rest in silence. `["ma", "di"]` (Dutch) became no days at
 *     all, so "daily, on Monday and Tuesday" ran EVERY day, and without a
 *     repeatInterval it became a one-off. An entry that is not a weekday is
 *     refused now; the token or the English name (`mon`, `Monday`, `tues`)
 *     is accepted as before. An empty list still means "no day restriction".
 *   - `startNow` fired only for a literal `true`, so `"true"` was a 200 that
 *     started nothing, and a repeating item's first run came an interval late.
 *     It is a JSON boolean now, like `isActive` on an update.
 *   - enabledApps dropped entries that were not text: `[7]` stored "may use
 *     no apps". A non-string entry is refused; blanks and duplicates are
 *     still cleaned.
 *   - nextRunAt went to a TIMESTAMPTZ column as given: `'tomorrow'` was a 500,
 *     and a time without an offset was read in the database's zone. It is an
 *     ISO timestamp with an offset (what toISOString() sends) now.
 *   - timeOfDay took any two digits: `25:99` ended up in the schedule's
 *     description to the model. It is a real 24-hour time now.
 *   - The run history clamped `?limit=` to 1..100 and read junk as 25; an
 *     out-of-range or misspelled parameter is refused.
 *   - An update could blank a title or prompt; both need text now.
 *
 * modelTier stays open text: the tier names are configuration (the
 * chat_model_tiers map and each org's custom tiers), not a list this file
 * can know. POST /compose keeps its deliberate fallback for an unknown
 * timezone (a bad clock hint must not block composing), but a timezone that
 * is not text is refused.
 */

const express = require('express');
const { z, typeError, datetimeWithOffset } = require('../utils/zod');
const { worded } = require('../core/http/schemaParts');
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const router = express.Router();
const { validate } = require('../core/http/validate');
const coworkStore = require('../stores/coworkStore');
const agentStore = require('../stores/agentStore');
const configStore = require('../stores/configStore');
const { executeCowork } = require('../core/cowork/coworkRunner');
const { userHasBetaFeature } = require('../core/entitlements/betaFeatures');
const { requireAuth } = require('../auth/permissions'); const { bestEffort, fallback } = require('../utils/bestEffort');

const DEFAULT_MAX_SCHEDULES = 10;

const VALID_REPEAT_INTERVALS = new Set([
    'hourly', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly',
]);
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ── Request schemas (see the header) ────────────────────────────────

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

/** '' from a cleared form field means the same as null. */
const blankIsNull = (schema) => z.preprocess((v) => (v === '' ? null : v), schema);

// An unknown zone would make the runner's Intl.DateTimeFormat throw on every
// tick — a schedule that silently never runs. Reject it at the door.
function isKnownTimezone(value) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
        return true;
    } catch (_) {
        return false;
    }
}

const REPEAT_TEXT = `repeatInterval is one of ${[...VALID_REPEAT_INTERVALS].join(', ')}, or null.`;
const repeatIntervalField = blankIsNull(
    z.enum([...VALID_REPEAT_INTERVALS], { error: () => REPEAT_TEXT }).nullable(),
);

// A weekday is its three-letter token or (a start of) its English name:
// `mon`, `Monday`, `tues`. `slice(0, 3)` alone also let `month` and
// `sunshine` through, and dropped `ma`/`di` without a word.
const DAYS_TEXT = 'daysOfWeek is a list of weekdays (sun, mon, tue, wed, thu, fri, sat), or null.';
const weekday = worded(DAYS_TEXT).transform((v, ctx) => {
    const word = v.trim().toLowerCase();
    const name = word.length >= 3 ? DAY_NAMES.find((d) => d.startsWith(word)) : null;
    if (!name) {
        ctx.addIssue({ code: 'custom', message: `"${v}" is not a weekday. ${DAYS_TEXT}` });
        return z.NEVER;
    }
    return name.slice(0, 3);
});
// An EMPTY list means "no day restriction", which is stored as null.
const daysOfWeekField = z.array(weekday, { error: typeError({ invalid: DAYS_TEXT }) }).nullable()
    .transform((list) => (list && list.length > 0 ? Array.from(new Set(list)) : null));

const TIME_TEXT = 'timeOfDay is a 24-hour time like 09:00, or null.';
const timeOfDayField = blankIsNull(worded(TIME_TEXT).regex(/^([01]\d|2[0-3]):[0-5]\d$/, TIME_TEXT).nullable());

const TZ_TEXT = 'timezone is an IANA zone name like Europe/Amsterdam.';
const timezoneField = blankIsNull(
    worded(TZ_TEXT).refine(isKnownTimezone, { error: (iss) => `Unknown timezone: ${iss.input}` }).nullable(),
);

// Which apps THIS item may use. `null` means "no per-item restriction", i.e.
// fall back to the user's workspace-wide list — the behaviour every schedule
// had before the column existed. An EMPTY array is a real answer ("this one
// may use nothing") and must not collapse to null.
const APPS_TEXT = 'enabledApps is a list of app ids, or null.';
const enabledAppsField = z.array(worded(APPS_TEXT), { error: typeError({ invalid: APPS_TEXT }) }).nullable()
    .transform((list) => (list === null ? null : Array.from(new Set(list.map((v) => v.trim()).filter(Boolean)))));

const TITLE_TEXT = 'Title is required.';
const PROMPT_TEXT = 'Prompt is required.';
const NEXT_RUN_TEXT = 'nextRunAt is required: an ISO timestamp with a time zone, like 2026-09-23T07:00:00.000Z.';
const scheduleFields = {
    title: worded(TITLE_TEXT).trim().min(1, TITLE_TEXT).max(500, 'A title is at most 500 characters.'),
    prompt: worded(PROMPT_TEXT).trim().min(1, PROMPT_TEXT),
    nextRunAt: worded(NEXT_RUN_TEXT).regex(datetimeWithOffset, NEXT_RUN_TEXT),
    repeatInterval: repeatIntervalField.optional(),
    // Open text on purpose: see the header.
    modelTier: worded('modelTier names a model tier.').trim().max(100, 'modelTier is at most 100 characters.').nullish(),
    timezone: timezoneField.optional(),
    daysOfWeek: daysOfWeekField.optional(),
    timeOfDay: timeOfDayField.optional(),
    agentId: worded('agentId names one of your agents.').trim().max(200, 'agentId is at most 200 characters.').nullish(),
    enabledApps: enabledAppsField.optional(),
};

const CreateBody = z.object({
    ...scheduleFields,
    startNow: z.boolean({ error: typeError({ invalid: 'startNow is true or false.' }) }).optional(),
}).strict();

// Every field optional: an update names only what it changes.
const UpdateBody = z.object({
    ...scheduleFields,
    title: scheduleFields.title.optional(),
    prompt: scheduleFields.prompt.optional(),
    nextRunAt: scheduleFields.nextRunAt.optional(),
    isActive: z.boolean({ error: typeError({ invalid: 'isActive is true or false.' }) }).optional(),
}).strict();

// toggle / run-now act on the schedule as it is.
const NoBody = bodyOf({});

const BRIEF_TEXT = 'A brief is required';
const ComposeBody = z.object({
    brief: worded(BRIEF_TEXT).trim().min(1, BRIEF_TEXT),
    // Validated below, with a fallback rather than a 400 (see the header).
    timezone: worded(TZ_TEXT).nullish(),
}).strict();

const LIMIT_TEXT = 'limit is a whole number from 1 to 100.';
const OFFSET_TEXT = 'offset is a whole number, 0 or more.';
const RunsQuery = z.object({
    limit: z.coerce.number({ error: typeError({ invalid: LIMIT_TEXT }) }).int(LIMIT_TEXT).min(1, LIMIT_TEXT).max(100, LIMIT_TEXT).optional(),
    offset: z.coerce.number({ error: typeError({ invalid: OFFSET_TEXT }) }).int(OFFSET_TEXT).min(0, OFFSET_TEXT).optional(),
}).strict();

async function getMaxSchedules() {
    // Shares the ai_tasks ceiling: it is the same "how much unattended work may
    // one user queue" budget, and having two knobs for one concern invites drift.
    const limit = await configStore.getConfig('ai_tasks_max_per_user');
    return (typeof limit === 'number' && limit > 0) ? limit : DEFAULT_MAX_SCHEDULES;
}

/** Resolve + authorise an agent link. Returns undefined for "don't touch". */
async function resolveAgentId(agentId, userId, session) {
    if (agentId === undefined) return undefined;
    if (agentId === null || agentId === '') return null;
    const allowed = await userHasBetaFeature(userId, 'agent_routines', session).catch(() => false);
    if (!allowed) {
        const err = new Error('Running Cowork items as an agent is not enabled for this account');
        err.statusCode = 403;
        throw err;
    }
    const agent = await agentStore.getAgent(agentId);
    if (!agent || agent.owner_id !== userId) {
        const err = new Error('Agent not found or not owned by you');
        err.statusCode = 403;
        throw err;
    }
    return agent.id;
}

/** Load a schedule and assert the caller owns it. */
async function loadOwned(id, userId) {
    const existing = await coworkStore.getSchedule(id);
    if (!existing) {
        const err = new Error('Not found');
        err.statusCode = 404;
        throw err;
    }
    if (existing.userId !== userId) {
        const err = new Error('Forbidden');
        err.statusCode = 403;
        throw err;
    }
    return existing;
}

function fail(res, err, _label) {
    if (err.statusCode >= 400 && err.statusCode < 500) throw new HttpError(err.statusCode, 'cowork_refused', err.message); // the guards' caller-written message
    throw err; // anything else: the terminal handler logs it and answers a generic 500
}

/**
 * CW-06 — "Running since 08:00:04".
 *
 * Purely additive: `currentRunStartedAt` comes from the open history row
 * (cowork_runs WHERE finished_at IS NULL), not from a new column, and NOTHING is renamed — the Expo app reads this payload, and a rename there would be a broken APK without a red test.
 *
 * Null is the normal value: a schedule that is not running has nothing open.
 * The open row is deliberately the source and not `lastStatus === 'running'`: those two diverge as soon as reapStaleRuns clears a stuck attempt.
 */
function withCurrentRun(schedule, startedAt) {
    schedule.currentRunStartedAt = startedAt || null;
    return schedule;
}

router.use(requireAuth);

// GET / — every schedule, newest first, enriched with the linked agent's
// name/avatar so the overview can render a row without an extra round-trip.
router.get('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const schedules = await coworkStore.getSchedules(userId);

        const agentIds = Array.from(new Set(schedules.map(s => s.agentId).filter(Boolean)));
        if (agentIds.length > 0) {
            const agentMap = new Map();
            await Promise.all(agentIds.map(async (id) => {
                try {
                    const a = await agentStore.getAgent(id);
                    if (a) agentMap.set(id, { name: a.name, avatar: a.avatar || a.config?.avatar || '🤖' });
                } catch (err) { bestEffort('routes/cowork:anon', err); /* missing agent → leave unenriched */ }
            }));
            for (const s of schedules) {
                const a = s.agentId && agentMap.get(s.agentId);
                if (a) { s.agentName = a.name; s.agentAvatar = a.avatar; }
            }
        }

        // One query for all open runs of this user, not one query per row.
        const openRuns = await coworkStore.getOpenRunStarts(userId).catch((e) => fallback('routes/cowork:anon#2', e, {}));
        for (const s of schedules) withCurrentRun(s, openRuns[s.id]);

        res.json({ schedules, maxSchedules: await getMaxSchedules() });
    } catch (err) {
        fail(res, err, 'List');
    }
});

// POST / — create. `startNow` fires the first run immediately instead of
// waiting for the next 60s tick.
router.post('/', validate({ body: CreateBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { title, prompt, nextRunAt, modelTier, agentId, startNow } = req.body;
        const norm = req.body;
        const resolvedAgentId = await resolveAgentId(agentId, userId, req.session);

        const max = await getMaxSchedules();
        if (await coworkStore.getScheduleCount(userId) >= max) {
            return res.status(400).json({
                error: `Maximum number of cowork schedules reached (${max}). Delete or pause one to create another.`,
            });
        }

        const schedule = await coworkStore.createSchedule({
            userId,
            title,
            prompt,
            repeatInterval: norm.repeatInterval ?? null,
            nextRunAt,
            modelTier: modelTier || 'fast',
            timezone: norm.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            agentId: resolvedAgentId ?? null,
            daysOfWeek: norm.daysOfWeek ?? null,
            timeOfDay: norm.timeOfDay ?? null,
            enabledApps: norm.enabledApps ?? null,
        });

        if (startNow === true) {
            // A one-off has next_run_at = now and is_active = true on insert, so
            // the very next tick would run it a second time. Take it off the
            // scheduler before firing. A repeating one keeps its schedule —
            // manual:true leaves next_run_at pointing at the next occurrence.
            // "Repeating" includes daysOfWeek-only specs ("every Monday 09:00"),
            // which carry no repeatInterval.
            if (!norm.repeatInterval && !(Array.isArray(norm.daysOfWeek) && norm.daysOfWeek.length > 0)) {
                await coworkStore.updateSchedule(schedule.id, { isActive: false });
                schedule.isActive = false;
            }
            setImmediate(async () => {
                try {
                    await executeCowork(schedule, { manual: true });
                } catch (err) {
                    log.error(`[Cowork] startNow failed for ${schedule.id}:`, err.message);
                }
            });
        }

        res.json(schedule);
    } catch (err) {
        fail(res, err, 'Create');
    }
});

// PUT /:id — update
router.put('/:id', validate({ body: UpdateBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        await loadOwned(req.params.id, userId);

        const { title, prompt, nextRunAt, modelTier, isActive, agentId } = req.body;
        const norm = req.body;
        const resolvedAgentId = await resolveAgentId(agentId, userId, req.session);

        const ok = await coworkStore.updateSchedule(req.params.id, {
            title, prompt, nextRunAt, modelTier, isActive,
            repeatInterval: norm.repeatInterval,
            timezone: norm.timezone,
            daysOfWeek: norm.daysOfWeek,
            timeOfDay: norm.timeOfDay,
            enabledApps: norm.enabledApps,
            ...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
        });
        res.json({ success: ok });
    } catch (err) {
        fail(res, err, 'Update');
    }
});

// GET /:id — one schedule. Exists so the notification a finished run produces
// can work out where to continue: the agent + conversation it ran in, or
// nothing, which means plain direct chat.
router.get('/:id', async (req, res) => {
    try {
        const schedule = await loadOwned(req.params.id, req.session.user.id);
        const startedAt = await coworkStore.getOpenRunStart(req.params.id).catch((e) => fallback('routes/cowork:anon#3', e, null));
        res.json(withCurrentRun(schedule, startedAt));
    } catch (err) {
        fail(res, err, 'Get');
    }
});

// DELETE /:id — delete the schedule and, by cascade, its history
router.delete('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        await loadOwned(req.params.id, userId);
        res.json({ success: await coworkStore.deleteSchedule(req.params.id) });
    } catch (err) {
        fail(res, err, 'Delete');
    }
});

// POST /:id/toggle — pause / resume
router.post('/:id/toggle', validate({ body: NoBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await loadOwned(req.params.id, userId);
        const next = !existing.isActive;
        const ok = await coworkStore.updateSchedule(req.params.id, { isActive: next });
        res.json({ success: ok, isActive: next });
    } catch (err) {
        fail(res, err, 'Toggle');
    }
});

// POST /:id/run-now — force an immediate run
router.post('/:id/run-now', validate({ body: NoBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await loadOwned(req.params.id, userId);
        if (existing.lastStatus === 'running') {
            return res.status(400).json({ error: 'This cowork is already running' });
        }

        // Don't block the response on a run that can take minutes.
        setImmediate(async () => {
            try {
                await executeCowork(existing, { manual: true });
            } catch (err) {
                log.error(`[Cowork] Run-now failed for ${req.params.id}:`, err.message);
            }
        });

        res.json({ success: true, message: 'Cowork started. The result arrives in your notifications.' });
    } catch (err) {
        fail(res, err, 'Run-now');
    }
});

// POST /compose — turn a spoken-language brief into a cowork spec.
// Read-only: it creates nothing, so the client can show what it worked out
// before the user commits. The agent list comes from the server, never the
// client, and is only offered when the beta that allows agent-linked cowork is
// on — otherwise the model could pick an agent the create call would 403 on.
router.post('/compose', validate({ body: ComposeBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { brief } = req.body;
        const timezone = req.body.timezone && isKnownTimezone(req.body.timezone)
            ? req.body.timezone
            : 'Europe/Amsterdam';

        let agents = [];
        const canUseAgents = await userHasBetaFeature(userId, 'agent_routines', req.session).catch(() => false);
        if (canUseAgents) {
            try {
                // getAgents() also returns 'system' agents, which resolveAgentId
                // above refuses — offering one would produce a spec whose create
                // call 403s. Only list what can actually be assigned.
                const owned = await agentStore.getAgents(userId);
                agents = (owned || [])
                    .filter(a => a.owner_id === userId)
                    .map(a => ({
                        id: a.id,
                        name: a.name,
                        description: a.description || a.config?.description || null,
                    }));
            } catch (err) { fallback('routes/cowork:anon#4', err); /* compose still works without agents */ }
        }

        const { composeCowork } = require('../core/cowork/coworkCompose');
        const { resolveEffectiveOrgId } = require('../core/llm/modelResolver');
        const userOrgId = await resolveEffectiveOrgId(req, { userId }).catch((e) => fallback('routes/cowork:anon#5', e, null));
        const spec = await composeCowork({ brief, agents, timezone, userId, userOrgId });
        res.json(spec);
    } catch (err) {
        fail(res, err, 'Compose');
    }
});

// GET /:id/runs — execution history, newest first
router.get('/:id/runs', validate({ query: RunsQuery }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        await loadOwned(req.params.id, userId);
        const { limit, offset } = req.query;
        const [runs, total] = await Promise.all([
            coworkStore.listRuns(req.params.id, { limit, offset }),
            coworkStore.getRunCount(req.params.id),
        ]);
        res.json({ runs, total });
    } catch (err) {
        fail(res, err, 'Runs');
    }
});

// GET /:id/stats — the figures behind the four cards (CW-11).
//
// Ownership-checked in exactly the same way as /:id/runs, and for the same
// reason: this is a statement about what happened to someone else's mail and calendar. No result text, counts only.
//
// Three of the four cards can be drawn with this. "Cost this month"
// NOT: the run path does not record tokens or costs (CW-12), and inventing a euro figure is worse than omitting a card — so there is
// deliberately no empty cost field in this answer that could accidentally be rendered as € 0.00.
router.get('/:id/stats', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const schedule = await loadOwned(req.params.id, userId);
        const stats = await coworkStore.getRunStats(req.params.id);
        res.json({
            ...stats,
            // Lifetime, from the schema itself: survives the retention sweep that
            // shrinks `total` after 90 days. "Run 42 times" should be THIS number,
            // not the number of stored rows.
            runCount: schedule.runCount ?? 0,
            // "sinds 8 juli".
            createdAt: schedule.createdAt ?? null,
        });
    } catch (err) {
        fail(res, err, 'Stats');
    }
});

module.exports = router;
