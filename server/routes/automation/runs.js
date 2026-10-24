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
const { HttpError } = require('../../core/http/errors');
const { entryDefinitionOf, resolveTriggerStepId } = require('./runEntry');
const { resolveRunPolicy } = require('../../core/automationRunner/runPolicy');
const { describeNoticeFor } = require('../../core/automationRunner/callerNotice');
// Handoff 5 sharing: who may start, test and read the runs of an automation.
const { makeAutomationAccess, roleSatisfies } = require('../../automation/access');
const automationAccess = makeAutomationAccess({ store: automationStore });

const { SeenBody, RunBody, PartialRunBody, RerunPlanQuery, RunsQuery, FacetsQuery, StreamQuery, SchedulePreviewBody } = require('./runSchemas');

// Per-user throttle for the expensive run-trigger endpoints (each spins up a
// full automation execution / LLM + tool calls). Keyed by session user id via
// the limiter's default. Generous enough for normal manual testing, low enough
// that a stuck client or a script can't flood the runner. Tunable via env.
const RUN_TRIGGER_RPM = parseInt(process.env.AUTOMATION_RUN_TRIGGER_RPM, 10) || 30;
const runTriggerLimiter = perUserRateLimit({ windowMs: 60_000, max: RUN_TRIGGER_RPM });

router.post('/:id/run', runTriggerLimiter, validate({ body: RunBody }), async (req, res) => {
    const userId = req.session.user.id;
    const isTest = req.body.test === true;
    // The copy this run executes (handoff 5), resolved up front so the
    // trigger lookup and payload synthesis below read the same definition.
    const stored = await automationStore.getAutomation(req.params.id);
    const a = require('../../core/automationRunner/definitionForRun').automationForRun(stored, { mode: 'live', triggerKind: 'manual', isTest });
    if (!a) return res.status(404).json({ error: 'Not found' });
    // `run` may start the LIVE version; a Test runs the working copy
    // (unpublished changes), which is an editor's tool and needs `edit`. The
    // run executes AS THE OWNER and records who pressed the button in
    // startedByUserId.
    const access = await automationAccess.guard(req, res, a, isTest ? 'edit' : 'run');
    if (!access) return;
    const ownerId = a.userId || userId;
    // The first time somebody other than the owner runs an automation that uses
    // THEIR OWN connections, they are told which apps it will act in and must
    // acknowledge that once (POST /:id/caller-notice/seen).
    const notice = await describeNoticeFor({ automation: stored, userId, store: automationStore, canEdit: roleSatisfies(access.role, 'edit') });
    if (notice.applies && !notice.seen) {
        throw new HttpError(409, 'caller_notice_required', 'This automation runs with your own connections. Read the notice and confirm before the first run.', { providers: notice.providers, destinations: notice.destinations });
    }
    // The account a sample trigger payload is read from: the owner's, except on
    // an automation that runs on its starter's own connections, where somebody
    // else pressing Run must never read the owner's mailbox or drive.
    const sampleUserId = (resolveRunPolicy(a.definition).connections === 'caller' && ownerId !== userId) ? userId : ownerId;
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
            const latest = await triggerBus.fetchLatestGmailMatch(sampleUserId, trig.appEvent.filter || null);
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
            const latest = await triggerBus.fetchLatestNextcloudMatch(sampleUserId, ev, trig.appEvent.filter || null);
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
        const steps = await automationStore.getRunSteps(run.id).catch((e) => fallback('routes/automation/runs:anon', e, []));
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

// The one-time "this runs with your own connections" notice (callerNotice.js).
router.get('/:id/caller-notice', async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await automationAccess.guard(req, res, a, 'run');
    if (!access) return;
    res.json(await describeNoticeFor({ automation: a, userId: req.session.user.id, store: automationStore, canEdit: roleSatisfies(access.role, 'edit') }));
});

// Body { items }: the items the person was SHOWN. Only what is still part of the notice is recorded, and a
// notice that changed since it was shown is refused (409), so nothing is ever acknowledged unseen.
router.post('/:id/caller-notice/seen', validate({ body: SeenBody }), async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await automationAccess.guard(req, res, a, 'run');
    if (!access) return;
    const userId = req.session.user.id;
    const notice = await describeNoticeFor({ automation: a, userId, store: automationStore, canEdit: roleSatisfies(access.role, 'edit') });
    const shown = new Set(req.body.items);
    const recorded = notice.items.filter((i) => shown.has(i));
    if (recorded.length !== notice.items.length) {
        throw new HttpError(409, 'caller_notice_changed', 'This automation changed since you read the notice. Read it again.', { items: notice.items });
    }
    await automationStore.markCallerNoticeSeen(userId, a.id, recorded);
    res.json({ ok: true });
});

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
        // Re-run from a chosen run (see the doc above); all three are inert
        // without seedRunId.
        seedRunId: req.body.seedRunId || null,
        allowLiveUpstream: req.body.allowLiveUpstream === true,
        confirmSideEffects: req.body.confirmSideEffects === true,
    });
    const steps = await automationStore.getRunSteps(run.id);
    const stepRecord = steps.find(s => s.stepId === req.params.stepId) || null;
    // The plan describes this response, not the run: it leaves the run row.
    const { rerunPlan, ...runRow } = run;
    res.json(rerunPlan ? { run: runRow, steps, stepRecord, rerunPlan } : { run, steps, stepRecord });
});

