/**
 * THE PHASES THE SERVER RUNS ITSELF — one POST, and the phase's KIND decides
 * which of them owns the request.
 *
 * `table` creates or adopts the datatable, `fill` runs the routine once, and
 * `design` asks the designer for the app as a person will see it; the
 * compliance review is big enough to live in complianceReview.js. Each of
 * them persists `running` BEFORE it starts, so a reload cannot start a second
 * one, and each ends through savePhaseOutcome so a lost race still leaves a
 * phase a person can retry. `failStuckPhase` is the same promise for a throw.
 */

'use strict';

const lifecycle = require('../../playbooks/lifecycle');
const { runTablePhase } = require('../../playbooks/phases/tablePhase');
const { startFillPhase, refreshFillPhase } = require('../../playbooks/phases/fillPhase');
const { z, sendErr, MAX_FEEDBACK, worded, bodyOf, check } = require('./contract');

// ONE route, four phase kinds, and between them two keys.
//
// `feedback` is what a person asks the designer to change. A misspelled
// `feedbak` on a design that has LANDED read as "no feedback", which is not a
// revision but a fresh run -- and a fresh run on an `awaiting` phase is
// `phase_not_ready`, so the button did nothing and blamed the phase's state.
//
// `recheck` belongs to the COMPLIANCE phase (complianceReview.js) and is read
// there, not here. It is named in this schema because the Studio sends it:
// `.strict()` without it would have 400'd the "read it again" button.
//
// `feedback` is capped at MAX_FEEDBACK, the same limit the Studio's box has.
// It was SLICED there instead, so a longer request reached the designer cut
// off mid-sentence and was kept that way in the phase's revision list.
const FEEDBACK_TEXT = 'feedback is what should change about the design.';
const RunBody = bodyOf({
    feedback: worded(FEEDBACK_TEXT).max(MAX_FEEDBACK, `feedback is at most ${MAX_FEEDBACK} characters.`).nullish(),
    recheck: z.boolean({ invalid_type_error: 'recheck is true or false.' }).optional(),
});
const { kindOf, firstOfKind, routineBefore, localeOf } = require('./phaseList');
const { makeRunComplianceReview } = require('./complianceReview');
const log = require('../../telemetry/log');

