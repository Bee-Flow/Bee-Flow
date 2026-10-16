/**
 * The declarative http_request step: build the request from the step and the
 * run, inject a stored credential, guard what leaves (./outboundGuard.js),
 * answer from the response cache when the step asks for it (./httpCache.js),
 * and otherwise send it, log it and guard the reply.
 *
 * Outbound HTTP/webhook call step. `blockPrivateTargets` (default true) is an
 * explicit, OPTIONAL per-step security toggle — not mandatory, per product
 * decision — that routes through utils/ssrfGuard's safeFetch (literal-hostname
 * screen + DNS-rebinding-safe validated lookup + a connector that re-screens
 * every redirect hop) instead of a bare fetch. Turning it off is a deliberate
 * escape hatch for automations that need to reach an internal/private endpoint
 * (e.g. a self-hosted user's own LAN service) — the inspector surfaces a clear
 * warning when it's disabled.
 *
 * Dry-run follows the same reads-live/writes-simulated convention as
 * execIntegrationAction's sideEffect gate: GET/HEAD execute for real so the
 * builder preview shows the actual response shape; POST/PUT/PATCH/DELETE are
 * synthesized so a preview can never cause a real external side effect.
 */

'use strict';

const { interpolateTemplate, interpolateJsonBody } = require('../automationModel/bind');
const { withStepQuery, parseStepUrl, shieldPart, joinShieldedUrl } = require('./httpQuery');
const { safeFetch, isPrivateAddressError } = require('../../utils/ssrfGuard');
const { isPrivateHost, guardOutbound } = require('./outboundGuard');
// Feature C — http_request credential injection (see httpAuth.js).
const { MASK_VALUES, resolveHttpAuthHeaders, evictToken } = require('./httpAuth');
// "Ask this web service only once" — every rule about reusing an http_request
// answer lives there, so this file gains call sites and no policy.
const httpCache = require('./httpCache');
const { serveCachedHttp, finishHttpResponse } = require('./httpResponse');
const { fetchFollowingSameHost } = require('./sameHostFetch');
const { HTTP_RESPONSE_CAP, readBodyBounded } = require('../http/httpResponseLimits');
const safety = require('./safety');
// Each outbound call runs in its own capture context (core/http/captureCall.js).
const { captureCall: captured } = require('../http/captureCall');

// 1MB response cap — shared with codeSandbox's defaultFetchHttp bridge via
// core/http/httpResponseLimits.js, so both outbound-HTTP surfaces (code step
// + this declarative step) enforce the exact same ceiling from one constant.
// BFSF-436: unlike the code step's bridge, THIS surface fails the step rather
// than silently returning a clipped body under `success` — see the throw in
// dispatchHttp below.
const HTTP_REQUEST_RESPONSE_CAP = HTTP_RESPONSE_CAP;
const HTTP_REQUEST_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** URL, method, headers and body, interpolated from the run. */
function buildHttpRequest(step, runState) {
    // A request carries DATA, not prose: lists stay JSON here (listAs 'json').
    const asData = { listAs: 'json' };
    const url = withStepQuery(interpolateTemplate(step.url || '', runState, { ...asData, field: 'url' }), step.query, runState);
    const method = (step.method || 'GET').toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(step.headers || {})) {
        headers[k] = interpolateTemplate(typeof v === 'string' ? v : '', runState, { ...asData, field: `headers.${k}` });
    }
    const isWrite = HTTP_REQUEST_WRITE_METHODS.has(method);
    // A JSON body stays JSON whatever the mapped values hold (bind.js
    // interpolateJsonBody); a form or text body keeps the plain templating.
    const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    const body = isWrite && step.body ? interpolateJsonBody(step.body, runState, { contentType, field: 'body' }) : undefined;
    // Feature C — optional saved-credential reference. Absent/null auth keeps
    // the pre-existing path byte-for-byte (no store call, no decryption).
    const authConnectionId = (step.auth && typeof step.auth === 'object'
        && typeof step.auth.connectionId === 'string' && step.auth.connectionId)
        ? step.auth.connectionId : null;
    return { url, method, headers, isWrite, body, authConnectionId };
}

/** The shape every synthesized dry-run answer of this step has. */
function dryRunHttpOutput(extra = {}) {
    return { status: 200, ok: true, headers: {}, body: '', data: null, _dryRun: true, ...extra };
}

/**
 * Put a stored credential's headers on the request (they win over a manual
 * header of the same name, case-insensitively — validate.js warns about the
 * conflict) and register its mask needles. Returns the injected header names
 * and the credential's IDENTITY for the response cache — never its value (see
 * httpAuth.resolveHttpAuthHeaders and httpCache.canonicalHeaders).
 */
