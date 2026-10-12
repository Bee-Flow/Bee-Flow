/**
 * CONVERGE, the third phase of a release deployment (design 6.4): the side
 * effects after the commit made the release live. Idempotent and retriable;
 * the release is live whatever happens here, so a failure is a warning
 * (`succeeded_with_warnings`), never a rollback.
 *
 * What it does is read from the deployment's own journal (the commit's
 * `flip`, `retire` and `knowledge` rows, written inside the commit
 * transaction), so a converge resumed by another worker after a crash does
 * exactly what the first one would have:
 *
 *   automation flipped   goLive.convergeAfterPublish: trigger re-sync against the
 *                     previous live copy, form pages, the answers table, the
 *                     datatable usage index and knowledge-base sources
 *                     (saveSyncs: the deploy wrote the working copy without
 *                     the PATCH route), compliance wake
 *   automation retired   its remote and local event subscriptions go
 *   page flipped      the `current/` slots are written from the pinned version
 *                     (which also reindexes the page's table usage)
 *   app flipped       the app's automation-usage index is rebuilt
 *   tables            the scope's engine cache is dropped
 *   knowledge         the target base's version is bumped (search caches)
 *   always            a project feed event `deployment.succeeded`
 *
 * A failed task is tried again, up to MAX_ATTEMPTS in all, with a growing
 * pause (inside the lease, which the runner keeps alive). What still fails is
 * reported by task and ref only, never with content.
 */

'use strict';

const log = require('../../telemetry/log');
const { storesOf } = require('./prepare');

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = Object.freeze([0, 1000, 2000, 4000, 8000]);
const PAGE_SLOTS = Object.freeze(['html', 'css', 'js']);

const defaultSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });

/** The previous live definition of a flipped automation, from the version the journal recorded. */
async function previousLiveOf(s, steps, automationId) {
    const write = steps.find(st => st.phase === 'prepare' && st.action === 'write_working' && st.entityId === automationId);
    const version = write && write.before ? write.before.liveVersion : null;
    if (!Number.isInteger(version)) return null;
    try {
        const defs = await s.automationStore.getVersionDefinitions([{ automationId, version }]);
        return defs.get(`${automationId}@${version}`) || null;
    } catch {
        return null;
    }
}

/** The converge tasks of one deployment, each `{ name, ref, run }`; `run` throws on failure. */
async function tasksFor({ deployment, stage }, deps) {
    const s = storesOf(deps);
    const goLive = dep(deps, 'goLive', () => require('../../automation/goLive'));
    const steps = await s.stageStore.listSteps(deployment.id);
    const commitSteps = steps.filter(st => st.phase === 'commit');
    const managedWrite = { deploymentId: deployment.id };
    const tasks = [];

    for (const st of commitSteps.filter(x => x.action === 'flip')) {
        if (st.kind === 'automation') {
            tasks.push({ name: 'automation', ref: st.ref, run: async () => {
                const a = await s.automationStore.getAutomation(st.entityId);
                if (!a || a.kind !== 'automation') return;
                const out = await goLive.convergeAfterPublish({
                    automation: a, definition: a.liveDefinition || a.definition,
                    previousLive: await previousLiveOf(s, steps, st.entityId), isActive: a.isActive === true,
                    ownerId: stage.runAsUserId, organizationId: stage.organizationId || null,
                    reason: 'deployment', saveSyncs: true, deps: deps.goLiveDeps || {},
                });
                if (out && Array.isArray(out.warnings) && out.warnings.length) {
                    throw Object.assign(new Error('automation side effects incomplete'), { steps: out.warnings.map(w => w.step) });
                }
            } });
        } else if (st.kind === 'webpage') {
            tasks.push({ name: 'page_files', ref: st.ref, run: async () => {
                const page = await s.webpageStore.getWebpageRaw(st.entityId);
                if (!page || !page.publishedVersionId) return;
                for (const slot of PAGE_SLOTS) {
                    await s.webpageStore.restoreSlotFromVersion(stage.runAsUserId, st.entityId, page.publishedVersionId, slot, { managedWrite });
                }
            } });
        } else if (st.kind === 'app') {
            tasks.push({ name: 'app_usage', ref: st.ref, run: async () => {
                const sync = dep(deps, 'reconcileAppUsage', () => require('../../appStudio/automationUsageSync').reconcileAppAutomationUsageDetached);
                await sync(st.entityId);
            } });
        }
    }
    for (const st of commitSteps.filter(x => x.action === 'retire' && x.kind === 'automation')) {
        tasks.push({ name: 'automation_off', ref: st.ref, run: async () => {
            const revoke = dep(deps, 'revokeRemoteSubscriptions', () => require('../../automation/subscriptionSync').revokeRemoteSubscriptions);
            await revoke(st.entityId, stage.runAsUserId);
            await s.automationStore.deleteSubscriptionsForAutomation(st.entityId);
        } });
    }
    if (commitSteps.some(x => x.action === 'schema' || x.action === 'reference_rows') && stage.organizationId) {
        tasks.push({ name: 'table_cache', ref: null, run: async () => {
            s.datatableDbStore.invalidate(s.datatableDbStore.scopeKey(s.datatableStore.orgScope(stage.organizationId)));
        } });
    }
    for (const st of commitSteps.filter(x => x.action === 'knowledge')) {
        tasks.push({ name: 'kb_version', ref: st.ref, run: () => s.kbStore.bumpKBVersion(st.entityId) });
    }
    return tasks;
}

