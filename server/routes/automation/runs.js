// §WS5 #4 — run execution + run listing/facets/stream endpoints, extracted
// verbatim from routes/automation.js. parseRunFilters co-located.
const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const cron = require('../../automation/cron');
const holidays = require('../../automation/holidays');
require('../../automation/triggerBus');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { validate } = require('../../core/http/validate');
const { z, worded, orEmpty } = require('../../core/http/schemaParts');
const { HttpError } = require('../../core/http/errors');
const { isManagedAutomation } = require('../../core/automationRunner/stageVars');
const { automationForRun } = require('../../core/automationRunner/definitionForRun');
// Handoff 5 sharing: who may start, test and read the runs of an automation.
const { makeAutomationAccess } = require('../../automation/access');
const automationAccess = makeAutomationAccess({ store: automationStore });

// ── What a caller may send ──────────────────────────────────────────
//
// Every schema is `.strict()`, and on the LIST routes that is the point: a
// misspelled filter used to be dropped, and a list that quietly drops a
// narrowing parameter answers a wider question than the one it was asked —
// the same failure the trigger-source check in crud.js exists to prevent.

/** A body that also accepts no body at all (schemaParts' orEmpty), closed with zod's own wording. */
const bodyOf = (shape) => orEmpty(z.object(shape).strict());

const one = (name, what) => worded(`${name} is ${what}.`).trim().min(1, `${name} is ${what}.`).optional();
/** Comma-separated on the wire; parseRunFilters splits it. */
const list = (name) => worded(`${name} is a comma-separated list.`).trim().optional();
const whole = (name) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .int(`${name} must be a whole number.`).optional();

const STEP_TEXT = 'triggerStepId is the id of a trigger on this automation.';
const RUN_SHAPE = {
    // What the run ENTERS with — a form submission, an inbound message. The
    // runner reads it; this route only carries it.
    triggerPayload: z.unknown().optional(),
    triggerStepId: worded(STEP_TEXT).trim().min(1, STEP_TEXT).nullish(),
};
const RunBody = bodyOf({
    ...RUN_SHAPE,
    // Handoff 5: the builder's Test button. A test run executes the WORKING
    // copy (unpublished changes included) and is marked is_test; without it a
    // manual run executes what is live.
    test: z.boolean({ invalid_type_error: 'test is true or false.' }).optional(),
});

const PARTIAL_TEXT = 'mode is "only", "from" or "upTo".';
const PartialRunBody = bodyOf({
    ...RUN_SHAPE,
    // An enum, not a fall-back: `upto` for `upTo` used to run ONLY that step
    // instead of everything leading to it, and answer 200 either way.
    mode: z.enum(['only', 'from', 'upTo'], { errorMap: () => ({ message: PARTIAL_TEXT }) }).default('only'),
});

const SEARCH_TEXT = 'q is a search term of at most 100 characters.';
const TESTS_TEXT = 'tests is "include", "exclude" or "only".';
const RunsQuery = z.object({
    status: list('status'),
    triggerKind: list('triggerKind'),
    trigger: list('trigger'),
    mode: list('mode'),
    automationId: one('automationId', 'the id of an automation'),
    kind: one('kind', 'an automation kind'),
    since: one('since', 'an ISO timestamp'),
    until: one('until', 'an ISO timestamp'),
    cursor: one('cursor', 'the value a previous page returned as nextCursor'),
    limit: whole('limit'),
    // Handoff 5 Runs tab. `q`: run link, file name, person, words of the
    // outcome (runListing.buildRunSearch). `startedBy`: a user id, or "me".
    // `tests`: test runs in (default), out, or only.
    q: worded(SEARCH_TEXT).trim().max(100, SEARCH_TEXT).optional(),
    startedBy: one('startedBy', 'a user id or "me"'),
    tests: z.enum(['include', 'exclude', 'only'], { errorMap: () => ({ message: TESTS_TEXT }) }).optional(),
}).strict();

const FacetsQuery = z.object({
    range: whole('range'),
    automationId: one('automationId', 'the id of an automation'),
    kind: one('kind', 'an automation kind'),
    mode: list('mode'),
}).strict();

const StreamQuery = z.object({
    automationId: one('automationId', 'the id of an automation'),
}).strict();

