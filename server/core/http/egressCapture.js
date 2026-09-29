// @typecheck
'use strict';
/**
 * Egress capture: where did the bytes of this tool call actually go?
 *
 * Read off the connection itself, through `node:diagnostics_channel`, never
 * off a DNS answer. The old probe recorded the first address of its own
 * lookup, so a reused keep-alive connection recorded nothing, Happy Eyeballs
 * could connect somewhere else, the last host of a call won, and every client
 * with its own dispatcher (safeFetch, googleapis, Stripe, S3) was invisible.
 *
 * What is subscribed, and why each one:
 *
 *   undici:request:create       fetch (Node's own undici) AND the npm undici
 *                               package publish on the same channel names. It
 *                               runs in the caller's AsyncLocalStorage context,
 *                               so this is where a request is bound to a probe.
 *   undici:client:sendHeaders   the socket that carries the request, also on a
 *                               reused connection: `socket.remoteAddress`.
 *   undici:request:headers      the response status and the edge headers.
 *   http.client.request.created node:http / node:https (the SDKs). `.start` is
 *   http.client.request.start   the fallback for a Node without `.created`.
 *   http.client.response.finish the socket of a node:http response.
 *   http.client.request.error   the socket of a node:http request that failed.
 *   net.client.socket           raw sockets, used ONLY for the mail ports.
 *
 * THE RULES THAT KEEP THIS SAFE (each one was a finding, not a guess):
 *
 *   1. Attribution is fixed when the request is CREATED. Every later event is
 *      looked up by request in a WeakMap, never through the current context:
 *      the headers of a queued request are sent from whichever caller freed
 *      the socket, in that caller's context.
 *   2. A subscriber that throws is rethrown by diagnostics_channel as an
 *      uncaught exception, which takes the whole server down. Every
 *      subscriber is wrapped, and returns at once for a request it does not
 *      track: these fire for every model stream and telemetry export.
 *   3. The store and the "installed" flag live on a global symbol, so a test
 *      that clears the require cache does not end up with a second store the
 *      subscribers never read.
 *   4. A probe is SEALED when its call ends. Timers, SSE reconnects and batch
 *      exports that were started inside the call keep its context; they are
 *      ignored from then on. Peers on the OTLP exporter host are ignored too.
 *   5. Model calls are not egress rows (owner decision). The provider adapters
 *      run inside `outsideProbe`, which leaves the context: filtered per CALL,
 *      never per host, because OCR, Voxtral and transcription are real tools
 *      on AI hosts.
 */

const dc = require('node:diagnostics_channel');
const net = require('node:net');
const { AsyncLocalStorage } = require('node:async_hooks');
const log = require('../../telemetry/log');

const GLOBAL_KEY = Symbol.for('beeflow.egress');
const MAX_PEERS = 8;
const MAIL_PORTS = new Set([25, 465, 587, 143, 993]);
const RECENT_MAIL_TTL_MS = 10 * 60 * 1000;
const RECENT_MAIL_MAX = 200;
const EDGE_HEADERS = ['cf-ray', 'x-amz-cf-pop', 'x-served-by', 'x-vercel-id', 'fly-request-id', 'x-azure-ref', 'x-msedge-ref', 'server'];
const EDGE_SET = new Set(EDGE_HEADERS);
const EDGE_VALUE_CAP = 200;
const WARN_INTERVAL_MS = 60 * 1000;
const BASES = new Set(['socket', 'recent_socket', 'proxy', 'child_process', 'browser']);

/**
 * The process-wide state. One per process, whatever the require cache does.
 * @returns {{ store: AsyncLocalStorage<any>, installed: boolean, requests: WeakMap<object, any>,
 *   seenSockets: WeakSet<object>, untrackedHttp: WeakSet<object>,
 *   recentMail: Map<string, any>, faultHook: Function|null, lastWarnAt: number }}
 */
