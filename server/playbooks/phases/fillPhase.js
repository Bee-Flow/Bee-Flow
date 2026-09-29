/**
 * Phase `fill` — run the routine once so the table has rows before the app
 * is built on it. Mirrors routes/automation/runs.js: `executeAutomation`
 * raced against a 60 s guard; the run id is captured through `onRunCreated`
 * the moment the run row exists, so a timed-out request still knows which run
 * to follow. `refreshFillPhase` turns a run's terminal status into the
 * phase's: the GET route and the background completion both call it.
 */

'use strict';

const { copyFor } = require('../copy');
const log = require('../../telemetry/log');

const RESPONSE_TIMEOUT_MS = 60_000;
const STALE_MS = 15 * 60_000;
const TERMINAL_RUN = new Set(['success', 'error', 'skipped', 'cancelled', 'failed']);

async function currentRowCount(artifacts, deps) {
    const { datatableStore } = deps;
    const id = artifacts && artifacts.datatableId;
    const scope = artifacts && artifacts.datatableScope;
    if (!id || !scope) return null;
    const table = await datatableStore.getDatatable(id, scope).catch(() => null);
    return table ? (Number(table.rowCount) || 0) : null;
}

/**
 * @param {{ playbook, phase, tableArtifacts, automationId, onRunCreated }} ctx
 * @param {object} deps  { automationStore, runner, datatableStore, timeoutMs? }
 * @returns {Promise<{ ok:false, code, error } | { ok:true, run: object|null, runId: string|null, timedOut: boolean, rowsBefore: number|null }>}
 */
async function startFillPhase({ playbook, automationId, tableArtifacts, onRunCreated }, deps) {
    const { automationStore, runner } = deps;
    const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : RESPONSE_TIMEOUT_MS;
    if (!automationId) return { ok: false, code: 'routine_missing', error: 'The automation phase produced no automation to run.' };
    const a = await automationStore.getAutomation(automationId);
    if (!a) return { ok: false, code: 'routine_missing', error: 'The automation no longer exists.' };
    if (a.userId !== playbook.userId) return { ok: false, code: 'not_owner', error: 'That automation is not yours.' };
    const kind = a.definition && a.definition.trigger && a.definition.trigger.kind;
    if (kind !== 'manual') {
        return { ok: false, code: 'trigger_not_manual', error: `The automation starts on "${kind || 'unknown'}", not by hand — a manual trigger is needed to run it once here.` };
    }
    const rowsBefore = await currentRowCount(tableArtifacts, deps);
    let runId = null;
    let timedOut = false;
    let guardTimer;
    const guard = new Promise((resolve) => { guardTimer = setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs); });
    let runError = null;
    // Cleared however this ends (a run that beat the guard, a runner that threw):
    // left armed, the timer would hold this closure for the rest of the minute.
    try {
        const runPromise = runner.executeAutomation(a, {
            triggerKind: 'manual',
            triggerPayload: {},
            mode: 'live',
            onRunCreated: (run) => {
                runId = run && run.id ? run.id : null;
                if (typeof onRunCreated === 'function') { try { onRunCreated(run); } catch { /* observer */ } }
            },
        }).catch((e) => { runError = e; log.error('[playbooks/fill] run error:', e && e.message); return null; });
        const run = await Promise.race([runPromise, guard]);
        // A rejection before the runner ever created a run row used to come back as
        // `{ ok: true, runId: null }`, which the route persisted as `running` — and
        // `refreshFillPhase` returned early on a missing id, so the stale guard
        // could never fire and the phase span for ever on "Starting the automation…".
        if (!run && !runId && !timedOut) {
            return {
                ok: false,
                code: 'run_not_started',
                error: runError ? `The automation could not be started: ${runError.message}` : copyFor(null).runNeverStarted,
            };
        }
        return { ok: true, run: run || null, runId: (run && run.id) || runId, timedOut: timedOut && !run, rowsBefore, runPromise };
    } finally {
        clearTimeout(guardTimer);
    }
}

/**
 * The phase as the run's status says it is. Returns null when nothing
 * changed (still running, not stale); else `{ status, artifacts, summary?,
 * error? }` for the caller to apply. `locale` is the playbook's — the summary
 * is read by the person, not by a model.
 */
async function refreshFillPhase(phase, deps, now = Date.now(), { locale = null } = {}) {
    const copy = copyFor(locale);
    const { automationStore } = deps;
    const art = (phase && phase.artifacts) || {};
    const startedAt = phase && phase.startedAt ? Date.parse(phase.startedAt) : NaN;
    const stale = Number.isFinite(startedAt) && now - startedAt > STALE_MS;
    // The stale guard sits ABOVE the id check on purpose: a phase whose run was
    // never created has nothing to poll, and used to be polled for ever.
    if (!art.runId) return stale ? { status: 'failed', artifacts: art, error: copy.runNeverStarted } : null;
    const run = await automationStore.getRun(art.runId).catch(() => null);
    const rowCount = await currentRowCount(art, deps);
    const rowsBefore = Number.isFinite(art.rowsBefore) ? art.rowsBefore : 0;
    const added = rowCount == null ? null : Math.max(0, rowCount - rowsBefore);
    const artifacts = { ...art, runStatus: run ? run.status : art.runStatus || null, ...(rowCount == null ? {} : { rowCount }) };
    if (run && TERMINAL_RUN.has(run.status)) {
        if (run.status === 'success') {
            return { status: 'awaiting', artifacts, summary: copy.rowsAdded(added, rowCount) };
        }
        return { status: 'failed', artifacts, error: run.error || copy.runFailed(run.status) };
    }
    if (stale) return { status: 'failed', artifacts, error: copy.runTimedOut };
    return rowCount == null || rowCount === art.rowCount ? null : { status: 'running', artifacts };
}

module.exports = { startFillPhase, refreshFillPhase, RESPONSE_TIMEOUT_MS, STALE_MS };
