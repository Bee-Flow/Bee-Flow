// @typecheck
/**
 * Golden runs: finished runs kept as the reference a later replay is compared
 * with (automation/testing/goldenReplay.js).
 *
 *   POST   /runs/:runId/golden        mark a run  { label?, ignorePaths? }   → 201 { golden }
 *   DELETE /runs/:runId/golden        unmark it                              → { deleted }
 *   GET    /:id/goldens               the list                               → { goldens, limits }
 *   POST   /:id/goldens/replay        replay now  { goldenIds?, aiAnswers? } → 202 { replaying }
 *
 * GoldenItem = { goldenId, runId, label, ignorePaths, createdAt, createdBy,
 *                run: { status, mode, version, triggerKind, startedAt } | null,
 *                lastReplay: null | { status, at, replayRunId, summary, errorCode } }
 * `status` of a replay is running | same | soft | changed | error | interrupted;
 * a replay still 'running' long after it started reads as 'interrupted'.
 *
 * Marking a run reads it through the one door the test-data features share
 * (automation/testing/runDataAccess.js): the caller must be able to read its
 * data, it must have finished, must not have used its starter's own
 * connections and must not sit on a PRD automation. A leg id is normalised to
 * the journey root. A golden follows run retention: its row cascades from the
 * run, so it disappears when the run is cleaned up. It holds no values, only the
 * run id, a label, the ignored paths and the verdict of the last replay.
 *
 * Answers:
 *   404  run, automation or golden not found (also: no role on the automation)
 *   409  golden_needs_success | partial_run_not_golden | golden_limit
 *        | replay_in_progress | caller_run_not_capturable | run_not_finished
 *        | test_data_not_on_prd
 *   202  the replay started; it runs in the background and its verdict lands on
 *        each golden (poll the list)
 *
 * Limits (env, 0 = unlimited): AUTOMATION_GOLDENS_MAX (50),
 * AUTOMATION_GOLDEN_REPLAY_RPM (6). Built by a factory so a test hands in its
 * own stores, access and replayer.
 */

'use strict';

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { validate } = require('../../core/http/validate');
const { bodyOf, worded, choice, idList, z } = require('../../core/http/schemaParts');
const { makeAutomationAccess } = require('../../automation/access');
const { makeRunDataAccess } = require('../../automation/testing/runDataAccess');
const { makeGuarded } = require('./guardedAutomation');
const { effectiveStatus, anyRunning } = require('../../automation/testing/goldenReplay');
const { envCap } = require('../../automation/mcpRunReadCaps');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { fallback } = require('../../utils/bestEffort');

const LABEL_TEXT = 'label is up to 80 characters.';
const PATH_TEXT = 'ignorePaths is a list of up to 50 paths, each up to 500 characters.';
const MarkBody = bodyOf({
    label: worded(LABEL_TEXT).trim().max(80, LABEL_TEXT).optional(),
    ignorePaths: z.array(worded(PATH_TEXT).max(500, PATH_TEXT), { error: PATH_TEXT }).max(50, PATH_TEXT).optional(),
});
const ID_TEXT = 'goldenIds is a list of up to 50 golden ids.';
const ReplayBody = bodyOf({
    goldenIds: idList(ID_TEXT, 50).optional(),
    aiAnswers: choice(['live', 'cache'], 'aiAnswers is "live" or "cache".').optional(),
});

const maxGoldens = () => envCap('AUTOMATION_GOLDENS_MAX', 50);
const replayRpm = () => envCap('AUTOMATION_GOLDEN_REPLAY_RPM', 6);

/**
 * The run facts a golden list shows: no values, only where and when.
 * @param {{ status?: string, mode?: string | null, version?: number | null, triggerKind?: string | null, startedAt?: string | Date | null } | null} root
 * @param {{ status?: string } | null} [latest]
 */
function describeRun(root, latest) {
    if (!root) return null;
    return {
        status: (latest || root).status,
        mode: root.mode ?? null,
        version: root.version ?? null,
        triggerKind: root.triggerKind ?? null,
        startedAt: root.startedAt ?? null,
    };
}