function shared() {
    let s = globalThis[GLOBAL_KEY];
    if (!s) {
        s = {
            store: new AsyncLocalStorage(),
            installed: false,
            requests: new WeakMap(),
            seenSockets: new WeakSet(),
            untrackedHttp: new WeakSet(),
            recentMail: new Map(),
            faultHook: null,
            lastWarnAt: 0,
        };
        Object.defineProperty(globalThis, GLOBAL_KEY, { value: s, configurable: true, writable: false, enumerable: false });
    }
    return s;
}

// ── Small pure helpers ────────────────────────────────────────────────────

/** Socket address → plain IP: no zone id, IPv4-mapped IPv6 unwrapped. */
function normaliseIp(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let ip = raw.trim();
    const zone = ip.indexOf('%');
    if (zone !== -1) ip = ip.slice(0, zone);
    if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(ip)) ip = ip.slice(7);
    return net.isIP(ip) ? ip.toLowerCase() : null;
}

function familyOf(ip) {
    const v = ip ? net.isIP(ip) : 0;
    return v === 4 || v === 6 ? v : null;
}

/** Lowercased hostname, no brackets, no trailing dot, no port. */
function normaliseHost(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let h = raw.trim().toLowerCase();
    if (h.startsWith('[')) {
        const end = h.indexOf(']');
        h = end === -1 ? h.slice(1) : h.slice(1, end);
    } else if (h.split(':').length === 2) {
        h = h.split(':')[0];
    }
    if (h.endsWith('.')) h = h.slice(0, -1);
    return h || null;
}

function urlParts(origin) {
    try {
        const u = new URL(String(origin));
        const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null);
        return { host: normaliseHost(u.hostname), port };
    } catch (_) {
        return { host: null, port: null };
    }
}

function carriesBody(method, body) {
    const m = String(method || 'GET').toUpperCase();
    if (m !== 'GET' && m !== 'HEAD') return true;
    return body !== null && body !== undefined && body !== '';
}

/** Undici's raw headers: [name, value, name, value, …] as Buffers or strings. */
function edgeFromRaw(raw) {
    if (!Array.isArray(raw)) return null;
    let edge = null;
    for (let i = 0; i + 1 < raw.length; i += 2) {
        const name = String(raw[i]).toLowerCase();
        if (!EDGE_SET.has(name)) continue;
        if (!edge) edge = Object.fromEntries(EDGE_HEADERS.map((h) => [h, null]));
        edge[name] = String(raw[i + 1]).slice(0, EDGE_VALUE_CAP);
    }
    return edge;
}

/** node:http's parsed headers: a lowercased object. */
function edgeFromObject(headers) {
    if (!headers || typeof headers !== 'object') return null;
    let edge = null;
    for (const name of EDGE_HEADERS) {
        const v = headers[name];
        if (v === undefined || v === null) continue;
        if (!edge) edge = Object.fromEntries(EDGE_HEADERS.map((h) => [h, null]));
        edge[name] = String(Array.isArray(v) ? v[0] : v).slice(0, EDGE_VALUE_CAP);
    }
    return edge;
}

// Parsed once per distinct env value: the env rarely changes, the parse runs
// for every peer of every probed call.
const _envCache = { otlpRaw: null, otlpHosts: new Set(), proxyRaw: null, proxy: null };

/** Hosts of the OTLP exporter. A batch export started inside a call is not the call's egress. */
function telemetryHosts(env = process.env) {
    const raw = [
        env.OTEL_EXPORTER_OTLP_ENDPOINT, env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
        env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    ].filter(Boolean).join('|');
    if (raw !== _envCache.otlpRaw) {
        _envCache.otlpRaw = raw;
        _envCache.otlpHosts = new Set(raw.split('|').map((u) => urlParts(u).host).filter(Boolean));
    }
    return _envCache.otlpHosts;
}

/**
 * The proxy this process would use for `targetHost`, or null.
 * @returns {{ host: string, port: number|null }|null}
 */