const CRON_TEXT = 'A cron expression is required — the schedule to preview.';
const SchedulePreviewBody = z.object({
    cron: worded(CRON_TEXT).trim().min(1, CRON_TEXT),
    tz: worded('tz must be a time zone.').trim().min(1, 'tz must be a time zone.').default('Europe/Amsterdam'),
    // Clamped rather than refused: asking for more previews than the builder
    // draws is not a mistake worth a 400.
    count: z.coerce.number().catch(3)
        .transform((n) => Math.min(Math.max(Math.trunc(n) || 3, 1), 5))
        .default(3),
    // schedule.skipHolidays (handoff 5): leave Dutch public holidays out, as
    // the scheduler does (automation/holidays.js).
    skipHolidays: z.boolean({ invalid_type_error: 'skipHolidays is true or false.' }).optional(),
}).strict();


// Per-user throttle for the expensive run-trigger endpoints (each spins up a
// full automation execution / LLM + tool calls). Keyed by session user id via
// the limiter's default. Generous enough for normal manual testing, low enough
// that a stuck client or a script can't flood the runner. Tunable via env.
/**
 * Resolve an optional `triggerStepId` (the entry point a test run should use)
 * against the automation's triggers — the primary `definition.trigger` and every
 * `definition.triggers[]` entry. Returns the trigger node and the `rootStepId`
 * to hand the runner (null for the primary, so an automation without additional
 * triggers behaves exactly as before). A wrong id is a 400, never a silent
 * fall-back to the primary: the caller asked to test a specific root.
 */
/**
 * The definition a run of this automation enters: for an automation a Solution stage
 * manages that is the LIVE copy (test runs included), so a trigger that exists
 * only in the working copy is not offered. Throws managed_part_not_deployed
 * (409) when it has no live copy.
 */
async function entryDefinitionOf(a) {
    if (!await isManagedAutomation(a)) return a.definition;
    return automationForRun(a, { mode: 'live', managed: true }).definition;
}

function resolveTriggerStepId(def, triggerStepId) {
    const known = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])].filter(t => t && t.id);
    if (!triggerStepId) {
        return { trigger: def?.trigger || null, rootStepId: null };
    }
    const hit = known.find(t => t.id === triggerStepId);
    if (!hit) {
        return { error: `Unknown triggerStepId "${triggerStepId}". This automation's triggers: ${known.map(t => `${t.id} (${t.kind})`).join(', ') || '(none)'}.` };
    }
    return { trigger: hit, rootStepId: hit.id === def?.trigger?.id ? null : hit.id };
}

const RUN_TRIGGER_RPM = parseInt(process.env.AUTOMATION_RUN_TRIGGER_RPM, 10) || 30;
const runTriggerLimiter = perUserRateLimit({ windowMs: 60_000, max: RUN_TRIGGER_RPM });

