'use strict';
/**
 * One outbound call inside a capture context, never throwing:
 * `{ ok, value, error, probe }`.
 *
 * For the paths that write their own ledger row around a call (http_request,
 * the code step's bridges, notification mail, the webpage bridges, the
 * builder's suggestion scan): the probe survives a failed call and reaches the
 * error row too. A tool dispatched inside it finds a probe already active, so
 * the dispatcher's chokepoint leaves the row to the caller: one row per call.
 *
 * Built on `runWithProbe` alone, looked up per call: that is the one function
 * every test double of outboundProbe provides.
 */
async function captureCall(fn) {
    const { runWithProbe } = require('./outboundProbe');
    const { result, probe } = await runWithProbe(async () => {
        try {
            return { ok: true, value: await fn(), error: null };
        } catch (error) {
            return { ok: false, value: undefined, error };
        }
    });
    return { ...result, probe: probe || null };
}

module.exports = { captureCall };
