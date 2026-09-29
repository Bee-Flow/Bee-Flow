// @typecheck
/**
 * Outbound probe: the destination of a tool call, as seen on its connections.
 *
 * `runWithProbe(fn)` runs `fn` in a fresh capture context and resolves
 * `{ result, probe }`. The probe is a FROZEN snapshot, sealed when `fn`
 * settles: every connection the call made (host, the socket's remote address,
 * port, whether it carried a body, the response status and the edge headers)
 * is in `probe.peers`; the older single-destination fields (`hostname`,
 * `peer_ip`, `peer_ip_source`, `tls_servername`, `connect_ms`) repeat the last
 * peer for readers that predate `peers`.
 *
 * The capture itself lives in ./egressCapture.js (diagnostics_channel
 * subscribers). It sees Node's fetch, every npm undici dispatcher (safeFetch
 * included) and node:http(s) clients, with no fetch shim and no custom Agent:
 * tools get Node's own fetch. Requiring this module installs the subscribers
 * (idempotent); the chat stream and the automation engine do that at load.
 *
 * NEVER fires unprompted. No cron, no health checks, no DNS lookup: a peer is
 * only ever a connection a real call made. A call with no peer is recorded as
 * having no known destination rather than guessed after the fact.
 */

const capture = require('./egressCapture');

capture.install();

/** The live probe of this async context (null outside one, or once sealed). */
function currentProbe() {
    return capture.liveProbe();
}

module.exports = {
    runWithProbe: capture.runWithProbe,
    runWithProbeSettled: capture.runWithProbeSettled,
    outsideProbe: capture.outsideProbe,
    currentProbe,
    markLocal: capture.markLocal,
    recordPeer: capture.recordPeer,
    recordReusedConnection: capture.recordReusedConnection,
    withPeers: capture.withPeers,
};