function register(router, ctx) {
    const { d, flow, requireManageApps, runLimiter } = ctx;
    const { resolveRecipe, load, withBrief, savePhaseOutcome, phaseTier } = flow;
    const runComplianceReview = makeRunComplianceReview(ctx);

    const runTable = async (req, res, pb, key, progress = null) => {
        const recipe = resolveRecipe(pb);
        const cur = lifecycle.phaseByKey(pb.phases, key);
        if (!cur || cur.status !== 'ready') return sendErr(res, 409, 'phase_not_ready', `The table phase is ${cur ? cur.status : 'missing'}.`, { from: cur ? cur.status : null, to: 'running' });
        const principal = await d.datatableAccess.resolveDatatablePrincipalForUser(pb.userId);
        const hasManageDatatables = await d.permissions.hasPermission(pb.userId, d.permissions.Permissions.MANAGE_DATATABLES, req.session).catch(() => false);
        const nowIso = new Date(d.now()).toISOString();
        let phases = lifecycle.applyTransition(pb.phases, key, 'running', {}, nowIso);
        // Persist `running` before creating anything. It was the only server
        // phase that did not, so a reload mid-creation left the row at `ready`,
        // the stage POSTed /run again and a second table was created beside the
        // first; now the `phase_not_ready` guard above rejects the duplicate.
        let version = pb.version;
        {
            const running = await d.playbookStore.savePhases(pb.id, pb.userId, { phases, currentPhase: key }, { expectedVersion: pb.version });
            if (!running.ok) return running.conflict ? sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: running.currentVersion, playbook: running.playbook }) : sendErr(res, 404, 'not_found', 'Not found');
            version = running.version;
        }
        const result = await runTablePhase({ playbook: pb, principal, recipe, hasManageDatatables }, d);
        if (!result.ok) {
            phases = lifecycle.applyTransition(phases, key, 'failed', { error: result.error }, nowIso);
            const saved = await d.playbookStore.savePhases(pb.id, pb.userId, { phases, currentPhase: key }, { expectedVersion: version });
            const httpStatus = result.code === 'manage_datatables_required' ? 403 : (result.code === 'key_taken' ? 409 : 422);
            return sendErr(res, httpStatus, result.code, result.error, { missing: result.missing || undefined, playbook: saved.ok ? saved.playbook : pb });
        }
        phases = lifecycle.applyTransition(phases, key, 'awaiting', { artifacts: result.artifacts, summary: result.summary, error: null }, nowIso);
        // From here on the table EXISTS. If anything below throws, the failure
        // must carry its id — the retry's createNew reuses it (no second table).
        if (progress) progress.phases = phases;
        // The next phase's brief can be composed now — the handoff card shows it.
        const nextKey = lifecycle.nextPhaseKey(phases, key);
        if (nextKey) { try { phases = withBrief(recipe, pb, phases, nextKey); } catch (e) { if (e.code !== 'artifacts_missing') throw e; } }
        const saved = await savePhaseOutcome(pb, key, phases, version);
        if (!saved.ok) {
            return saved.conflict
                ? sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: saved.currentVersion, playbook: saved.playbook })
                : sendErr(res, 404, 'not_found', 'Not found');
        }
        res.json({ playbook: saved.playbook });
    };

    const runFill = async (req, res, pb, key) => {
        const cur = lifecycle.phaseByKey(pb.phases, key);
        if (!cur || cur.status !== 'ready') return sendErr(res, 409, 'phase_not_ready', `The fill phase is ${cur ? cur.status : 'missing'}.`, { from: cur ? cur.status : null, to: 'running' });
        const routine = routineBefore(pb.phases, key);
        const automationId = routine && routine.artifacts && routine.artifacts.automationId;
        const tableArtifacts = (firstOfKind(pb.phases, 'table') || {}).artifacts || {};
        const nowIso = new Date(d.now()).toISOString();
        // The fill phase carries the table's id/scope in its own artifacts
        // so refreshFillPhase can read the row count from the phase alone.
        let phases = lifecycle.applyTransition(pb.phases, key, 'running', { error: null, artifacts: { datatableId: tableArtifacts.datatableId, datatableScope: tableArtifacts.datatableScope } }, nowIso);
        let version = pb.version;
        const saveNow = async (next) => {
            const saved = await d.playbookStore.savePhases(pb.id, pb.userId, { phases: next, currentPhase: key }, { expectedVersion: version });
            if (saved.ok) { version = saved.version; phases = next; return saved.playbook; }
            const fresh = await d.playbookStore.getPlaybook(pb.id, pb.userId);
            if (fresh) { version = fresh.version; phases = fresh.phases; }
            return fresh;
        };
        const started = await startFillPhase({
            playbook: pb, automationId, tableArtifacts,
            onRunCreated: (run) => {
                if (!run || !run.id) return;
                saveNow(phases.map((p) => (p.key === key ? { ...p, artifacts: { ...(p.artifacts || {}), runId: run.id, runStatus: 'running' } } : p))).catch(() => {});
            },
        }, d);
        if (!started.ok) {
            const failed = lifecycle.applyTransition(phases, key, 'failed', { error: started.error }, nowIso);
            const saved = await saveNow(failed);
            return sendErr(res, 422, started.code, started.error, { playbook: saved || pb });
        }
        const withRun = phases.map((p) => (p.key === key ? { ...p, artifacts: { ...(p.artifacts || {}), runId: started.runId || (p.artifacts || {}).runId || null, rowsBefore: started.rowsBefore, runStatus: started.run ? started.run.status : 'running' } } : p));
        const finish = async (base) => {
            const fill = lifecycle.phaseByKey(base, key);
            const change = await refreshFillPhase({ ...fill, startedAt: fill.startedAt || nowIso }, d, d.now(), { locale: localeOf(pb) });
            if (!change) return base;
            let next = base.map((p) => (p.key === key ? { ...p, artifacts: change.artifacts } : p));
            if (change.status !== 'running') next = lifecycle.applyTransition(next, key, change.status, { summary: change.summary || null, error: change.error || null }, new Date(d.now()).toISOString());
            return next;
        };
        if (started.timedOut) {
            const saved = await saveNow(withRun);
            // Finish in the background; GET refreshes too.
            if (started.runPromise) started.runPromise.then(async () => { try { await saveNow(await finish(phases)); } catch (e) { log.error('[Playbooks] fill completion failed:', e.message); } });
            return res.status(202).json({ playbook: saved || pb, pending: true });
        }
        const finished = await finish(withRun);
        const saved = await saveNow(finished);
        res.json({ playbook: saved || pb });
    };

    const runDesign = async (req, res, pb, key) => {
        const recipe = resolveRecipe(pb);
        const cur = lifecycle.phaseByKey(pb.phases, key);
        // A REVISION: the design landed, the person asks for something else.
        // It is the same phase doing the same work again, so it never leaves
        // `awaiting` — the machine (and its pinned transition table) stays out
        // of it; only the artifacts and the app's brief change.
        const feedback = (req.body.feedback || '').trim().slice(0, MAX_FEEDBACK);
        const revising = !!feedback && !!cur && cur.status === 'awaiting' && !!(cur.artifacts && cur.artifacts.design);
        if (!cur || (cur.status !== 'ready' && !revising)) return sendErr(res, 409, 'phase_not_ready', `The design phase is ${cur ? cur.status : 'missing'}.`, { from: cur ? cur.status : null, to: 'running' });
        // The tier, measured against the owner's list BEFORE anything moves:
        // a refusal leaves the phase where it was, with nothing to fail.
        const tier = await phaseTier(req, res, pb);
        if (!tier) return;
        const nowIso = new Date(d.now()).toISOString();
        let phases = pb.phases;
        let version = pb.version;
        if (!revising) {
            phases = lifecycle.applyTransition(pb.phases, key, 'running', { error: null }, nowIso);
            const running = await d.playbookStore.savePhases(pb.id, pb.userId, { phases, currentPhase: key }, { expectedVersion: pb.version });
            if (!running.ok) return running.conflict ? sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: running.currentVersion, playbook: running.playbook }) : sendErr(res, 404, 'not_found', 'Not found');
            version = running.version;
        }
        // The designer's material: the goal in plain words, the table as it
        // is today (columns, count, two sample rows), whether approvals follow.
        const spec = typeof recipe.phaseSpec === 'function' ? recipe.phaseSpec(key) : null;
        const goal = (cur.goal || (spec && spec.goal) || recipe.description || pb.title || '').trim();
        const tableArt = (firstOfKind(phases, 'table') || {}).artifacts || {};
        let table = null;
        let sampleRows = [];
        if (tableArt.datatableId) {
            table = { name: tableArt.datatableName, fields: tableArt.fields || [], rowCount: tableArt.rowCount };
            try {
                const principal = await d.datatableAccess.resolveDatatablePrincipalForUser(pb.userId);
                const row = await d.datatableStore.getDatatable(tableArt.datatableId, tableArt.datatableScope);
                if (row && Number.isFinite(Number(row.rowCount))) table.rowCount = Number(row.rowCount);
                const resolved = await d.datatableRuntime.resolveForPrincipal(tableArt.datatableId, principal, { needed: 'viewer' });
                const page = await d.datatableRuntime.readRows(resolved, { allowColumns: (tableArt.fields || []).map((f) => f.key), limit: 2 });
                sampleRows = Array.isArray(page && page.rows) ? page.rows : [];
            } catch { /* the designer works from the columns alone */ }
        }
        const idx = phases.findIndex((p) => p.key === key);
        const approvals = phases.slice(idx + 1).some((p) => p.requires === 'approvals' && p.status !== 'locked');
        // The app phase's brief is the CONCRETE instruction the builder will
        // receive. A design made without it can contradict it (two screens
        // against "create one screen"), and then whichever the model believes
        // is a coin toss. It designs WITHIN the brief instead.
        const appPhase = phases.slice(idx + 1).find((p) => kindOf(p) === 'app') || null;
        // It has no brief yet — briefs are composed when a phase becomes
        // ready, which is after this. Compose it now, for reading only (no
        // design exists yet, so this is the plain brief).
        let appBrief = (appPhase && appPhase.brief) || null;
        if (appPhase && !appBrief) {
            try { appBrief = lifecycle.composeBriefFor(recipe, appPhase.key, { ...pb, phases }); } catch { /* not enough artifacts — the designer works from the goal */ }
        }
        const result = await d.runDesignPhase({
            tier,
            goal, table, sampleRows, approvals,
            ask: (pb.options && pb.options.ask) || null,
            builderBrief: appBrief,
            locale: (pb.options && pb.options.locale) || 'nl',
            userId: pb.userId,
            userOrgId: pb.organizationId,
            ...(revising ? { feedback, previousDesign: cur.artifacts.design } : {}),
        });
        const doneIso = new Date(d.now()).toISOString();
        if (!result.ok) {
            // An unreachable model carries the id its log line was written
            // under: the one thing that ties this screen to that line.
            const logged = result.correlationId ? { correlationId: result.correlationId } : {};
            // A revision that fails leaves the design that stands on screen.
            if (revising) return sendErr(res, 422, result.code, result.error, { playbook: pb, ...logged });
            phases = lifecycle.applyTransition(phases, key, 'failed', { error: result.error }, doneIso);
            const saved = await d.playbookStore.savePhases(pb.id, pb.userId, { phases, currentPhase: key }, { expectedVersion: version });
            return sendErr(res, 422, result.code, result.error, { playbook: saved.ok ? saved.playbook : pb, ...logged });
        }
        phases = revising
            ? phases.map((p) => (p.key === key
                ? { ...p, summary: result.summary, error: null, finishedAt: doneIso, artifacts: { ...(p.artifacts || {}), ...result.artifacts, revisions: [...((p.artifacts && p.artifacts.revisions) || []), feedback].slice(-5) } }
                : p))
            : lifecycle.applyTransition(phases, key, 'awaiting', { artifacts: result.artifacts, summary: result.summary, error: null }, doneIso);
        const nextKey = lifecycle.nextPhaseKey(phases, key);
        if (nextKey) { try { phases = withBrief(recipe, pb, phases, nextKey); } catch (e) { if (e.code !== 'artifacts_missing') throw e; } }
        const saved = await savePhaseOutcome(pb, key, phases, version);
        if (!saved.ok) return sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: saved.currentVersion, playbook: saved.playbook });
        res.json({ playbook: saved.playbook });
    };

    /**
     * A server phase that THROWS after its `running` transition was persisted
     * used to leave the row `running` for ever: the 500 said nothing the page
     * could act on, `running → ready` is not a transition so Retry answered 409,
     * and the client offers Skip for client-run kinds only. Re-read the row and
     * fail the phase, so the handoff card gets its Retry / Skip back.
     */
    const failStuckPhase = async (res, pb, key, e, inflightPhases = null) => {
        log.error('[Playbooks] server phase threw:', e && e.message);
        try {
            const fresh = await d.playbookStore.getPlaybook(pb.id, pb.userId);
            const cur = fresh && lifecycle.phaseByKey(fresh.phases, key);
            if (!fresh || !cur || cur.status !== 'running') return sendErr(res, 500, 'internal', 'Could not run the phase');
            const message = (e && e.message) || 'the phase could not be run';
            // Keep whatever the phase had already made (a created table's id):
            // a retry reads it back and reuses the artifact instead of
            // creating a second one.
            const inflight = inflightPhases ? lifecycle.phaseByKey(inflightPhases, key) : null;
            const phases = lifecycle.applyTransition(fresh.phases, key, 'failed', {
                error: message,
                ...(inflight && inflight.artifacts && Object.keys(inflight.artifacts).length ? { artifacts: inflight.artifacts } : {}),
            }, new Date(d.now()).toISOString());
            const saved = await d.playbookStore.savePhases(fresh.id, fresh.userId, { phases, currentPhase: key }, { expectedVersion: fresh.version });
            return sendErr(res, 422, 'phase_failed', message, { playbook: saved.ok ? saved.playbook : fresh });
        } catch (inner) {
            log.error('[Playbooks] could not fail the stuck phase:', inner.message);
            return sendErr(res, 500, 'internal', 'Could not run the phase');
        }
    };

    // One route for the phases the server runs; the phase's KIND decides.
    router.post('/:id/phases/:key/run', requireManageApps, runLimiter, async (req, res) => {
        const parsed = check(res, RunBody, req.body, 'bad_patch');
        if (!parsed.ok) return;
        req.body = parsed.value;
        let pb = null;
        // What the running phase has made so far (the table phase's created
        // datatableId) — failStuckPhase preserves it on the failure so a retry
        // reuses the artifact instead of creating a second one.
        const progress = { phases: null };
        try {
            pb = await load(req, res);
            if (!pb) return;
            const key = req.params.key;
            const cur = lifecycle.phaseByKey(pb.phases, key);
            if (!cur) return sendErr(res, 400, 'bad_patch', 'Unknown phase.');
            const kind = kindOf(cur);
            if (kind === 'table') return await runTable(req, res, pb, key, progress);
            if (kind === 'fill') return await runFill(req, res, pb, key);
            if (kind === 'design') return await runDesign(req, res, pb, key);
            if (kind === 'compliance') return await runComplianceReview(req, res, pb, key);
            return sendErr(res, 409, 'illegal_transition', `The ${kind} phase runs in the builder — PATCH it running.`, { from: cur.status, to: 'running' });
        } catch (e) {
            if (!pb) { log.error('[Playbooks] server phase failed:', e.message); return sendErr(res, 500, 'internal', 'Could not run the phase'); }
            return await failStuckPhase(res, pb, req.params.key, e, progress.phases);
        }
    });
}

module.exports = { register };