function proxyFor(targetHost, env = process.env) {
    const raw = [
        env.HTTPS_PROXY || env.https_proxy || '', env.HTTP_PROXY || env.http_proxy || '',
        env.NO_PROXY || env.no_proxy || '',
    ].join('|');
    if (raw !== _envCache.proxyRaw) {
        _envCache.proxyRaw = raw;
        const [httpsProxy, httpProxy, noProxy] = raw.split('|');
        const parsed = urlParts(httpsProxy || httpProxy);
        _envCache.proxy = parsed.host ? {
            host: parsed.host,
            port: parsed.port,
            noProxy: noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
        } : null;
    }
    const proxy = _envCache.proxy;
    if (!proxy) return null;
    const host = normaliseHost(targetHost) || '';
    for (const rule of proxy.noProxy) {
        if (rule === '*') return null;
        const bare = rule.replace(/^\*?\./, '').replace(/:\d+$/, '');
        if (host === bare || host.endsWith(`.${bare}`)) return null;
    }
    return { host: proxy.host, port: proxy.port };
}

/**
 * Did this socket connect to the proxy rather than to the target? Then the
 * address on it is the proxy's, and the peer says so (basis 'proxy').
 */
function isProxiedSocket({ targetHost, targetPort = null, socket, env = process.env }) {
    const proxy = proxyFor(targetHost, env);
    if (!proxy || !socket) return false;
    const target = normaliseHost(targetHost);
    const names = [socket._host, socket._parent && socket._parent._host].map(normaliseHost).filter(Boolean);
    if (names.includes(proxy.host)) return true;
    const ip = normaliseIp(socket.remoteAddress);
    if (ip && ip === proxy.host) return true;
    return !!(proxy.port && socket.remotePort === proxy.port && targetPort !== proxy.port
        && !names.includes(target));
}

// ── Probes ────────────────────────────────────────────────────────────────

function newProbe() {
    return {
        sealed: false,
        is_local: false,
        local_label: null,
        peers: [],
        pendingHttp: new Set(),
    };
}

/** The live, unsealed probe of this async context, or null. */
function liveProbe() {
    const p = shared().store.getStore();
    return p && !p.sealed ? p : null;
}

/**
 * Add (or merge into) a peer of a live probe. Deduped on host+ip, at most
 * MAX_PEERS; when full, a peer that received data evicts one that did not.
 */
function addPeer(probe, p) {
    if (!probe || probe.sealed || !p) return null;
    const ip = p.ip ? normaliseIp(p.ip) : null;
    const host = normaliseHost(p.host) || ip;
    if (!host) return null;
    if (telemetryHosts().has(host)) return null;
    const basis = BASES.has(p.basis) ? p.basis : 'socket';
    const sentBody = !!p.sentBody;
    const found = probe.peers.find((x) => x.host === host && x.ip === ip);
    if (found) {
        if (sentBody && !found.sentBody) {
            found.sentBody = true;
            found.method = p.method || found.method;
        }
        if (Number.isInteger(p.status)) found.status = p.status;
        if (p.edge) found.edge = p.edge;
        return found;
    }
    if (probe.peers.length >= MAX_PEERS) {
        const idx = sentBody ? probe.peers.findIndex((x) => !x.sentBody) : -1;
        if (idx === -1) return null;
        probe.peers.splice(idx, 1);
    }
    const peer = {
        host,
        ip,
        port: Number.isInteger(p.port) ? p.port : null,
        family: familyOf(ip),
        reused: !!p.reused,
        sentBody,
        method: p.method ? String(p.method).toUpperCase() : null,
        status: Number.isInteger(p.status) ? p.status : null,
        edge: p.edge || null,
        basis,
        at: Number.isFinite(p.at) ? p.at : Date.now(),
    };
    probe.peers.push(peer);
    return peer;
}

