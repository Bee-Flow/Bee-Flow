/**
 * The support SSE bus.
 *
 * Module-level state with exactly one instance: the staff inbox holds an
 * EventSource on /api/support/stream, and anything that changes a thread emits
 * here so the open inbox refreshes without a poll.
 *
 * WHY IT LIVES HERE AND NOT IN routes/. Background services need to emit —
 * the SLA enforcer, the mailbox sync engines, the issue sync poller — and a
 * service requiring a route module is an upward edge `layering.test.js` counts
 * as debt. The bus is not an HTTP concern; the endpoint that streams it is.
 * `routes/support/shared` re-exports this instance, so every existing caller
 * keeps working and the SSE endpoint is unchanged.
 */

const { EventEmitter } = require('events');

const supportEvents = new EventEmitter();
// Each connected staff browser adds a listener. The cap is a smoke alarm, not
// a limit anyone should hit: see _logListenerPressure in routes/support/shared.
supportEvents.setMaxListeners(50);

/** Emit one event. Never throws — a broken listener must not fail a request. */
function emit(event, payload) {
    try {
        supportEvents.emit('event', { event, data: payload });
    } catch (_) { /* a listener blew up; the caller's work still stands */ }
}

module.exports = { supportEvents, emit };
