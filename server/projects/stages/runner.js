/**
 * The deployment runner (design 6.4, 6.5, 6.7, D9): admission, claim, lease,
 * heartbeat, execution by kind, compensation, and the reconciliation that
 * lets any replica finish what a crashed one started.
 *
 *   admit     (the route, after stageAuth) the Solution owner, who is also the
 *             stage's run-as user, asks for a deployment of a plan they saw:
 *             the plan is recomputed and must hash the same (409 plan_stale
 *             {plan}), every acknowledgement it asks for must be given (409
 *             acknowledgement_missing), nothing may block, then ONE exclusive
 *             insert (insertDeployment: 409 approval_pending / stage_busy).
 *             PRD with the gate on → `awaiting_approval` + approvalGate.request;
 *             otherwise `queued` and kicked in-process.
 *   runOne    claim (one replica wins) with a 2-minute lease and a 30-second
 *             heartbeat. A row that waited for approval is planned again and
 *             must still hash the same (plan_stale_after_approval). Then by kind:
 *               deploy/rollback/redeploy  prepare → committing → commit → converge
 *               settings                  committing → commitSettings → converge
 *               remove                    prepareRemove → committing → commitRemove → finishRemove
 *             Any error before the commit landed: `compensating`, compensate,
 *             then `failed` with `{ code, message }` (never a stack or content).
 *   resumeStale  an in-flight row whose lease ran out is reclaimed (one replica
 *             wins) and decided FROM THE ROW, never from the stage pointer (a
 *             redeploy's target already equals it before the commit):
 *             preparing / committing / compensating → compensate → failed;
 *             converging (committed) → converge again.
 *   tick      the job's 15-second tick: reconcile awaiting approvals (getApproval
 *             injected: a store may not require automation/), resume stale
 *             rows, run what is claimable.
 *
 * Every collaborator is injected (`makeRunner(deps)`); nothing requires routes/.
 */

'use strict';

const crypto = require('crypto');
const os = require('os');
const { HttpError } = require('../../core/http/errors');
const log = require('../../telemetry/log');
const { RELEASE_KINDS, needsApproval } = require('./model');
const { storesOf } = require('./prepare');

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

const LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
/** Blocking findings whose code is the refusal itself (design 6.2): answered as that 409. */
const ELIGIBILITY_CODES = Object.freeze(['release_not_found', 'release_not_pipeline', 'release_blocked',
    'release_not_in_uat', 'rollback_target_invalid', 'redeploy_target_invalid', 'stage_invalid', 'kind_invalid']);

/** What the row stores as its settings patch: the gate change of a `settings` row; for a `remove`, the flag the PLAN carries. */
function storedPatchOf(kind, settingsPatch, plan) {
    if (kind === 'remove') return plan && plan.deleteData === true ? { deleteData: true } : null;
    return kind === 'settings' ? (settingsPatch || null) : null;
}

const actorIdOf = (actor) => (typeof actor === 'string' ? actor : (actor && actor.id) || null);

/** An acknowledgement the requester gave covers a required one with the same code (and ref, when it has one). */
function missingAcknowledgements(required, given) {
    const list = (Array.isArray(given) ? given : []).map(g => (typeof g === 'string' ? { code: g } : g)).filter(isObject);
    return (Array.isArray(required) ? required : []).filter((r) => {
        const need = typeof r === 'string' ? { code: r } : r;
        return !list.some(g => g.code === need.code && (need.ref == null || g.ref === need.ref));
    });
}

/** What a failed row records: a code, a message we wrote, refs and finding codes; never a stack or content. */
function errorOf(err) {
    const code = err && typeof err.code === 'string' && err.code ? err.code : 'deployment_failed';
    const exposed = err && err.expose === true && typeof err.message === 'string';
    const out = { code, message: exposed ? err.message : 'The deployment failed. Nothing changed in the stage.' };
    const d = err && isObject(err.details) ? err.details : null;
    if (d && typeof d.ref === 'string') out.ref = d.ref;
    if (d && typeof d.why === 'string') out.why = d.why;
    if (d && Array.isArray(d.findings)) out.findings = d.findings.slice(0, 50).map(f => ({ code: f.code, ...(f.ref ? { ref: f.ref } : {}) }));
    return out;
}