/** A peer from the socket that carried a tracked request. Needs a real address. */
function recordSocketPeer(rec, socket) {
    const s = shared();
    if (!socket || rec.probe.sealed) return null;
    const ip = normaliseIp(socket.remoteAddress);
    if (!ip) return null; // unix socket, or never connected: nothing left over the network
    const reused = s.seenSockets.has(socket);
    if (!reused) s.seenSockets.add(socket);
    const proxied = isProxiedSocket({ targetHost: rec.host, targetPort: rec.port, socket });
    const peer = addPeer(rec.probe, {
        host: rec.host || ip,
        ip,
        port: Number.isInteger(socket.remotePort) ? socket.remotePort : rec.port,
        reused,
        sentBody: rec.sentBody,
        method: rec.method,
        basis: proxied ? 'proxy' : 'socket',
    });
    return peer;
}

// ── Subscribers ───────────────────────────────────────────────────────────

function warnOnce(name, err) {
    const s = shared();
    const now = Date.now();
    if (now - s.lastWarnAt < WARN_INTERVAL_MS) return;
    s.lastWarnAt = now;
    log.warn(`[EgressCapture] ${name} subscriber failed; this call may lack a destination: ${err && err.message}`);
}

/** Never let a capture bug become an uncaught exception. */
function guarded(name, fn) {
    return (msg) => {
        try {
            const hook = shared().faultHook;
            if (hook) hook(name, msg);
            fn(msg);
        } catch (err) {
            warnOnce(name, err);
        }
    };
}

function onUndiciCreate({ request }) {
    const s = shared();
    const probe = s.store.getStore();
    if (!probe || probe.sealed || !request) return;
    // A CONNECT is the tunnel to a proxy; the request that follows is the call.
    if (String(request.method).toUpperCase() === 'CONNECT') return;
    const { host, port } = urlParts(request.origin);
    s.requests.set(request, {
        probe, host, port,
        method: request.method || 'GET',
        sentBody: carriesBody(request.method, request.body),
        peer: null,
    });
}

function onUndiciSendHeaders({ request, socket }) {
    const rec = shared().requests.get(request);
    if (!rec || rec.probe.sealed) return;
    rec.peer = recordSocketPeer(rec, socket);
}

function onUndiciHeaders({ request, response }) {
    const rec = shared().requests.get(request);
    if (!rec || rec.probe.sealed || !rec.peer || !response) return;
    if (Number.isInteger(response.statusCode)) rec.peer.status = response.statusCode;
    const edge = edgeFromRaw(response.headers);
    if (edge) rec.peer.edge = edge;
}

function trackHttpRequest(request) {
    const s = shared();
    if (!request || s.untrackedHttp.has(request)) return null;
    if (s.requests.has(request)) return s.requests.get(request);
    const probe = s.store.getStore();
    if (!probe || probe.sealed) {
        // Remembered so `.start`, which can run in another caller's context
        // for a queued request, cannot adopt it into that caller's probe.
        s.untrackedHttp.add(request);
        return null;
    }
    const rec = {
        probe,
        host: normaliseHost(request.host),
        port: null,
        method: request.method || 'GET',
        sentBody: carriesBody(request.method, null),
        peer: null,
    };
    s.requests.set(request, rec);
    probe.pendingHttp.add(request);
    return rec;
}

function onHttpCreated({ request }) {
    trackHttpRequest(request);
}

function onHttpStart({ request }) {
    const rec = trackHttpRequest(request);
    // A reused keep-alive socket already has its address here.
    if (rec && !rec.peer && !rec.probe.sealed && request.socket && request.socket.remoteAddress) {
        rec.peer = recordSocketPeer(rec, request.socket);
        if (rec.peer) rec.probe.pendingHttp.delete(request);
    }
}

function onHttpResponseFinish({ request, response }) {
    const rec = shared().requests.get(request);
    if (!rec || rec.probe.sealed) return;
    if (!rec.peer) rec.peer = recordSocketPeer(rec, (response && response.socket) || request.socket);
    rec.probe.pendingHttp.delete(request);
    if (!rec.peer || !response) return;
    if (Number.isInteger(response.statusCode)) rec.peer.status = response.statusCode;
    const edge = edgeFromObject(response.headers);
    if (edge) rec.peer.edge = edge;
}

