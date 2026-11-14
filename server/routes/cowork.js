// @typecheck
/** @typedef {import('zod').ZodString} ZodString */
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
 * An item is started by its clock (`triggerKind: 'schedule'`, the default) or by
 * an event (`triggerKind: 'app_event'` + `trigger: { provider, event, filter? }`,
 * today a new Gmail / Outlook mail). An event item needs an agent (and the
 * agent_routines gate that comes with one), has no nextRunAt, and owns a row in
 * automation_event_subscriptions that create / update / toggle / delete keep in
 * step (automation/subscriptionSync.js).
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
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const router = express.Router();
const { validate } = require('../core/http/validate');
const coworkStore = require('../stores/coworkStore');
const agentStore = require('../stores/agentStore');
const configStore = require('../stores/configStore');
const { executeCowork } = require('../core/cowork/coworkRunner');
const { userHasBetaFeature } = require('../core/entitlements/betaFeatures');
const { requireAuth } = require('../auth/permissions');
const { bestEffort, fallback } = require('../utils/bestEffort');
const { CreateBody, UpdateBody, NoBody, ComposeBody, RunsQuery, isKnownTimezone } = require('./coworkSchemas');
const { mailTriggers, assertTriggerUsable, newItemFields, syncNewEventItem, planTriggerUpdate } = require('./coworkTrigger');

const DEFAULT_MAX_SCHEDULES = 10;

async function getMaxSchedules() {
    // Shares the ai_tasks ceiling: it is the same "how much unattended work may
    // one user queue" budget, and having two knobs for one concern invites drift.
    const limit = await configStore.getConfig('ai_tasks_max_per_user');
    return (typeof limit === 'number' && limit > 0) ? limit : DEFAULT_MAX_SCHEDULES;
}

/**
 * Resolve + authorise an agent link. Returns undefined for "don't touch".
 * @param {string} userId
 * @param {Express.Session} session
 */
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

/**
 * `startNow`: fire the first run immediately instead of waiting for the tick.
 * A one-off has next_run_at = now and is_active = true on insert, so the very
 * next tick would run it a second time: take it off the scheduler before
 * firing. A repeating one keeps its schedule: manual:true leaves next_run_at
 * pointing at the next occurrence. "Repeating" includes daysOfWeek-only specs
 * ("every Monday 09:00"), which carry no repeatInterval.
 * @param {NonNullable<Awaited<ReturnType<typeof coworkStore.getSchedule>>>} schedule
 * @param {{ repeatInterval?: string | null, daysOfWeek?: string[] | null }} norm
 */
async function startNowRun(schedule, norm) {
    if (!norm.repeatInterval && !(Array.isArray(norm.daysOfWeek) && norm.daysOfWeek.length > 0)) {
        await coworkStore.updateSchedule(schedule.id, { isActive: false });
        schedule.isActive = false;
    }
    setImmediate(async () => {
        try {
            await executeCowork(schedule, { manual: true });
        } catch (err) {
            log.error(`[Cowork] startNow failed for ${schedule.id}:`, /** @type {Error} */ (err).message);
        }
    });
}

/**
 * Load a schedule and assert the caller owns it.
 * @param {string} id
 * @param {string} userId
 */
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

/**
 * @param {string} _label
 */
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
 * @param {string | null} startedAt
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
        const { agentId, startNow } = req.body;
        const norm = req.body;
        const resolvedAgentId = await resolveAgentId(agentId, userId, req.session);
        const isEvent = norm.triggerKind === 'app_event';
        const trigger = isEvent ? (norm.trigger ?? null) : null;
        if (isEvent && trigger) await assertTriggerUsable(userId, { ...trigger, filter: trigger.filter ?? null });

        const max = await getMaxSchedules();
        if (await coworkStore.getScheduleCount(userId) >= max) {
            return res.status(400).json({
                error: `Maximum number of cowork schedules reached (${max}). Delete or pause one to create another.`,
            });
        }

        const schedule = await coworkStore.createSchedule(newItemFields(userId, norm, resolvedAgentId, trigger));

        if (isEvent) await syncNewEventItem(schedule);
        if (startNow === true) await startNowRun(schedule, norm);

        res.json(schedule);
    } catch (err) {
        fail(res, err, 'Create');
    }
});

// PUT /:id — update
router.put('/:id', validate({ body: UpdateBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await loadOwned(req.params.id, userId);

        const { title, prompt, modelTier, isActive, agentId } = req.body;
        const norm = req.body;
        const resolvedAgentId = await resolveAgentId(agentId, userId, req.session);
        const plan = await planTriggerUpdate({ existing, body: norm, resolvedAgentId, userId, session: req.session, resolveAgentId });

        const ok = await coworkStore.updateSchedule(req.params.id, {
            title, prompt, modelTier, isActive,
            timezone: norm.timezone,
            enabledApps: norm.enabledApps,
            ...(resolvedAgentId !== undefined ? { agentId: resolvedAgentId } : {}),
            ...plan.patch,
        });
        if (plan.syncs) await mailTriggers().syncCoworkMailTrigger(await coworkStore.getSchedule(req.params.id));
        res.json({ success: ok, triggerKind: plan.kind, trigger: plan.trigger });
    } catch (err) {
        fail(res, err, 'Update');
    }
});

// GET /mail-providers — the mail apps (gmail, msgraph) this user has connected, so
// the "when a new email arrives" settings only offer what a save would accept.
// Before /:id, or it would be read as an item id.
router.get('/mail-providers', async (req, res) => {
    res.json({ providers: await mailTriggers().connectedMailProviders(req.session.user.id) });
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
        const existing = await loadOwned(req.params.id, userId);
        // The subscription row holds the remote Graph id: revoke before the cascade drops it.
        if (existing.triggerKind === 'app_event') await mailTriggers().revokeCoworkMailTrigger(existing.id);
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
        const isEvent = existing.triggerKind === 'app_event';
        // Resuming needs the mailbox connected; pausing never does.
        if (isEvent && next && existing.trigger) await assertTriggerUsable(userId, { ...existing.trigger, filter: existing.trigger.filter ?? null });
        const ok = await coworkStore.updateSchedule(req.params.id, { isActive: next });
        // Pause deletes the subscription (and the Graph one), resume makes a fresh one.
        if (isEvent) await mailTriggers().syncCoworkMailTrigger({ ...existing, isActive: next });
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
        // A mail trigger runs on a mail; without one the agent has nothing to read.
        if (existing.triggerKind === 'app_event') {
            throw new HttpError(400, 'run_now_not_supported', 'A mail trigger runs when new mail arrives; it cannot be started by hand.');
        }
        if (existing.lastStatus === 'running') {
            return res.status(400).json({ error: 'This cowork is already running' });
        }

        // Don't block the response on a run that can take minutes.
        setImmediate(async () => {
            try {
                await executeCowork(existing, { manual: true });
            } catch (err) {
                log.error(`[Cowork] Run-now failed for ${req.params.id}:`, /** @type {Error} */ (err).message);
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
