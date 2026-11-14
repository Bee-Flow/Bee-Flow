// @typecheck strict
/**
 * The run log of an app (package 8): who ran which action, when, how long, how it ended, and
 * per step the duration, the error and the AI usage.
 *
 *   GET /:id/runs          newest first, filters actionId / status / origin / user / since, keyset paged
 *   GET /:id/runs/:runId   one run with its steps
 *
 * Owner only (canWriteStudioApp), every other caller the same 404 as an unknown app (the
 * /versions pattern). The rows carry no customer values (runLog/recorder.mts, clickRuns.mts);
 * people appear by display name, never by e-mail address. Thin: queries in
 * stores/studioAppData/runLogStore.mts, projections in appStudio/runLog/readRuns.mts.
 */

const express = require('express');
const { validate } = require('../../core/http/validate');
const studioAppStore = require('../../stores/studioAppStore');
const { requireAuth } = require('../../auth/permissions');
const { sessionUser } = require('../../core/http/sessionUser');
const { RunsQuery, RunParams } = require('./schemas');
const { runLogStore } = require('../../stores/studioAppData/runLogStore.mts');
const { RUN_ID_RE, idleCloseMs, staleStepMs, retentionDays } = require('../../stores/studioAppData/runPolicy.mts');
const { readRunQuery, listPage, toRunSummary, toStepView } = require('../../appStudio/runLog/readRuns.mts');

const router = express.Router();

/**
 * The app when the caller may read its runs, else null (answered 404).
 * @param {import('express').Request<{ id: string }>} req
 */
async function ownedApp(req) {
    const app = await studioAppStore.getStudioApp(req.params.id);
    return app && studioAppStore.canWriteStudioApp(app, sessionUser(req).id) ? app : null;
}

router.get('/:id/runs', requireAuth, validate({ query: RunsQuery }), async (req, res) => {
    const app = await ownedApp(req);
    if (!app) return res.status(404).json({ error: 'App not found' });
    const callerId = sessionUser(req).id;
    const filter = readRunQuery({ ...req.query, limit: req.query.limit ? Number(req.query.limit) : undefined }, {
        appId: app.id, callerId, idleMs: idleCloseMs(), staleMs: staleStepMs(), maxLimit: 100, defaultLimit: 50,
    });
    if ('error' in filter) return res.status(400).json({ error: filter.error });
    const store = runLogStore();
    const { rows, nextCursor } = await listPage(store, filter);
    res.json({
        runs: rows.map((r) => toRunSummary(r, app.userId, callerId)),
        nextCursor,
        retentionDays: retentionDays(),
        // Who ran this app (for the filter), on the first page only.
        ...(req.query.cursor ? {} : { actors: await store.actorFacets(app.id) }),
    });
});

router.get('/:id/runs/:runId', requireAuth, validate({ params: RunParams }), /** @param {import('express').Request<{ id: string, runId: string }>} req */ async (req, res) => {
    const app = await ownedApp(req);
    if (!app) return res.status(404).json({ error: 'App not found' });
    if (!RUN_ID_RE.test(req.params.runId)) return res.status(404).json({ error: 'Run not found' }); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- RUN_ID_RE is the fixed /^sar_[0-9a-f]{32}$/, linear on any input
    const store = runLogStore();
    const run = await store.getLoggedRun(app.id, req.params.runId, { idleMs: idleCloseMs(), staleMs: staleStepMs() });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const steps = await store.getSteps(run.id);
    // A run a record trigger started: which change started it (the event, the table, the row's id and the kind of writer; no row values).
    const startedBy = run.origin === 'trigger' ? await require('../../appStudio/triggers/recordDrain.mts').runStartedBy(run.id) : null;
    res.json({ run: toRunSummary(run, app.userId, sessionUser(req).id), steps: steps.map(toStepView), ...(startedBy ? { startedBy } : {}) });
});

module.exports = router;