function onHttpError({ request }) {
    const rec = shared().requests.get(request);
    if (!rec || rec.probe.sealed) return;
    if (!rec.peer) rec.peer = recordSocketPeer(rec, request.socket);
    rec.probe.pendingHttp.delete(request);
}

/**
 * Mail. A raw socket is only looked at while a probe is live, and only kept
 * when it lands on a mail port: a Postgres or Redis pool that grows during a
 * call is never recorded. The last address per mail host is remembered, so a
 * pooled IMAP connection reused by a later call can still name it.
 */
function onNetSocket({ socket }) {
    const probe = liveProbe();
    if (!probe || !socket || typeof socket.once !== 'function') return;
    socket.once('connect', guarded('net.connect', () => {
        if (!MAIL_PORTS.has(socket.remotePort)) return;
        const ip = normaliseIp(socket.remoteAddress);
        if (!ip) return;
        const host = normaliseHost(socket._host || socket.servername) || ip;
        rememberMailHost(host, ip, socket.remotePort);
        addPeer(probe, { host, ip, port: socket.remotePort, reused: false, sentBody: true, method: null, basis: 'socket' });
    }));
}

function rememberMailHost(host, ip, port) {
    const s = shared();
    s.recentMail.delete(host);
    s.recentMail.set(host, { ip, port, at: Date.now() });
    while (s.recentMail.size > RECENT_MAIL_MAX) s.recentMail.delete(s.recentMail.keys().next().value);
}

/** @type {Array<[string, (msg: any) => void]>} */
const SUBSCRIPTIONS = [
    ['undici:request:create', onUndiciCreate],
    ['undici:client:sendHeaders', onUndiciSendHeaders],
    ['undici:request:headers', onUndiciHeaders],
    ['http.client.request.created', onHttpCreated],
    ['http.client.request.start', onHttpStart],
    ['http.client.response.finish', onHttpResponseFinish],
    ['http.client.request.error', onHttpError],
    ['net.client.socket', onNetSocket],
];

/** Subscribe once per process. Idempotent, also across a cleared require cache. */
function install() {
    const s = shared();
    if (s.installed) return false;
    s.installed = true;
    for (const [name, fn] of SUBSCRIPTIONS) dc.subscribe(name, guarded(name, fn));
    return true;
}

// ── Sealing and the snapshot ──────────────────────────────────────────────

function freezePeer(p) {
    return Object.freeze({
        host: p.host, ip: p.ip, port: p.port, family: p.family, reused: p.reused,
        sentBody: p.sentBody, method: p.method, status: p.status,
        edge: p.edge ? Object.freeze({ ...p.edge }) : null,
        basis: p.basis, at: p.at,
    });
}

/**
 * The frozen snapshot of the contract, with the legacy single-destination
 * fields filled from the LAST peer for readers that predate `peers`.
 */
function buildSnapshot({ isLocal, localLabel, peers }) {
    const frozen = Object.freeze(peers.map(freezePeer));
    const last = frozen.length ? frozen[frozen.length - 1] : null;
    let legacy = { hostname: null, peer_ip: null, peer_ip_source: null, tls_servername: null, connect_ms: null };
    if (last) {
        legacy = {
            hostname: last.host,
            peer_ip: last.ip,
            peer_ip_source: last.ip ? 'socket' : null,
            tls_servername: last.host,
            // Not measured: undici's connect events carry no shared identity to
            // time one socket by, and a guessed number is worse than none.
            connect_ms: null,
        };
    } else if (isLocal) {
        legacy = { hostname: localLabel || 'local', peer_ip: null, peer_ip_source: 'local', tls_servername: null, connect_ms: null };
    }
    return Object.freeze({
        sealed: true,
        is_local: !!isLocal,
        local_label: localLabel || null,
        peers: frozen,
        ...legacy,
    });
}