/**
 * One golden as the client sees it: an explicit allow-list, never the row.
 * @param {ReturnType<typeof import('../../stores/lib/automationTestingGoldens').rowToGolden>} golden
 * @param {ReturnType<typeof describeRun>} runInfo
 * @param {number} [now]
 */
function describeGolden(golden, runInfo, now = Date.now()) {
    const last = golden.lastReplay;
    return {
        goldenId: golden.id,
        runId: golden.runId,
        label: golden.label ?? null,
        ignorePaths: Array.isArray(golden.ignorePaths) ? golden.ignorePaths : [],
        createdAt: golden.createdAt,
        createdBy: golden.createdBy ?? null,
        run: runInfo,
        lastReplay: last ? {
            status: effectiveStatus(last, now),
            at: last.at ?? null,
            replayRunId: last.replayRunId ?? null,
            summary: last.summary ?? null,
            errorCode: last.errorCode ?? null,
        } : null,
    };
}

/**
 * @param {object} [overrides]
 * @param {any} [overrides.store]          automationStore surface (getAutomation, getRun, getLatestRunInChain)
 * @param {any} [overrides.testingStore]   automationTestingStore surface (golden functions)
 * @param {any} [overrides.access]         the automation access guard
 * @param {any} [overrides.runDataAccess]  { readableRun, assertCapturable, assertTestDataAllowed }
 * @param {Function} [overrides.replayGoldens]
 * @param {import('express').RequestHandler} [overrides.limiter]   middleware for the replay route
 * @param {(fn: () => void) => void} [overrides.defer]  how the background work is scheduled (default setImmediate)
 */
function makeGoldensRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const testing = () => overrides.testingStore || require('../../stores/automationTestingStore');
    const access = overrides.access
        || makeAutomationAccess(overrides.store ? { store: overrides.store } : {});
    const runData = overrides.runDataAccess || makeRunDataAccess({ store: overrides.store, access });
    const replay = /** @param {Parameters<typeof import('../../automation/testing/goldenReplay').replayGoldens>} args */ (...args) => (overrides.replayGoldens || require('../../automation/testing/goldenReplay').replayGoldens)(...args);
    const defer = overrides.defer || ((fn) => setImmediate(fn));
    const rpm = replayRpm();
    const limiter = overrides.limiter
        || (rpm > 0 ? perUserRateLimit({ windowMs: 60_000, max: rpm }) : (_req, _res, next) => next());

    const guarded = makeGuarded({ store, access });

    /**
     * @param {string} goldenRunId
     */
    async function runInfoOf(goldenRunId) {
        const [root, latest] = await Promise.all([
            Promise.resolve(store().getRun(goldenRunId)).catch((e) => fallback('routes/automation/goldens:runInfoOf', e, null)),
            Promise.resolve(store().getLatestRunInChain?.(goldenRunId)).catch((e) => fallback('routes/automation/goldens:runInfoOf#2', e, null)),
        ]);
        return describeRun(root, latest);
    }

    router.post('/runs/:runId/golden', validate({ body: MarkBody }), async (req, res) => {
        const found = await runData.readableRun(req, res, req.params.runId, 'save it as a golden run');
        if (!found) return undefined;
        const a = await store().getAutomation(found.run.automationId);
        if (!a) throw new HttpError(404, 'run_not_found', 'Not found');
        if (!await access.guard(req, res, a, 'edit')) return undefined;
        await runData.assertTestDataAllowed(a);
        await runData.assertCapturable(found.run, found.legs);

        // A step run on its own is a fragment of a journey, not a reference for one.
        if (found.root.triggerKind === 'manual_step') {
            throw new HttpError(409, 'partial_run_not_golden', 'A run of a single step cannot be a golden run. Pick a run of the whole automation.');
        }
        const latest = await Promise.resolve(store().getLatestRunInChain?.(found.run.id)).catch((e) => fallback('routes/automation/goldens:makeGoldensRouter', e, null))
            || found.legs[found.legs.length - 1] || found.run;
        if (latest.status !== 'success') {
            throw new HttpError(409, 'golden_needs_success', 'Only a run that finished successfully can be a golden run.');
        }

        const cap = maxGoldens();
        const existing = await testing().getGoldenByRun(found.root.id);
        if (!existing && cap > 0 && await testing().countGoldens(a.id) >= cap) {
            throw new HttpError(409, 'golden_limit', `An automation keeps at most ${cap} golden runs. Remove one to add another.`);
        }
        const golden = await testing().createGolden({
            automationId: a.id,
            runId: found.root.id,
            label: req.body.label ? req.body.label : null,
            ignorePaths: [...new Set((req.body.ignorePaths || []).filter(Boolean))],
            createdBy: req.session.user.id,
        });
        return res.status(201).json({ golden: describeGolden(golden, describeRun(found.root, latest)) });
    });

    router.delete('/runs/:runId/golden', async (req, res) => {
        const found = await runData.readableRun(req, res, req.params.runId, 'see its data');
        if (!found) return undefined;
        const a = await store().getAutomation(found.run.automationId);
        if (!a) throw new HttpError(404, 'run_not_found', 'Not found');
        if (!await access.guard(req, res, a, 'edit')) return undefined;
        const deleted = await testing().deleteGoldenByRun(found.root.id);
        return res.json({ deleted: !!deleted });
    });

    router.get('/:id/goldens', async (req, res) => {
        const a = await guarded(req, res, 'view');
        if (!a) return undefined;
        const rows = await testing().listGoldens(a.id);
        const now = Date.now();
        const goldens = await Promise.all(rows.map(async (/** @type {ReturnType<typeof import('../../stores/lib/automationTestingGoldens').rowToGolden>} */ g) => describeGolden(g, await runInfoOf(g.runId), now)));
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ goldens, limits: { max: maxGoldens() } });
    });

    router.post('/:id/goldens/replay', limiter, validate({ body: ReplayBody }), async (req, res) => {
        const a = await guarded(req, res, 'edit');
        if (!a) return undefined;
        await runData.assertTestDataAllowed(a);
        const all = await testing().listGoldens(a.id);
        if (anyRunning(all)) throw new HttpError(409, 'replay_in_progress', 'A replay is already running. Wait for it to finish.');
        const wanted = req.body.goldenIds;
        let selected = all;
        if (wanted) {
            selected = wanted.map((/** @type {string} */ id) => all.find((/** @type {ReturnType<typeof import('../../stores/lib/automationTestingGoldens').rowToGolden>} */ g) => g.id === id));
            if (selected.some((/** @type {ReturnType<typeof import('../../stores/lib/automationTestingGoldens').rowToGolden> | undefined} */ g) => !g)) throw new HttpError(404, 'golden_not_found', 'Not found');
        }
        selected = [...new Set(selected)];
        const userId = req.session.user.id;
        const aiAnswers = req.body.aiAnswers || 'live';
        if (!selected.length) return res.status(202).json({ replaying: [] });

        // Marked running BEFORE the answer, so a second request right behind
        // this one finds the replay in progress instead of starting its own.
        await Promise.all(selected.map((/** @type {ReturnType<typeof import('../../stores/lib/automationTestingGoldens').rowToGolden>} */ g) => testing().setGoldenReplay(g.id, { status: 'running', summary: null, replayRunId: null, errorCode: null })));
        defer(() => {
            Promise.resolve()
                .then(() => replay({ automation: a, goldens: selected, userId, aiAnswers }))
                .catch(async (/** @type {{ code?: string }} */ e) => {
                    // replayGoldens records its own failures; this is the net under it.
                    log.warn(`[automation/goldens] replay of ${a.id} failed: ${e.code || 'replay_failed'}`);
                    await Promise.all(selected.map((g) => Promise.resolve(testing().setGoldenReplay(g.id, { status: 'error', summary: null, replayRunId: null, errorCode: 'replay_failed' })).catch((e) => fallback('routes/automation/goldens:makeGoldensRouter#2', e, null))));
                });
        });
        return res.status(202).json({ replaying: selected.map((/** @type {ReturnType<typeof import('../../stores/lib/automationTestingGoldens').rowToGolden>} */ g) => g.id) });
    });

    return router;
}

module.exports = { makeGoldensRouter, describeGolden };
