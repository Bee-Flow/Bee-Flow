/**
 * The real core/http/sseHelpers for a route test, minus the keep-alive timer.
 *
 * Route tests stub the helpers so a 10 s ping interval cannot outlive the
 * turn. With openSse that stub would also replace the head, the guarded send
 * and the client-stop wiring the route relies on, so this hands back the real
 * module with only the heartbeat switched off:
 *
 *   '../../core/http/sseHelpers': quietSse(),
 */

const real = require('../core/http/sseHelpers');

function quietSse(over = {}) {
    return {
        ...real,
        startSseHeartbeat: () => () => {},
        openSse: (res, opts = {}) => real.openSse(res, { ...opts, heartbeat: false }),
        ...over,
    };
}

module.exports = { quietSse };