/** Seal a live probe and return its snapshot. Later events are ignored. */
function seal(probe) {
    const s = shared();
    try {
        for (const request of probe.pendingHttp) {
            const rec = s.requests.get(request);
            // `response.finish` never fires on an abort or an error: read the
            // socket now, while the request still holds it.
            if (rec && !rec.peer && request.socket) rec.peer = recordSocketPeer(rec, request.socket);
        }
    } catch (err) {
        warnOnce('seal', err);
    }
    probe.pendingHttp.clear();
    probe.sealed = true;
    return buildSnapshot({ isLocal: probe.is_local, localLabel: probe.local_label, peers: probe.peers });
}

/** A copy of a snapshot (or of nothing) with more peers after its own. */
function withPeers(snapshot, extra) {
    const base = snapshot && Array.isArray(snapshot.peers) ? snapshot.peers : [];
    const scratch = newProbe();
    for (const p of base) addPeer(scratch, p);
    for (const p of (Array.isArray(extra) ? extra : [])) addPeer(scratch, p);
    return buildSnapshot({
        isLocal: !!(snapshot && snapshot.is_local),
        localLabel: snapshot ? snapshot.local_label : null,
        peers: scratch.peers,
    });
}

// ── The public surface (re-exported by outboundProbe.js) ──────────────────

/**
 * Run `fn` inside a fresh probe. Resolves `{ result, probe }`, where `probe`
 * is the frozen snapshot. A throw from `fn` seals the probe and rethrows.
 */
async function runWithProbe(fn) {
    install();
    const probe = newProbe();
    let result;
    try {
        result = await shared().store.run(probe, fn);
    } catch (err) {
        seal(probe);
        throw err;
    }
    return { result, probe: seal(probe) };
}

/** Like runWithProbe, but never throws: `{ ok, result, error, probe }`. */
async function runWithProbeSettled(fn) {
    install();
    const probe = newProbe();
    try {
        const result = await shared().store.run(probe, fn);
        return { ok: true, result, error: null, probe: seal(probe) };
    } catch (error) {
        return { ok: false, result: undefined, error, probe: seal(probe) };
    }
}

/**
 * Run `fn` with no probe at all: what it connects to is nobody's egress row.
 * The provider adapters' model calls run through this.
 */
function outsideProbe(fn) {
    return shared().store.exit(fn);
}

/**
 * Mark the current call as on-host. A HINT: the location is taken from the
 * peers when there are any, and from this only when nothing was seen.
 */
function markLocal(label) {
    const probe = liveProbe();
    if (!probe) return;
    probe.is_local = true;
    probe.local_label = label || 'local';
}

/**
 * A peer this process cannot see on a socket of its own: a stdio child
 * process ('child_process') or the private browser container ('browser').
 * `probe` defaults to the current one.
 */
function recordPeer(peer, probe = liveProbe()) {
    if (!peer || !BASES.has(peer.basis)) return null;
    return addPeer(probe, peer);
}

/**
 * A pooled mail connection reused by this call: the address it was opened
 * to, from the last time this process saw it (no DNS). Null when unknown or
 * older than ten minutes.
 */
function recordReusedConnection(host, probe = liveProbe()) {
    const key = normaliseHost(host);
    const hit = key ? shared().recentMail.get(key) : null;
    if (!hit || Date.now() - hit.at > RECENT_MAIL_TTL_MS) return null;
    return addPeer(probe, { host: key, ip: hit.ip, port: hit.port, reused: true, sentBody: true, method: null, basis: 'recent_socket' });
}

/** Test seam: a function run inside every subscriber (a throw must be contained). */
function setFaultHookForTests(fn) {
    shared().faultHook = typeof fn === 'function' ? fn : null;
}

install();

module.exports = {
    install,
    runWithProbe,
    runWithProbeSettled,
    outsideProbe,
    markLocal,
    liveProbe,
    recordPeer,
    recordReusedConnection,
    withPeers,
    setFaultHookForTests,
    EDGE_HEADERS,
    MAIL_PORTS,
    _internals: {
        normaliseIp, normaliseHost, edgeFromRaw, edgeFromObject, isProxiedSocket, proxyFor,
        telemetryHosts, carriesBody, shared, MAX_PEERS,
    },
};