router.post('/:id/run', runTriggerLimiter, validate({ body: RunBody }), async (req, res) => {
    const userId = req.session.user.id;
    const isTest = req.body.test === true;
    // The copy this run executes (handoff 5), resolved up front so the
    // trigger lookup and payload synthesis below read the same definition.
    const a = require('../../core/automationRunner/definitionForRun').automationForRun(
        await automationStore.getAutomation(req.params.id), { mode: 'live', triggerKind: 'manual', isTest });
    if (!a) return res.status(404).json({ error: 'Not found' });
    // `run` may start the LIVE version; a Test runs the working copy
    // (unpublished changes), which is an editor's tool and needs `edit`. The
    // run executes AS THE OWNER and records who pressed the button in
    // startedByUserId.
    if (!await automationAccess.guard(req, res, a, isTest ? 'edit' : 'run')) return;
    const ownerId = a.userId || userId;
    const runner = require('../../core/automationRunner');

    // Manual runs are user-initiated and should execute synchronously
    // so the UI can immediately show what happened (success / per-step
    // output / errors). Cap the wait so a misbehaving step can't hang
    // the request; if the cap is hit, fall back to fire-and-forget.
    const RESPONSE_TIMEOUT_MS = 60_000;
    let timedOut = false;
    let guardTimer;
    const guard = new Promise((resolve) => { guardTimer = setTimeout(() => { timedOut = true; resolve(null); }, RESPONSE_TIMEOUT_MS); });
    // The cap counts from here, so the payload lookups below spend from it as
    // they always have. Every way out of the block — an early return, a throw,
    // a run that beat the cap — clears the timer: left armed, it would hold
    // this request's closure for the rest of the minute after the response.
    try {
        // For Gmail-triggered automations the manual run is meaningless
        // without a real email payload (every binding resolves to undefined,
        // gmail_compose then errors with "to is required" etc.). Synthesize
        // a payload from the user's most recent matching inbox message so
        // the test mirrors a real fire of the trigger.
        let triggerPayload = req.body.triggerPayload || null;
        // Which entry point to test: the primary unless the caller names one of
        // the ADDITIONAL triggers (definition.triggers[]). The payload synthesis
        // below and the run itself both follow that trigger.
        const entered = resolveTriggerStepId(await entryDefinitionOf(a), req.body.triggerStepId);
        if (entered.error) return res.status(400).json({ error: entered.error });
        const trig = entered.trigger;
        const isGmailTrig = trig?.kind === 'app_event'
            && trig?.appEvent?.provider === 'gmail'
            && trig?.appEvent?.event === 'mail.new';
        const isNcTrig = trig?.kind === 'app_event' && trig?.appEvent?.provider === 'nextcloud';
        if (isGmailTrig && !triggerPayload) {
            const triggerBus = require('../../automation/triggerBus');
            const latest = await triggerBus.fetchLatestGmailMatch(ownerId, trig.appEvent.filter || null);
            if (latest) {
                triggerPayload = { provider: 'gmail', event: 'mail.new', ...latest };
            } else {
                return res.status(200).json({
                    accepted: true,
                    pending: false,
                    skipped: true,
                    message: 'No matching email found in your inbox to test against. The automation is ready — it will fire when a new matching email arrives.',
                });
            }
        }
        // Nextcloud-triggered automations need the same treatment: a manual run
        // with no payload leaves trigger.output.path undefined and the first NC
        // action fails ("path is required") — the "Sort Invoices" symptom.
        if (isNcTrig && !triggerPayload) {
            const triggerBus = require('../../automation/triggerBus');
            const ev = String(trig.appEvent.event || '').replace(/^nextcloud\./, '');
            const latest = await triggerBus.fetchLatestNextcloudMatch(ownerId, ev, trig.appEvent.filter || null);
            if (latest) {
                triggerPayload = { provider: 'nextcloud', event: trig.appEvent.event, ...latest };
            } else {
                return res.status(200).json({
                    accepted: true,
                    pending: false,
                    skipped: true,
                    message: 'No matching recent Nextcloud activity to test against. The automation is ready — it will fire when a matching event arrives.',
                });
            }
        }

        const runPromise = runner.executeAutomation(a, {
            triggerKind: 'manual',
            triggerPayload,
            mode: 'live',
            rootStepId: entered.rootStepId,
            isTest,
            startedByUserId: userId,
        }).catch(e => {
            // A refusal the caller must see (a managed automation with no live
            // copy answers 409) is not a "still running" 202.
            if (e instanceof HttpError || e?.errorClass === 'managed_part_not_deployed') throw e;
            log.error('[automation/run] error:', e.message);
            return null;
        });

        const run = await Promise.race([runPromise, guard]);

        if (timedOut || !run) {
            return res.status(202).json({
                accepted: true,
                pending: true,
                message: 'Run is still in progress. Check the run history shortly.',
            });
        }
        const steps = await automationStore.getRunSteps(run.id).catch(() => []);
        return res.status(200).json({
            accepted: true,
            run,
            steps,
        });
    } finally {
        clearTimeout(guardTimer);
    }
});

// POST /:id/diagnose-trigger lives in diagnoseTrigger.js, mounted here so it
// keeps its place in the route table (between /:id/run and /:id/dry-run).
router.use(require('./diagnoseTrigger'));

router.post('/:id/dry-run', runTriggerLimiter, validate({ body: RunBody }), async (req, res) => {
    const userId = req.session.user.id;
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    // A dry run previews the WORKING copy: an editor's tool, like a Test.
    if (!await automationAccess.guard(req, res, a, 'edit')) return;
    const runner = require('../../core/automationRunner');
    const entered = resolveTriggerStepId(await entryDefinitionOf(a), req.body.triggerStepId);
    if (entered.error) return res.status(400).json({ error: entered.error });
    const run = await runner.executeAutomation(a, { triggerKind: 'dry_run', triggerPayload: req.body.triggerPayload || null, mode: 'dry_run', rootStepId: entered.rootStepId, startedByUserId: userId });
    const steps = await automationStore.getRunSteps(run.id);
    res.json({ run, steps });
});