async function feedEvent({ deployment, stage }, report, deps) {
    const emit = dep(deps, 'emitProjectEvent', () => require('../../core/projectFeed').emitProjectEvent);
    const event = {
        kind: 'deployment.succeeded', actorId: deployment.requestedBy || null,
        targetType: 'deployment', targetId: deployment.id,
        payload: {
            deploymentId: deployment.id, kind: deployment.kind, stage: stage.stage,
            releaseSeq: deployment.releaseSeq ?? null, warnings: report.warnings.length,
        },
    };
    for (const projectId of [stage.projectId, stage.solutionId]) {
        try { await emit(projectId, event, { label: 'Solution stages' }); } catch (err) {
            log.warn(`[stages/converge] feed event for ${deployment.id} failed: ${err && err.message}`);
        }
    }
}

/**
 * Run the side effects of a committed deployment and close it: `succeeded`,
 * or `succeeded_with_warnings` when a task still failed after MAX_ATTEMPTS.
 *
 * @param {{ deployment: object, stage: object }} input  the row is `converging`
 * @param {object} [deps]  stores (prepare.storesOf), `goLive`, `goLiveDeps`, `reconcileAppUsage`,
 *   `revokeRemoteSubscriptions`, `emitProjectEvent`, `sleep(ms)`, `maxAttempts`, `tasks` (a test's own list)
 * @returns {Promise<{ deployment: object|null, report: { warnings: object[], attempts: number } }>}
 */
async function converge({ deployment, stage }, deps = {}) {
    const s = storesOf(deps);
    const sleep = deps.sleep || defaultSleep;
    const maxAttempts = Number.isInteger(deps.maxAttempts) && deps.maxAttempts > 0 ? deps.maxAttempts : MAX_ATTEMPTS;
    let pending = Array.isArray(deps.tasks) ? deps.tasks : await tasksFor({ deployment, stage }, deps);
    let attempts = 0;
    const failures = new Map();
    while (pending.length && attempts < maxAttempts) {
        if (attempts > 0) await sleep(BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]);
        attempts += 1;
        const failed = [];
        for (const task of pending) {
            try {
                await task.run();
                failures.delete(task);
            } catch (err) {
                failed.push(task);
                failures.set(task, err && err.code ? String(err.code) : 'failed');
                log.warn(`[stages/converge] ${deployment.id} ${task.name}${task.ref ? ` ${task.ref}` : ''} failed (attempt ${attempts}): ${err && err.message}`);
            }
        }
        pending = failed;
    }
    const report = {
        warnings: pending.map(t => ({ task: t.name, ref: t.ref || null, code: failures.get(t) || 'failed' })),
        attempts,
    };
    await feedEvent({ deployment, stage }, report, deps);
    const to = report.warnings.length ? 'succeeded_with_warnings' : 'succeeded';
    const row = await s.stageStore.transitionDeployment(deployment.id, ['converging'], to, { report });
    return { deployment: row, report };
}

module.exports = { converge, tasksFor, MAX_ATTEMPTS, BACKOFF_MS };