async function injectCredential(step, ctx, runState, req, { parsedUrl, blockPrivateTargets }) {
    const authInjectedHeaders = new Set();
    if (!req.authConnectionId) return { authInjectedHeaders, credentialFingerprint: null, credentialGrantId: null };
    const auth = await resolveHttpAuthHeaders({ connectionId: req.authConnectionId, blockPrivateTargets, auth: step.auth, url: parsedUrl.href }, ctx);
    for (const [name, value] of Object.entries(auth.headers)) {
        authInjectedHeaders.add(name.toLowerCase());
        for (const k of Object.keys(req.headers)) {
            if (k.toLowerCase() === name.toLowerCase()) delete req.headers[k];
        }
        req.headers[name] = value;
    }
    // Register mask needles BEFORE the fetch so even a thrown fetch error
    // recorded via recordRunStep masks the header value if it appears in
    // a message.
    (runState[MASK_VALUES] ||= []).push(...auth.maskValues);
    return { authInjectedHeaders, credentialFingerprint: auth.fingerprint || null, credentialGrantId: auth.grantId || null };
}

/**
 * ── Safety: the URL, headers and body are all interpolated from runState, so
 * this step can post an org's personal data to any address. It used to do that
 * completely unscanned and unlogged. Credential headers injected above are
 * excluded — they are secrets, and masking them would break the request rather
 * than protect anyone.
 */
async function guardHttpRequest(step, ctx, mode, req, { parsedUrl, authInjectedHeaders }) {
    const destination = isPrivateHost(parsedUrl.hostname) ? 'internal' : 'external';
    const httpMeta = {
        integration: 'http_request',
        label: parsedUrl.hostname,
        server: parsedUrl.origin,
        direction: req.isWrite ? 'outbound' : 'both',
        dataCategories: 'auto_detected',
        isLocal: destination === 'internal',
    };
    const guardableHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (!authInjectedHeaders.has(k.toLowerCase())) guardableHeaders[k] = v;
    }
    const guarded = await guardOutbound(step, ctx, mode, {
        toolName: 'http_request',
        payload: { url: shieldPart(req.url), body: req.body, headers: guardableHeaders },
        destination,
        integMeta: httpMeta,
    });
    return { guarded, httpMeta, destination };
}

/** The live call, sent AND read inside its own capture context. */
async function sendHttp({ fetchImpl, sendUrl, method, headers, sendBody, signal, followSameHostOnly }) {
    // Sent AND read inside the capture context: the peer (the address the
    // socket really reached, redirects included) comes from this call.
    return captured(async () => {
        // A stored credential must never follow a redirect to another
        // host (the allowed-hosts binding is checked on the first URL only,
        // and a custom auth header survives a cross-origin hop): follow
        // same-host hops by hand and refuse the rest.
        const r = followSameHostOnly
            ? await fetchFollowingSameHost(fetchImpl, sendUrl, { method, headers, body: sendBody, signal })
            : await fetchImpl(sendUrl, { method, headers, body: sendBody, signal });
        const bounded = await readBodyBounded(r, { charCap: HTTP_REQUEST_RESPONSE_CAP, stopOnOversizeHeader: true });
        return { resp: r, text: bounded.text, bodyTruncated: bounded.truncated };
    });
}

/** Send, log and finish the live call; every failure is logged once and reworded. */
async function dispatchHttp(step, ctx, runState, mode, call) {
    const { req, sendUrl, sendBody, blockPrivateTargets, authInjectedHeaders, cache, guarded, httpMeta } = call;
    const { method, headers, authConnectionId } = req;
    // nosemgrep: ajinabraham.njsscan.eval.eval_node.eval_nodejs -- setTimeout gets a function; the step value is only its numeric delay
    const timeoutMs = typeof step.timeoutMs === 'number' ? step.timeoutMs : 10_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const httpT0 = Date.now();
    let httpProbe = null;
    try {
        const sent = await sendHttp({
            fetchImpl: blockPrivateTargets ? safeFetch : fetch,
            sendUrl, method, headers, sendBody, signal: ac.signal,
            followSameHostOnly: authInjectedHeaders.size > 0,
        });
        httpProbe = sent.probe;
        if (!sent.ok) throw sent.error;
        const { resp, text, bodyTruncated } = sent.value;
        if (authConnectionId && resp.status === 401) {
            // Target rejected the credential: drop any cached oauth2_cc token
            // so a retry refetches a fresh one. Deliberately NOT flagging the
            // connection needs_reauth — a target-API 401 is indistinguishable
            // from endpoint-side authorization rules.
            try { evictToken(authConnectionId); } catch { /* best effort */ }
        }
        // BFSF-436 — FAIL LOUDLY rather than silently returning a clipped,
        // invalid-JSON body under an ordinary `success`. This is why the
        // check sits HERE: before the success logEgress call below (so a
        // truncated call is never logged as a successful transfer) and before
        // httpCache.store (so it is never cached — httpCache.storability
        // already refuses any `out.truncated` response, but throwing here
        // means `store` is never even reached, which is a stronger guarantee
        // than relying on that refusal).
        //
        // The message deliberately carries NO "http_request: " prefix: this
        // throw falls into the catch block below like any other failure on
        // this call, which is what actually egress-logs it (one row, not
        // two) and is what adds that exact prefix via its generic
        // `http_request: ${e.message}` fallback.
        if (bodyTruncated || text.length > HTTP_REQUEST_RESPONSE_CAP) {
            throw new Error('response body exceeded the 1 MiB limit and was clipped mid-document — this call cannot be completed safely. Reduce the response size (pagination, a narrower query) or contact support if you need a higher limit.');
        }
        await safety.logEgress({
            toolName: 'http_request', toolArgs: { url: sendUrl, method },
            result: { status: resp.status }, probe: httpProbe, policy: guarded.policy,
            auditBase: guarded.auditBase, mode, integMeta: httpMeta,
            durationMs: Date.now() - httpT0,
        });
        return await finishHttpResponse(step, ctx, runState, mode, { resp, text, cache, guarded });
    } catch (e) {
        await safety.logEgress({
            toolName: 'http_request', toolArgs: { url: sendUrl, method }, error: e,
            probe: httpProbe, policy: guarded.policy, auditBase: guarded.auditBase, mode,
            integMeta: httpMeta, durationMs: Date.now() - httpT0,
        });
        if (e && e.guardrailBlocked) throw e;
        if (blockPrivateTargets && isPrivateAddressError(e)) {
            throw new Error('http_request: refused — target resolves to a private/internal address. Turn off "Block requests to private/internal addresses" in this step\'s settings if you specifically need to reach it.');
        }
        if (e.name === 'AbortError') throw new Error(`http_request: timed out after ${timeoutMs}ms.`);
        throw new Error(`http_request: ${e.message || String(e)}`);
    } finally {
        clearTimeout(timer);
    }
}