/**
 * n8n-style "Execute step" — run a single step using replay data from
 * the most recent prior run (and any pinned outputs). Returns the
 * resulting step record so the inspector can show input/output without
 * the user waiting for a full dry-run.
 *
 * mode='only' (default) runs just `stepId`. mode='from' runs the step
 * and every downstream node — used by the retry-from-failed-step UI.
 * mode='upTo' runs the flow from the trigger and stops after `stepId` —
 * the canvas's "run up to here", where the steps before it execute for real
 * unless they carry a pinned output.
 */
router.post('/:id/steps/:stepId/run', runTriggerLimiter, validate({ body: PartialRunBody }), async (req, res) => {
    const userId = req.session.user.id;
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    // Executing one step is an editor's tool, not a way to start the automation.
    if (!await automationAccess.guard(req, res, a, 'edit')) return;
    const runner = require('../../core/automationRunner');
    const entered = resolveTriggerStepId(await entryDefinitionOf(a), req.body.triggerStepId);
    if (entered.error) return res.status(400).json({ error: entered.error });
    const run = await runner.runPartial(a, req.params.stepId, {
        mode: req.body.mode,
        triggerKind: 'manual_step',
        triggerPayload: req.body.triggerPayload || null,
        rootStepId: entered.rootStepId,
        startedByUserId: userId,
    });
    const steps = await automationStore.getRunSteps(run.id);
    const stepRecord = steps.find(s => s.stepId === req.params.stepId) || null;
    res.json({ run, steps, stepRecord });
});

/**
 * Active runs for the current user — drives the sidebar "● Running" dot
 * and the concurrent-run guard. Lightweight: returns a flat list of
 * `{ runId, automationId, status, startedAt }`.
 */
router.get('/_runs/active', async (req, res) => {
    const userId = req.session.user.id;
    const active = await automationStore.getActiveRunsForUser(userId);
    res.json({ active });
});

/**
 * Preview a cron expression. Used by the visual schedule builder to
 * show the user the next N firing times in their chosen timezone and
 * to validate ad-hoc expressions before they save. Delegates to the
 * same `cron.nextRunAt` the runner uses, so the preview is bit-exact
 * with what would actually fire.
 *
 * Body: { cron, tz, count?, skipHolidays? } — count defaults to 3, capped at 5.
 * With skipHolidays the previewed runs leave Dutch public holidays out (in
 * the schedule's own time zone), and `skipped` names the holidays the plain
 * schedule would have fired on inside the previewed window.
 *
 * Rate-limited like the run-spawning routes. Each preview is `count` full
 * schedule computations over a 366-day window on the request thread; before
 * the day-level rewrite of cron.nextRunAt a single count=20 request for a
 * sparse cron ("0 0 1 1 *") blocked the Node event loop for ~64 seconds, and
 * this was the one route in the file with no limiter at all. The cap is 5
 * because the only caller (ScheduleBuilder) asks for 3.
 */
router.post('/_schedule/preview', runTriggerLimiter, validate({ body: SchedulePreviewBody }), async (req, res) => {
    const { cron: cronExpr, tz, count } = req.body;
    const skipHolidays = req.body.skipHolidays === true;
    try {
        cron.parseCron(cronExpr);
    } catch (e) {
        return res.json({ valid: false, error: e.message });
    }
    const next = [];
    const startedAt = Date.now();
    let from = startedAt;
    let skipped = [];
    try {
        for (let i = 0; i < count; i++) {
            const iso = holidays.nextScheduledRunAt(cronExpr, tz, from, { skipHolidays });
            if (!iso) break;
            next.push(iso);
            // Continue the scan FROM the match we just found: nextRunAt itself
            // rounds up to the next whole minute, so this already yields a
            // strictly-later match. (Adding another 60s on top made an
            // every-minute cron preview a 2-minute cadence.)
            from = new Date(iso).getTime();
        }
        if (skipHolidays) {
            // The window the preview covers: up to the last run shown, or the
            // scheduler's whole one-year horizon when nothing is left.
            const until = next.length ? Date.parse(next[next.length - 1]) : startedAt + 366 * 86_400_000;
            skipped = holidays.holidaysSkippedBetween(cronExpr, tz, startedAt, until);
        }
    } catch (e) {
        // Only the time zone can throw past parseCron (Intl rejects an
        // unknown IANA name); the scheduler would hit the same error.
        return res.json({ valid: false, error: `Unknown time zone "${tz}": ${e.message}` });
    }
    res.json({ valid: true, cron: cronExpr, tz, next, skipHolidays, skipped });
});

