// @typecheck
/**
 * Which client made this request.
 *
 * Every Bee Flow client already announces itself — the Android app has sent
 * `X-Beeflow-Client: android` on every request since it was written — and
 * until now nothing on the server read it. A search of the whole tree returned
 * zero hits. The consequence was that no number anyone held separated phone
 * from browser: not a customer looking at their own instance, not the vendor,
 * not the owner querying his own database with full access and no privacy
 * constraint at all.
 *
 * Held in AsyncLocalStorage rather than threaded through call signatures,
 * following the pattern in ./outboundProbe.js. `logUsage` is the single
 * authoritative sink for every model call in the product, so one read there
 * covers roughly forty call sites without touching any of them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS MAY AND MAY NOT BECOME.
 *
 * This is a closed enum of four values, stamped on a row that already exists.
 * It is not the thin end of an analytics wedge, and the contract is written
 * down in docs/docs/reference/telemetry.md so it can be held to:
 *
 *   MAY:     the client enum, the source enum, and the columns already on the
 *            row.
 *   MAY NOT: screen names, taps, navigation events, route paths, session
 *            durations, message content, or any per-user row leaving the
 *            customer's database.
 *
 * A self-hosted operator is the controller of their own database, so the
 * column is written on every install. Nothing is exported anywhere: the
 * aggregate rollup that can leave is separately gated behind OPS_PUSH_ENABLED
 * and is off by default.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * The closed set. An unrecognised header is `unknown`, never its own value —
 * otherwise any caller could mint a category and the column stops being an
 * enum you can GROUP BY.
 */
const CLIENTS = new Set(['web', 'android', 'api']);
const UNKNOWN = 'unknown';

const store = new AsyncLocalStorage();

/** Narrow a header value to the enum. */
function normalizeClient(value) {
    if (typeof value !== 'string') return UNKNOWN;
    const trimmed = value.trim().toLowerCase();
    return CLIENTS.has(trimmed) ? trimmed : UNKNOWN;
}

/**
 * Express middleware. Runs the rest of the request inside a context carrying
 * the client, so anything downstream — however deep, however async — can ask.
 */
function withRequestClient(req, _res, next) {
    store.run({ client: normalizeClient(req.headers['x-beeflow-client']) }, next);
}

/**
 * The client for the request in flight, or `unknown`.
 *
 * `unknown` is the honest answer for the many call sites that are NOT in a
 * request at all — the automation runner, cron jobs, swarm workers, App Studio
 * actions. That is why the phone's share must never be reported against all
 * turns: a machine-initiated turn is not a client choice and does not belong
 * in the denominator of a client question. See INTERACTIVE_SOURCES below.
 */
function currentClient() {
    return store.getStore()?.client ?? UNKNOWN;
}

/**
 * The `source` values that represent a person typing.
 *
 * The denominator for any client question. Everything else in the source enum
 * — automation runs, scheduled tasks, swarm sub-calls, title generation — is
 * the server acting on its own, and including it would silently shrink every
 * client's share by however busy the instance happens to be.
 */
const INTERACTIVE_SOURCES = [
    'direct_chat',
    'agent_chat',
    'agent_stream',
    'notebook',
    'webpage_chat',
];

module.exports = { withRequestClient, currentClient, normalizeClient, INTERACTIVE_SOURCES, CLIENTS };
