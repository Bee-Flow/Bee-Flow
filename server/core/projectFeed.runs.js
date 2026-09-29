/**
 * Automation runs, in the project feed.
 *
 * ── Why a bridge rather than a second bus ───────────────────────────────────
 *
 * runEventBus is a bare in-process EventEmitter with no cross-replica story:
 * an SSE client attached to pod A never hears about a run that executed on
 * pod B. projectEventBus already solved exactly that half — Postgres assigns
 * the order, Redis rings the doorbell, and a client that drops reconnects by
 * cursor and misses nothing. So automation runs reach a project by being
 * re-emitted through the project feed, and inherit all of it for free.
 *
 * ── The naming trap ─────────────────────────────────────────────────────────
 *
 * The project feed ALREADY carries `run.started` / `run.finished` — for CHAT
 * runs, keyed on a conversation id, driving the per-thread "answering…"
 * indicator in ProjectDetailPage. Re-using those names would light up a
 * spinner on a conversation that is not running. Automation runs therefore get
 * their own `automation.run.*` kinds, and the mapping below is the only place
 * that is decided.
 *
 * ── One lookup per run, not three ───────────────────────────────────────────
 *
 * Only `run.started` resolves the automation's project; the id and title are
 * remembered against the run and consumed by whichever terminal event arrives.
 * A terminal event with no remembered context (a pod that restarted mid-run)
 * falls back to the lookup rather than dropping the event. The map is bounded
 * — a run that never terminates must not leak — and eviction only costs a
 * lookup, never correctness.
 *
 * Step events are deliberately NOT bridged: a project feed is a place to see
 * that work happened, not a per-step trace, and the trace already has its own
 * SSE route at /runs/:id/stream.
 *
 * Fire-and-forget throughout, like every other feed producer: a run that
 * succeeded has not failed because the sidebar did not blink.
 */

const { emitProjectEvent } = require('./projectFeed');
const log = require('../telemetry/log');

// A Map, not an object literal: a plain-object lookup resolves up the prototype
// chain, so an event typed 'constructor' would match truthily and emit garbage.
const RUN_KINDS = new Map([
    ['run.started', 'automation.run.started'],
    ['run.finished', 'automation.run.finished'],
    ['run.failed', 'automation.run.failed'],
]);

// runId -> { projectId, title }
const _runContext = new Map();
const MAX_TRACKED_RUNS = 5000;

let _started = false;
let _detach = null;

function _remember(runId, ctx) {
    if (!runId) return;
    // Insertion-ordered, so the oldest key is the first one. Evicting costs a
    // lookup on that run's terminal event and nothing else.
    if (_runContext.size >= MAX_TRACKED_RUNS) {
        const oldest = _runContext.keys().next().value;
        if (oldest !== undefined) _runContext.delete(oldest);
    }
    _runContext.set(runId, ctx);
}

async function _lookup(automationId) {
    if (!automationId) return { projectId: null, title: '' };
    try {
        const automation = await require('../stores/automationStore').getAutomation(automationId);
        return { projectId: automation?.projectId || null, title: automation?.title || '' };
    } catch (err) {
        log.warn('[ProjectFeed] could not resolve a run\'s project:', err.message);
        return { projectId: null, title: '' };
    }
}

async function _contextFor(type, runId, automationId) {
    if (type !== 'run.started') {
        const remembered = runId ? _runContext.get(runId) : null;
        if (remembered) {
            _runContext.delete(runId);      // terminal event — stop tracking
            return remembered;
        }
        return _lookup(automationId);       // restarted mid-run
    }
    const ctx = await _lookup(automationId);
    // Remembered even when there is no project. A standalone automation — most
    // of them — then costs one lookup for the whole run rather than one per
    // event, and its terminal event returns without touching the store at all.
    _remember(runId, ctx);
    return ctx;
}

/**
 * The payload a project member gets to see.
 *
 * `errorClass` travels but the raw `error` string does NOT: a failure message
 * can quote an integration's response, and the project feed is read by every
 * member of the project rather than by the automation's owner alone. The class
 * is enough to render "this failed, and how"; the detail stays on the run.
 */
function _payload(event, ctx) {
    return {
        runId: event.runId || null,
        automationId: event.automationId || null,
        automationTitle: ctx.title || '',
        triggerKind: event.triggerKind || null,
        status: event.status || null,
        durationMs: event.durationMs ?? null,
        errorClass: event.errorClass || null,
    };
}

async function _handle(event) {
    const kind = RUN_KINDS.get(event?.type);
    if (!kind) return;                      // step.* and anything new: not ours

    const ctx = await _contextFor(event.type, event.runId, event.automationId);
    if (!ctx.projectId) return;             // a standalone automation, as most are

    await emitProjectEvent(ctx.projectId, {
        kind,
        actorId: null,                      // the runner acted, not a person
        targetType: 'automation',
        targetId: event.automationId || null,
        payload: _payload(event, ctx),
    }, { label: 'ProjectFeed' });
}

function start() {
    if (_started) return;
    _started = true;
    const { onAny } = require('./runEventBus');
    // The bus is synchronous and does not await handlers, so an async handler
    // that rejected would surface as an unhandled rejection. Swallow here.
    _detach = onAny((event) => {
        _handle(event).catch(err =>
            log.warn('[ProjectFeed] run bridge failed:', err.message));
    });
}

function stop() {
    if (_detach) _detach();
    _detach = null;
    _started = false;
    _runContext.clear();
}

module.exports = { start, stop, _test: { _handle, _runContext, MAX_TRACKED_RUNS } };