// Parse the executions-table filters off a query string. Arrays are
// comma-separated (status, triggerKind, mode); since/until are ISO timestamps
// on started_at. Shared by /:id/runs, /_runs/recent and /_runs/facets so the
// list and the filter chips always agree.
function parseRunFilters(req) {
    const q = req.query;
    const csv = (v) => (v && v.trim()) ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const filters = {};
    const status = csv(q.status); if (status) filters.status = status;
    const triggerKind = csv(q.triggerKind || q.trigger); if (triggerKind) filters.triggerKind = triggerKind;
    const mode = csv(q.mode); if (mode) filters.mode = mode;
    if (q.automationId) filters.automationId = q.automationId;
    if (q.kind) filters.kind = q.kind;
    if (q.since) filters.sinceTs = q.since;
    if (q.until) filters.untilTs = q.until;
    if (q.q) filters.q = q.q;
    if (q.startedBy) filters.startedBy = q.startedBy === 'me' ? req.session.user.id : q.startedBy;
    if (q.tests && q.tests !== 'include') filters.tests = q.tests;
    return filters;
}

// Handoff 5: the Runs tab's row fields (automation/runListRows.js), in one
// batched read per kind of fact per page.
const { makeRunRowDecorator, segmentCounts } = require('../../automation/runListRows');
const runRows = makeRunRowDecorator({
    store: automationStore,
    getUsersByIds: (ids) => require('../../stores/userStore').getUserAvatarsByIds(ids),
});

router.get('/:id/runs', validate({ query: RunsQuery }), async (req, res) => {
    const userId = req.session.user.id;
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await automationAccess.guard(req, res, a, 'run');
    if (!access) return;
    // Scoped by the AUTOMATION (handoff 5), not by who owned it at run time, so
    // an automation handed to a new owner keeps its history. `view` and up read
    // every run; `run` reads only the runs they started. The same
    // cursor/filter machinery as the global list narrows it further.
    const filters = {
        ...parseRunFilters(req), cursor: req.query.cursor, limit: req.query.limit,
        ...(access.role === 'run' ? { startedByUserId: userId } : {}),
    };
    const { runs, nextCursor } = await automationStore.listRunsForAutomation(a.id, filters);
    // The filter segment's counts ride along on the FIRST page: same scope and
    // filters as the list (period, search, tests, "started by"), minus the
    // status being chosen, so every segment says what switching to it shows.
    let facets;
    if (!req.query.cursor) {
        const { status: _status, cursor: _cursor, limit: _limit, ...scope } = filters;
        // Counts are a nicety beside the list: a failed count leaves them out.
        const counted = await automationStore.getRunFacetsForAutomation(a.id, scope).catch((e) => {
            log.warn(`[automation/runs] facets for ${a.id} failed: ${e.message}`);
            return null;
        });
        if (counted) facets = segmentCounts(counted.status);
    }
    res.json({
        runs: await runRows.decorate(runs, { automation: a }),
        nextCursor,
        myRole: access.role,
        onlyMine: access.role === 'run',
        ...(facets ? { facets } : {}),
    });
});

/**
 * Cross-automation recent runs for the current user. Powers the unified
 * activity view in the studio's empty-pane state so users can spot
 * failures across all of their automations without drilling in one by
 * one. Always scoped to the requesting user — no admin-wide endpoint.
 *
 * That last sentence still stands for THIS route and for /_runs/facets below,
 * and it must keep standing. The organisation-wide read that Studio → Runs &
 * log offers is a SEPARATE pair of endpoints (/_runs/org and
 * /_runs/org/facets, further down) with a permission check of its own. It was
 * built beside these rather than as a `?scope=org` on them for one reason: a
 * scope parameter on a route that is user-scoped by contract makes every
 * existing caller — the builder's history tab, the polling fallback in
 * useRunStream, the approvals backfill — one query-string away from returning
 * somebody else's runs.
 */
