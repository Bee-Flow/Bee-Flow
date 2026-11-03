// @typecheck
/**
 * In-process event bus for automation run lifecycle (§10 scaffolding).
 *
 * Emits structured events the SSE per-run route (`/runs/:id/stream`)
 * and the activity dashboard's org stream subscribe to. Phase 2 wires
 * the runner itself to publish; until then this module is import-safe
 * — nothing fires events yet, but consumers can already subscribe and
 * the contract is fixed.
 *
 * Events:
 *   run.started        { runId, automationId, triggerKind }
 *   run.finished       { runId, automationId, status, durationMs }
 *   run.failed         { runId, automationId, errorClass, error }
 *   step.started       { runId, stepId, stepType }
 *   step.finished      { runId, stepId, status, durationMs }
 *   step.heartbeat     { runId, stepId, at } — emitted every <30s while running
 *
 * Single Node EventEmitter is fine for now; once multi-pod fan-out is
 * needed it'll be backed by Postgres LISTEN/NOTIFY (the public API
 * stays the same — `on(event, handler)`).
 */

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(200); // SSE clients add up; raise the cap

/**
 * @param {string | symbol} type
 */
function emitRunEvent(type, payload) {
    bus.emit(type, { type, at: new Date().toISOString(), ...payload });
}

/**
 * @param {string} type
 */
function onRunEvent(type, handler) {
    bus.on(type, handler);
    return () => bus.off(type, handler);
}

function onAny(handler) {
    /**
     * @param {string} _type
     */
    const wrap = (_type) => (payload) => handler(payload);
    const types = ['run.started', 'run.finished', 'run.failed', 'step.started', 'step.finished', 'step.heartbeat'];
    const wrappers = types.map(t => {
        const w = wrap(t);
        bus.on(t, w);
        return /** @type {[string, (payload: any) => any]} */ ([t, w]);
    });
    return () => { for (const [t, w] of wrappers) bus.off(t, w); };
}

/**
 * The end of a run that a PERSON closed outside the runner: an approval
 * withdrawn or rejected, a form wait cancelled, a paused leg handed to the leg
 * that continues it. The runner's own end events come from its lifecycle
 * emitter (runHeartbeat.makeLifecycleEmitter); this is the same shape for the
 * writes that bypass it, so a list that refreshes on events does not keep a
 * closed run "waiting" (run-watch F10).
 *
 * Same rules as the lifecycle emitter: nothing for a dry run, the journey's
 * rootRunId on every event, and no data keys for a run on its starter's own
 * connections (the stream goes to the owner). Never throws.
 *
 * @param {{ id: string, automationId?: string|null, userId?: string|null, startedByUserId?: string|null,
 *   rootRunId?: string|null, mode?: string|null, connectionsMode?: string|null } | null | undefined} run
 * @param {{ status: string, errorClass?: string|null, error?: string|null, summary?: string|null, continuedBy?: string|null }} end
 */
function emitRunClosed(run, end) {
    if (!run?.id || run.mode === 'dry_run') return;
    // A run on its starter's own connections streams no data (see above).
    const shown = run.connectionsMode === 'caller' ? {} : { error: end.error, summary: end.summary };
    const optional = { errorClass: end.errorClass, continuedBy: end.continuedBy, ...shown };
    const payload = {
        runId: run.id,
        automationId: run.automationId || null,
        userId: run.userId || null,
        startedByUserId: run.startedByUserId || null,
        rootRunId: run.rootRunId || run.id,
        status: end.status,
        ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v)),
    };
    try {
        emitRunEvent(end.status === 'error' ? 'run.failed' : 'run.finished', payload);
    } catch (err) {
        require('../utils/bestEffort').bestEffort('core/runEventBus:emitRunClosed', err);
    }
}

module.exports = { emitRunEvent, emitRunClosed, onRunEvent, onAny };

/**
 * What a handler receives: the emitted payload plus `type` and `at`.
 * @typedef {{ type: string, at: string, runId?: string, automationId?: string, userId?: string, triggerKind?: string,
 *   stepId?: string, stepType?: string, status?: string, durationMs?: number, errorClass?: string,
 *   error?: string }} RunEvent
 */