/**
 * @param {object} [deps]
 *   stores (prepare.storesOf: solutionStageStore, blueprintStore, ...), `plan(input, planDeps)`,
 *   `planDeps`, `approvalGate` ({ request }), `approvalDeps`, `getApproval(id)`, `solutionOwnerOf(solutionId)`,
 *   `prepare`, `commit`, `commitSettings`, `converge`, `compensate`, `removeStage` ({ prepareRemove,
 *   commitRemove, finishRemove }), `workerId`, `leaseMs`, `heartbeatMs`, `now()`, `setInterval`,
 *   `clearInterval`, `schedule(fn)` (the in-process kick; default setImmediate)
 */
function makeRunner(deps = {}) {
    const s = storesOf(deps);
    const workerId = deps.workerId || `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
    const leaseMs = Number(deps.leaseMs) > 0 ? Number(deps.leaseMs) : LEASE_MS;
    const heartbeatMs = Number(deps.heartbeatMs) > 0 ? Number(deps.heartbeatMs) : HEARTBEAT_MS;
    const now = deps.now || (() => new Date());
    const planFn = dep(deps, 'plan', () => require('./plan').plan);
    const planDeps = deps.planDeps || deps;
    const phases = {
        get prepare() { return dep(deps, 'prepare', () => require('./prepare').prepare); },
        get commit() { return dep(deps, 'commit', () => require('./commit').commit); },
        get commitSettings() { return dep(deps, 'commitSettings', () => require('./commit').commitSettings); },
        get converge() { return dep(deps, 'converge', () => require('./converge').converge); },
        get compensate() { return dep(deps, 'compensate', () => require('./compensate').compensate); },
        get removeStage() { return dep(deps, 'removeStage', () => require('./removeStage')); },
        get approvalGate() { return dep(deps, 'approvalGate', () => require('./approvalGate')); },
    };
    const solutionOwnerOf = dep(deps, 'solutionOwnerOf', () => async (solutionId) => {
        const project = await s.projectStore.getProject(solutionId);
        return project ? project.ownerId : null;
    });
    const getApproval = dep(deps, 'getApproval', () => (id) => require('../../stores/automationStore').getApproval(id));
    const schedule = deps.schedule || ((fn) => setImmediate(fn));
    const every = deps.setInterval || setInterval;
    const stopEvery = deps.clearInterval || clearInterval;

    // ── admission ───────────────────────────────────────────────────────────

    /** The row a request key already made on this stage, or null. */
    async function findByRequestKey(stageProjectId, requestKey) {
        const st = s.stageStore;
        if (typeof st.getDeploymentByRequestKey === 'function') return st.getDeploymentByRequestKey(stageProjectId, requestKey);
        if (typeof st.listDeployments !== 'function') return null;
        let before = null;
        for (let page = 0; page < 10; page += 1) {
            const rows = await st.listDeployments(stageProjectId, { limit: 100, before });
            const hit = rows.find(r => r && r.requestKey === requestKey);
            if (hit) return (await st.getDeployment(hit.id)) || hit;
            if (rows.length < 100) return null;
            before = rows[rows.length - 1].id;
        }
        return null;
    }

    /**
     * @param {{ solutionId: string, stage: 'uat'|'prd', releaseId?: string|null, kind?: string, planHash: string,
     *   requestKey: string, acknowledgements?: any[], actor: string|{ id: string }, settingsPatch?: object|null }} input
     *   `settingsPatch`: the gate change of a `settings` deployment; `{ deleteData }` asks a `remove` to drop the
     *   stage's data, which only counts once the plan carries it
     * @returns {Promise<{ deployment: object, replayed: boolean }>}
     */
    async function admit({ solutionId, stage, releaseId = null, kind = 'deploy', planHash, requestKey,
        acknowledgements = [], actor, settingsPatch = null } = /** @type {any} */ ({})) {
        const actorId = actorIdOf(actor);
        if (!actorId) throw new HttpError(401, 'unauthorized', 'Sign in to deploy.');
        if (typeof requestKey !== 'string' || !requestKey) throw new HttpError(400, 'request_key_required', 'A request key is required.');
        const stageRow = await s.stageStore.getStageFor(solutionId, stage);
        if (!stageRow) throw new HttpError(404, 'stage_not_found', 'This stage does not exist.');
        if (RELEASE_KINDS.includes(kind) || kind === 'settings') {
            // D12: the Solution owner deploys, and runs every part of the stage (run-as).
            if (actorId !== await solutionOwnerOf(solutionId)) throw new HttpError(403, 'solution_owner_only', 'Only the Solution owner can deploy.');
            if (actorId !== stageRow.runAsUserId) throw new HttpError(403, 'run_as_mismatch', 'The stage runs as somebody else.');
        }
        // The same (stage, request_key) is the same request: a retry after the first one queued, ran or
        // finished answers that row. It comes before the plan, whose hash moves once the first request ran.
        const existing = await findByRequestKey(stageRow.projectId, requestKey);
        if (existing) return { deployment: existing, replayed: true };
        // `deleteData` is a destructive choice: it goes INTO the plan (so into its hash, its
        // acknowledgements and the approval details) and the stored flag comes from the plan, never
        // from the raw request.
        const wantsDeleteData = kind === 'remove' && isObject(settingsPatch) && settingsPatch.deleteData === true;
        const plan = await planFn({ stageProjectId: stageRow.projectId, releaseId, kind,
            settingsPatch: kind === 'settings' ? settingsPatch : null,
            ...(kind === 'remove' ? { deleteData: wantsDeleteData } : {}) }, planDeps);
        if (plan.planHash !== planHash) throw new HttpError(409, 'plan_stale', 'The plan changed. Review it again.', { plan });
        // A plan that does not carry the flag cannot have been reviewed with it.
        if (wantsDeleteData && plan.deleteData !== true) throw new HttpError(409, 'plan_stale', 'The plan changed. Review it again.', { plan });
        const missing = missingAcknowledgements(plan.acknowledgementsRequired, acknowledgements);
        if (missing.length) throw new HttpError(409, 'acknowledgement_missing', 'Confirm every point of the plan first.', { missing });
        const blocked = Array.isArray(plan.blocking) ? plan.blocking : [];
        if (blocked.length) {
            const first = blocked[0];
            if (first && ELIGIBILITY_CODES.includes(first.code)) throw new HttpError(409, first.code, 'This release cannot go to this stage.', { findings: blocked });
            throw new HttpError(409, 'plan_blocked', 'Something blocks this deployment.', { findings: blocked });
        }
        const awaiting = needsApproval({ stage: stageRow, kind });
        const row = await s.stageStore.insertDeployment({
            solutionId, stageProjectId: stageRow.projectId, stage: stageRow.stage,
            releaseId: plan.release ? plan.release.id : null, releaseSeq: plan.release ? plan.release.seq : null,
            fromReleaseId: stageRow.currentReleaseId || null, kind,
            status: awaiting ? 'awaiting_approval' : 'queued',
            settingsPatch: storedPatchOf(kind, settingsPatch, plan), plan, planHash: plan.planHash,
            stageSettingsVersion: plan.settingsVersion ?? stageRow.settingsVersion,
            requestKey, requestedBy: actorId,
            acknowledgements: (Array.isArray(acknowledgements) ? acknowledgements : []).filter(a => isObject(a) || typeof a === 'string'),
        });
        if (row.replayed) return { deployment: row, replayed: true };
        if (awaiting) {
            try {
                await phases.approvalGate.request({ deployment: row, stage: stageRow, plan, actor: { id: actorId } }, deps.approvalDeps || {});
            } catch (err) {
                // The row stays awaiting without an approval; reconcileAwaitingApprovals cancels it after 60 s.
                log.warn(`[stages/runner] approval request for ${row.id} failed: ${err && err.message}`);
            }
        } else {
            kick(row.id);
        }
        return { deployment: row, replayed: false };
    }

    /** Run a queued deployment now, in this process; the job picks it up otherwise. */
    function kick(id) {
        schedule(() => {
            runOne(id).catch(err => log.warn(`[stages/runner] run of ${id} failed: ${err && err.message}`));
        });
    }

    // ── execution ───────────────────────────────────────────────────────────

    /** Run `fn` while this worker keeps the row's lease alive. */
    async function withLease(row, fn) {
        const state = { lost: false };
        const timer = every(() => {
            s.stageStore.heartbeat(row.id, workerId, leaseMs)
                .then((held) => { if (!held) { state.lost = true; log.warn(`[stages/runner] lost the lease of ${row.id}`); } })
                .catch(err => log.warn(`[stages/runner] heartbeat of ${row.id} failed: ${err && err.message}`));
        }, heartbeatMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        try {
            return await fn(state);
        } finally {
            stopEvery(timer);
        }
    }

    async function move(row, from, to, patch = {}) {
        const moved = await s.stageStore.transitionDeployment(row.id, from, to, patch);
        if (!moved) throw new HttpError(409, 'deployment_lost', `This deployment is no longer ${Array.isArray(from) ? from.join('/') : from}.`);
        return moved;
    }

    /** The stage a deployment acts on; a removal past its commit has no stage row any more. */
    async function stageFor(row) {
        const stage = await s.stageStore.getStage(row.stageProjectId);
        if (stage) return stage;
        return { projectId: row.stageProjectId, solutionId: row.solutionId, stage: row.stage, runAsUserId: row.requestedBy, organizationId: null };
    }

    /** Compensate (the row is moved to `compensating` first) and fail. */
    async function compensateAndFail(row, stage, error) {
        const current = await s.stageStore.getDeployment(row.id);
        if (!current) return null;
        if (current.status === 'converging') return current;        // committed: converge owns it
        if (await removeHasDeleted(current)) return failRemoveForward(current);
        let compensated = null;
        if (current.status !== 'compensating') {
            await s.stageStore.transitionDeployment(row.id, ['preparing', 'committing'], 'compensating', {});
        }
        try {
            compensated = await phases.compensate({ deployment: current, stage }, deps);
        } catch (err) {
            log.warn(`[stages/runner] compensation of ${row.id} failed: ${err && err.message}`);
        }
        return s.stageStore.transitionDeployment(row.id, ['compensating'], 'failed', {
            error, ...(compensated ? { report: { compensation: compensated } } : {}),
        });
    }

    /** A remove whose commit already deleted (or began deleting) a part: compensation cannot bring it back. */
    async function removeHasDeleted(row) {
        if (row.kind !== 'remove' || row.status !== 'committing') return false;
        const started = phases.removeStage.removeStarted;
        return typeof started === 'function' ? started({ deployment: row }, deps) : false;
    }

    /**
     * The point of no return of a removal. Nothing is undone: the parts already deleted stay deleted,
     * the stage keeps its rows, and the row says so. A new removal of the stage finishes the job.
     */
    function failRemoveForward(row) {
        return s.stageStore.transitionDeployment(row.id, ['committing'], 'failed', {
            error: { code: 'remove_incomplete',
                message: 'The removal stopped part way. Parts that were already deleted stay deleted. Remove the stage again to finish it.' },
        });
    }

    async function convergeRow(row, stage) {
        if (row.kind === 'remove') return phases.removeStage.finishRemove({ deployment: row, stage }, deps);
        return phases.converge({ deployment: row, stage }, deps);
    }

    async function execute(row, { approved }) {
        const stage = await stageFor(row);
        if (!stage.organizationId && row.kind !== 'remove') {
            return move(row, 'preparing', 'failed', { error: { code: 'stage_not_found', message: 'This stage no longer exists.' } });
        }
        let plan = row.plan;
        try {
            if (approved) {
                const again = await planFn({ stageProjectId: row.stageProjectId, releaseId: row.releaseId, kind: row.kind,
                    settingsPatch: row.kind === 'settings' ? row.settingsPatch : null,
                    ...(row.kind === 'remove' ? { deleteData: !!(row.plan && row.plan.deleteData === true) } : {}) }, planDeps);
                if (again.planHash !== row.planHash) {
                    return move(row, 'preparing', 'failed', { error: { code: 'plan_stale_after_approval', message: 'The plan changed after it was approved. Plan it again.' } });
                }
                if (Array.isArray(again.blocking) && again.blocking.length) {
                    return move(row, 'preparing', 'failed', { error: errorOf(new HttpError(409, 'plan_blocked_after_approval',
                        'Something blocks this deployment now.', { findings: again.blocking })) });
                }
                plan = again;
            }
            let committed;
            if (RELEASE_KINDS.includes(row.kind)) {
                const prepared = await phases.prepare({ deployment: row, stage, plan }, deps);
                await move(row, 'preparing', 'committing');
                committed = await phases.commit({ deployment: row, stage, prepared }, deps);
            } else if (row.kind === 'settings') {
                await move(row, 'preparing', 'committing');
                committed = await phases.commitSettings({ deployment: row, stage }, deps);
            } else if (row.kind === 'remove') {
                await phases.removeStage.prepareRemove({ deployment: row, stage }, deps);
                await move(row, 'preparing', 'committing');
                committed = await phases.removeStage.commitRemove({ deployment: row, stage }, deps);
            } else {
                throw new HttpError(400, 'kind_invalid', `Unknown deployment kind "${row.kind}".`);
            }
            return (await convergeRow({ ...row, ...committed }, stage)).deployment;
        } catch (err) {
            log.warn(`[stages/runner] ${row.id} (${row.kind}) failed: ${err && err.message}`);
            return compensateAndFail(row, stage, errorOf(err));
        }
    }

    /**
     * Claim and run one queued or approved deployment. Answers the final row,
     * or null when another worker had it (or it was not claimable).
     */
    async function runOne(id) {
        const before = await s.stageStore.getDeployment(id);
        if (!before || !['queued', 'approved'].includes(before.status)) return null;
        const row = await s.stageStore.claimDeployment(id, workerId, leaseMs);
        if (!row) return null;
        return withLease(row, () => execute(row, { approved: before.status === 'approved' }));
    }

    /** A reclaimed row, decided from its own status. */
    async function resume(row) {
        const stage = await stageFor(row);
        if (row.status === 'converging') {
            try {
                return (await convergeRow(row, stage)).deployment;
            } catch (err) {
                log.warn(`[stages/runner] converge of ${row.id} failed again: ${err && err.message}`);
                return null;
            }
        }
        if (await removeHasDeleted(row)) {
            // Forward, not back: finish the deletes (they are repeatable), then the stage's rows.
            try {
                const committed = await phases.removeStage.commitRemove({ deployment: row, stage }, deps);
                return (await convergeRow({ ...row, ...committed }, stage)).deployment;
            } catch (err) {
                log.warn(`[stages/runner] resumed removal ${row.id} failed: ${err && err.message}`);
                return failRemoveForward(row);
            }
        }
        return compensateAndFail(row, stage, {
            code: 'worker_lost', message: 'The worker running this deployment stopped. Nothing changed in the stage.',
        });
    }

    /** Reclaim and finish every in-flight row whose lease ran out. */
    async function resumeStale() {
        const out = [];
        for (const stale of await s.stageStore.listExpiredLeases(now())) {
            const row = await s.stageStore.reclaimExpired(stale.id, workerId, leaseMs);
            if (!row) continue;
            out.push(await withLease(row, () => resume(row)));
        }
        return out;
    }

    /** Apply decided approvals to their awaiting rows (D9 backstop). */
    function reconcile() {
        return s.stageStore.reconcileAwaitingApprovals({ getApproval });
    }

    /** One job tick: reconcile, resume, run what is claimable. Never throws. */
    async function tick() {
        const out = { reconciled: null, resumed: 0, ran: 0 };
        try { out.reconciled = await reconcile(); } catch (err) { log.warn(`[stages/runner] reconcile failed: ${err && err.message}`); }
        try { out.resumed = (await resumeStale()).length; } catch (err) { log.warn(`[stages/runner] resume failed: ${err && err.message}`); }
        try {
            for (const row of await s.stageStore.listClaimable(now())) {
                if (await runOne(row.id)) out.ran += 1;
            }
        } catch (err) {
            log.warn(`[stages/runner] run failed: ${err && err.message}`);
        }
        return out;
    }

    return { admit, kick, runOne, resumeStale, reconcile, tick, workerId };
}

let defaultRunner = null;
/** The process's runner over the real stores (the job and the routes share it). */
function getRunner() {
    if (!defaultRunner) defaultRunner = makeRunner();
    return defaultRunner;
}

module.exports = { makeRunner, getRunner, missingAcknowledgements, errorOf, LEASE_MS, HEARTBEAT_MS, ELIGIBILITY_CODES };