router.get('/_runs/recent', validate({ query: RunsQuery }), async (req, res) => {
    const userId = req.session.user.id;
    // Cursor-paginated + filterable. `limit` kept for back-compat (old
    // callers read `runs`); `nextCursor` is additive.
    const filters = { ...parseRunFilters(req), cursor: req.query.cursor, limit: req.query.limit || 50 };
    const { runs, nextCursor } = await automationStore.listRunsForUser(userId, filters);
    res.json({ runs: await runRows.decorate(runs), nextCursor });
});

/**
 * §9 Activity dashboard — facet counts for the filter chips.
 *
 * Returns counts grouped by status, automation, trigger kind, and error
 * class, restricted to the last `range` hours (default 24, max 720 = 30
 * days). Indexed SQL via getRunFacetsForUser. Scoped by the same date /
 * automation / kind "context" as the list, but NOT by the status/trigger
 * filters themselves, so the chips show the full breakdown you can switch to.
 */
router.get('/_runs/facets', validate({ query: FacetsQuery }), async (req, res) => {
    const userId = req.session.user.id;
    const range = Math.min(Math.max(req.query.range || 24, 1), 720);
    const sinceTs = new Date(Date.now() - range * 3600 * 1000).toISOString();
    const base = parseRunFilters(req);
    const facets = await automationStore.getRunFacetsForUser(userId, {
        sinceTs, automationId: base.automationId, kind: base.kind, mode: base.mode,
    });
    res.json({ facets, rangeHours: range });
});

/* ─────────────────────────────────────────────────────────────────────────
 * THE ORGANISATION-WIDE RUN LOG (Track H2) — its own endpoints, its own check.
 *
 * Studio → Runs & log defaults to "my runs" (the two routes above). Switching
 * it to "the organisation" lands here, and here is the ONLY place in this file
 * where a caller can see a run they did not start.
 *
 * Three rules, and each of them is a mistake this codebase has made before:
 *
 *  1. THE PERMISSION IS CHECKED, NOT INFERRED. `manage_automations`
 *     (auth/permissions.js) resolved through hasPermission, which reads the
 *     user's real groups and roles — not `req.session.user.orgRole`, which a
 *     stale session can still carry after a demotion.
 *
 *  2. A REFUSAL IS A 403, NEVER A NARROWING. Answering a caller who asked for
 *     the organisation with their own runs instead would show a plausible,
 *     smaller list and say nothing — an admin whose permission was removed
 *     would go on reading a "complete" log that had quietly become personal.
 *     Same reasoning as GET /approvals?scope=org.
 *
 *  3. NO ORGANISATION IS A REFUSAL TOO. On a personal install `orgId` is null,
 *     and a scope built from it would either match nothing or — far worse —
 *     match every org-less row on a shared instance, putting all of those
 *     users in one bucket. stores/automationStore/forms.js draws the same
 *     line for the same reason, and buildRunFilterWhere refuses a null org
 *     independently, so this is the second of two locks and not the only one.
 *
 * The org id comes from the users table, not the session: a person moved to
 * another organisation must not keep reading their old one's runs until they
 * log out.
 */
async function resolveOrgRunViewer(req) {
    const userId = req.session?.user?.id || null;
    if (!userId) return { userId: null, orgId: null, mayReadOrg: false };
    const userStore = require('../../stores/userStore');
    const { hasPermission } = require('../../auth/permissions');
    // Both reads are independently fail-closed: an unreadable user row is no
    // organisation, and a failed permission probe is no permission. Neither
    // may fall back to "carry on with what the session claims".
    const user = await userStore.getUser(userId).catch(() => null);
    const mayReadOrg = await hasPermission(userId, 'manage_automations', req.session).catch(() => false);
    return { userId, orgId: user?.organizationId || null, mayReadOrg: !!mayReadOrg };
}