async function execHttpRequest(step, ctx, runState, mode) {
    const req = buildHttpRequest(step, runState);

    // Dry-run: writes stay synthesized as before; with a credential attached,
    // reads are synthesized too — a dry-run must NEVER decrypt or transmit a
    // stored credential.
    if (mode === 'dry_run' && (req.isWrite || req.authConnectionId)) {
        return { output: dryRunHttpOutput(), dryRunSynthesised: true };
    }

    const parsedUrl = parseStepUrl(req.url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`http_request: unsupported URL scheme "${parsedUrl.protocol}" — only http/https are allowed.`);
    }

    const blockPrivateTargets = step.blockPrivateTargets !== false; // default true
    const credential = await injectCredential(step, ctx, runState, req, { parsedUrl, blockPrivateTargets });
    const { authInjectedHeaders } = credential;
    const { guarded, httpMeta, destination } = await guardHttpRequest(step, ctx, mode, req, { parsedUrl, authInjectedHeaders });
    if (mode === 'dry_run' && guarded.guarded && guarded.guarded.wouldBlock) {
        // A `block` policy THROWS in live mode but, in dry-run, hands the
        // payload back UNTRANSFORMED with wouldBlock — and this path used to
        // ignore that flag and dispatch, so the exact request that is blocked in
        // production was really sent during a preview. Every other outbound path
        // (execIntegrationAction, execAiStep, execParseJson) synthesizes here;
        // this one now does too, in the same shape so the inspector renders it
        // identically to the write/credential dry-run above.
        return {
            output: dryRunHttpOutput({ _guardrailWouldBlock: guarded.guarded.categories || [] }),
            dryRunSynthesised: true,
            dryRunFallback: 'guardrail_block',
        };
    }
    const sendUrl = joinShieldedUrl(req.url, guarded.payload.url);
    const sendBody = req.body === undefined ? undefined : guarded.payload.body;
    for (const [k, v] of Object.entries(guarded.payload.headers || {})) {
        if (typeof v === 'string') req.headers[k] = v;
    }

    // ── "Ask this web service only once" (step.askOnce; absent = off) ──
    //
    // PLACEMENT IS THE SECURITY PROPERTY. This sits AFTER resolveHttpAuthHeaders
    // — which is this step's live authorization gate, re-reading the connection
    // row and re-evaluating the grant join for revocation and expiry on every
    // run — and AFTER guardOutbound, so the key is built from what ACTUALLY
    // travels. Hoisting it above either would keep a revoked lend flowing for a
    // whole TTL with no ledger row. All the policy lives in httpCache.js; this
    // file gains call sites, not rules.
    const cache = await httpCache.lookup({
        step, ctx, mode, method: req.method, blockPrivateTargets,
        policy: guarded.policy, destination, parsedUrl,
        sendUrl, sendBody, headers: req.headers,
        authInjectedHeaders, credentialFingerprint: credential.credentialFingerprint,
        connectionId: req.authConnectionId, grantId: credential.credentialGrantId,
    });
    if (cache && cache.served) return serveCachedHttp(step, ctx, mode, cache, { sendUrl, method: req.method, guarded, httpMeta });
    // A conditional GET is a REAL call, so it logs a real egress row below. It
    // is the one mechanism here that cannot serve a stale answer: the origin
    // decides, with a 304 or a fresh 200.
    if (cache && cache.revalidate) Object.assign(req.headers, cache.revalidate.headers);

    return dispatchHttp(step, ctx, runState, mode, {
        req, sendUrl, sendBody, blockPrivateTargets, authInjectedHeaders, cache, guarded, httpMeta,
    });
}

module.exports = { execHttpRequest };