/**
 * What "run this step with the inputs of run X" would do, without doing it: the
 * steps that would execute, the ones among them that have no recorded output in
 * that run (they would run live), and the ones that send or write outside the
 * run, so the UI can ask before the POST above is sent. Same access as the POST
 * (an editor's tool); the run is checked exactly as there, so a run of another
 * automation or one whose data the caller may not read answers 404.
 *
 * Query: seedRunId (required), mode ('only' | 'from', default 'only'),
 * triggerStepId. Answers `{ rerunPlan }`, see core/automationRunner/partialRuns.js.
 */
router.get('/:id/steps/:stepId/rerun-plan', validate({ query: RerunPlanQuery }), async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'edit')) return;
    const runner = require('../../core/automationRunner');
    const entered = resolveTriggerStepId(await entryDefinitionOf(a), req.query.triggerStepId);
    if (entered.error) return res.status(400).json({ error: entered.error });
    let rerunPlan;
    try {
        rerunPlan = await runner.planPartialRun(a, req.params.stepId, {
            mode: req.query.mode,
            rootStepId: entered.rootStepId,
            startedByUserId: req.session.user.id,
            seedRunId: req.query.seedRunId,
        });
    } catch (e) {
        // runPartial names a step it cannot find in a plain Error.
        if (/not found in definition/.test(e?.message || '')) throw new HttpError(404, 'step_not_found', 'Step not found in this automation.');
        throw e;
    }
    res.json({ rerunPlan });
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
const { fallback } = require('../../utils/bestEffort');
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
        viewerUserId: userId,
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
        runs: await runRows.decorate(runs, { automation: a, viewerId: userId }),
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
    res.json({ runs: await runRows.decorate(runs, { viewerId: userId }), nextCursor });
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
    const user = await userStore.getUser(userId).catch((e) => fallback('routes/automation/runs:resolveOrgRunViewer', e, null));
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
    const filters = { ...parseRunFilters(req), cursor: req.query.cursor, limit: req.query.limit || 50, viewerUserId: viewer.userId };
    const { runs, nextCursor } = await automationStore.listRunsForOrg(viewer.orgId, filters, {
        viewerUserId: viewer.userId,
    });
    res.json({ runs: await runRows.decorate(runs, { withStarter: false, withApprovals: false, viewerId: viewer.userId }), nextCursor, scope: 'org' });
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
    const { openSse } = require('../../core/http/sseHelpers');
    // The head Express's res.set wrote (it appends the charset), and a 25 s
    // `: keepalive` comment: unref'd, and it self-stops on res
    // close/finish/error — previously a bare setInterval that leaked if
    // 'close' never fired.
    const { sendRaw, stopHeartbeat } = openSse(res, {
        charset: 'utf-8', viaSetHeader: true, flush: true,
        heartbeat: { intervalMs: 25_000, frame: ': keepalive\n\n' },
    });
    const unsubscribe = onAny((event) => {
        // Per-user scoping — never leak another user's run activity.
        if (event.userId && event.userId !== me) return;
        if (scopeAutomationId && event.automationId && event.automationId !== scopeAutomationId) return;
        sendRaw(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.on('close', () => {
        stopHeartbeat();
        unsubscribe();
    });
});

// Templates routes were moved to the top of this file (just before `/:id`)
// to avoid Express matching `/:id` first against the literal "templates".


module.exports = router;