/** 403 + a reason, or null when the caller may read the organisation's runs. */
function refuseOrgScope(viewer) {
    if (!viewer.userId) return { status: 401, error: 'Not signed in' };
    if (!viewer.mayReadOrg) {
        return { status: 403, error: "Reading the organisation's runs requires the manage_automations permission." };
    }
    if (!viewer.orgId) {
        return { status: 403, error: 'This account is not part of an organisation, so there is no organisation-wide run log.' };
    }
    return null;
}

/**
 * Every run of every automation in the caller's organisation, newest first.
 *
 * Same cursor/filter machinery as /_runs/recent — the filters NARROW the org
 * scope, they never replace it (stores/automationStore/runs.js) — but a
 * different row shape: `rowToOrgRunRow` builds each row from an explicit
 * allow-list, so a colleague's trigger payload (a whole form submission, a
 * whole inbound e-mail) never travels. Each row carries `mine`, which the
 * client checks FOR TRUE before offering to open the run: every per-run route
 * is still scoped to the run's owner and 403s for anybody else.
 */
router.get('/_runs/org', validate({ query: RunsQuery }), async (req, res) => {
    const viewer = await resolveOrgRunViewer(req);
    const refusal = refuseOrgScope(viewer);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
    // Who started a run is not part of the organisation log (rowToOrgRunRow
    // carries no identity), so it cannot be filtered on either: a filter
    // would answer the question the row refuses to.
    if (req.query.startedBy) {
        throw new HttpError(400, 'filter_not_available', 'startedBy is not available on the organisation run log.');
    }
    const filters = { ...parseRunFilters(req), cursor: req.query.cursor, limit: req.query.limit || 50 };
    const { runs, nextCursor } = await automationStore.listRunsForOrg(viewer.orgId, filters, {
        viewerUserId: viewer.userId,
    });
    res.json({ runs: await runRows.decorate(runs, { withStarter: false, withApprovals: false }), nextCursor, scope: 'org' });
});

/**
 * The org-scope twin of /_runs/facets — the chips' counts and the per-automation
 * rollup the "Now running · last 24 hours" strip draws.
 *
 * The check is repeated here rather than derived from the list call: two
 * endpoints, two proofs. A facets route that trusted "the list must have been
 * allowed" would hand a refused caller the shape of the organisation's
 * activity — which automations exist, how often they run, what breaks.
 */
router.get('/_runs/org/facets', validate({ query: FacetsQuery }), async (req, res) => {
    const viewer = await resolveOrgRunViewer(req);
    const refusal = refuseOrgScope(viewer);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
    const range = Math.min(Math.max(req.query.range || 24, 1), 720);
    const sinceTs = new Date(Date.now() - range * 3600 * 1000).toISOString();
    const base = parseRunFilters(req);
    const facets = await automationStore.getRunFacetsForOrg(viewer.orgId, {
        sinceTs, automationId: base.automationId, kind: base.kind, mode: base.mode,
    });
    res.json({ facets, rangeHours: range, scope: 'org' });
});

/**
 * §9 SSE stream of run lifecycle events for the CURRENT USER. Subscribes to
 * runEventBus (which the runner now emits to) and pushes events as they fire,
 * dropping any event whose `userId` isn't the subscriber's. An optional
 * `?automationId=` further scopes the stream to one automation/Step surface.
 *
 * Consumed via fetch streaming (authFetch), so the normal X-Session-Token /
 * cookie auth applies — no query-string token needed.
 */
router.get('/_runs/stream', validate({ query: StreamQuery }), async (req, res) => {
    const me = req.session.user.id;
    const scopeAutomationId = req.query.automationId || null;
    const { onAny } = require('../../core/runEventBus');
    const { startSseHeartbeat } = require('../../core/http/sseHelpers');
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const unsubscribe = onAny((event) => {
        // Per-user scoping — never leak another user's run activity.
        if (event.userId && event.userId !== me) return;
        if (scopeAutomationId && event.automationId && event.automationId !== scopeAutomationId) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    // unref'd heartbeat that also self-stops on res close/finish/error —
    // previously a bare setInterval that leaked if 'close' never fired.
    const stopHeartbeat = startSseHeartbeat(res, 25_000, { frame: ': keepalive\n\n' });
    req.on('close', () => {
        stopHeartbeat();
        unsubscribe();
    });
});

// Templates routes were moved to the top of this file (just before `/:id`)
// to avoid Express matching `/:id` first against the literal "templates".


module.exports = router;
