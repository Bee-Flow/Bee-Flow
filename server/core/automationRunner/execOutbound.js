/**
 * Guarded outbound steps that are not catalog tools (extracted verbatim from
 * engine.js): notification delivery, the declarative http_request step and
 * the sandboxed code step with its two egress bridges, plus the shared
 * guardOutbound helper they all route through.
 */

const notificationStore = require('../../stores/notificationStore');
const { resolveInputs, interpolateTemplate } = require('../../automation/bind');
const { safeFetch, isPrivateAddressError } = require('../../utils/ssrfGuard');
const sandbox = require('../../automation/codeSandbox');
const { prepareCodeRun } = require('./codeStepGuard');
// Feature C — http_request credential injection (see httpAuth.js).
const { MASK_VALUES, resolveHttpAuthHeaders, evictToken } = require('./httpAuth');
// "Ask this web service only once" — every rule about reusing an http_request
// answer lives there, so this file gains call sites and no policy.
const httpCache = require('./httpCache');
const { fetchFollowingSameHost } = require('./sameHostFetch');
const { HTTP_RESPONSE_CAP } = require('../../automation/httpResponseLimits');
// Every secret this run can see, for the one refusal the visible cache tier
// adds: a credential must never become a permanent row (execDatatable's own
// refusal #4, and a key can sit in a URL PATH segment as well as in a query).
const { secretValuesFor, stepInputsSynthetic } = require('./shared');
const safety = require('./safety');
const { sendRunEmail, emailSkipOf } = require('./runNotifications');
// Each outbound call runs in its own capture context (core/http/captureCall.js).
const { captureCall: captured } = require('../http/captureCall');
const log = require('../../telemetry/log');

// ── Guarded egress for step types that are not catalog tools ────────────────
//
// http_request, the code step's two bridges and notification delivery all push
// runState content out of the platform, and all three used to do it with no
// privacy scan and no ledger row — three ways to send an org's personal data
// to an arbitrary address invisibly. They go through the same order as an
// integration_action now: guard → decide what leaves → dispatch → log.

const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|.*\.local|.*\.internal)$/i;

function isPrivateHost(hostname) {
    return PRIVATE_HOST_RE.test(String(hostname || ''));
}

/**
 * Guard an outbound payload and decide what actually leaves.
 * Throws GuardrailBlockError on a block (after writing a `blocked` ledger row).
 *
 * @returns {{ payload, policy, auditBase, guarded, destination }}
 */
async function guardOutbound(step, ctx, mode, { toolName, payload, destination = 'external', integMeta = null }) {
    const policy = await safety.resolveAutomationPolicy(ctx);
    const auditBase = safety.buildAuditBase(ctx, step);
    let guarded;
    try {
        guarded = await safety.guardToolInput(payload, policy, auditBase, mode, ctx);
    } catch (err) {
        if (err && err.guardrailBlocked) {
            await safety.logEgress({
                toolName, toolArgs: {}, blocked: true, error: err,
                policy, auditBase, mode, integMeta, durationMs: 0,
            });
        }
        throw err;
    }
    return {
        payload: safety.prepareForEgress(guarded.value, policy, ctx, { destination }),
        policy, auditBase, guarded, destination,
    };
}

async function execNotification(step, ctx, runState, mode) {
    const title = typeof step.title === 'string' ? require('../../automation/bind').interpolateTemplate(step.title, runState) : '';
    const body = typeof step.body === 'string' ? require('../../automation/bind').interpolateTemplate(step.body, runState) : '';
    // Channel contract (A15): 'notification' (canonical) and 'inapp' (alias,
    // matches notificationDefaults' channel vocabulary) create the in-app
    // bell; 'email' sends via sendRunEmail (which skips without throwing when
    // no service email is configured — a soft skip, reported as not delivered).
    // Unknown channels are filtered AND reported; a step whose channels
    // contain NO known channel throws loudly — it used to "deliver" nothing
    // and record success.
    const requested = Array.isArray(step.channels) && step.channels.length ? step.channels : ['notification'];
    const known = requested.filter(c => c === 'notification' || c === 'inapp' || c === 'email');
    const ignored = requested.filter(c => !known.includes(c));
    if (known.length === 0) {
        const err = new Error(`notification: no supported channel in [${requested.join(', ')}] — use "notification" and/or "email"`);
        err.errorClass = 'notification_channel_unsupported';
        throw err;
    }
    if (mode === 'dry_run') {
        return { output: { wouldNotify: { title, body, channels: known, ...(ignored.length ? { ignoredChannels: ignored } : {}) } } };
    }

    // ── Safety: title/body are `{{…}}`-interpolated from runState — a single
    // `{{steps.s1.output}}` emails the whole payload — and this delivery step
    // was neither scanned nor logged. Email leaves the platform; the in-app
    // bell does not, so they are guarded against different destinations.
    const wantsEmail = known.includes('email');
    const wantsBell = known.includes('notification') || known.includes('inapp');
    const notifyMeta = {
        integration: wantsEmail ? 'notification_email' : 'notification_inapp',
        label: wantsEmail ? 'Email notification' : 'In-app notification',
        server: wantsEmail ? 'smtp' : 'local',
        direction: 'outbound',
        dataCategories: 'notification_content',
        isLocal: !wantsEmail,
    };
    const guardedNotify = await guardOutbound(step, ctx, mode, {
        toolName: notifyMeta.integration,
        payload: { title, body },
        destination: wantsEmail ? 'external' : 'internal',
        integMeta: notifyMeta,
    });
    const outTitle = guardedNotify.payload.title;
    const outBody = guardedNotify.payload.body;

    if (wantsBell) {
        await notificationStore.createNotification({
            userId: ctx.userId,
            category: 'ai_task',
            title: outTitle || 'Automation notification',
            message: outBody || '',
        });
    }
    let mailProbe = null;
    let emailSkip = null;
    const mailT0 = Date.now();
    if (wantsEmail) {
        // The mail goes out through the service account's API: captured, so
        // the row names the host it reached. A failed send is logged too.
        const sent = await captured(() => sendRunEmail(
            { userId: ctx.userId, title: ctx.automationTitle || 'Automation' },
            { subject: outTitle || 'Automation notification', message: outBody || '' },
        ));
        mailProbe = sent.probe;
        if (!sent.ok) {
            await safety.logEgress({
                toolName: notifyMeta.integration, toolArgs: { channels: known }, error: sent.error,
                probe: mailProbe, policy: guardedNotify.policy,
                auditBase: guardedNotify.auditBase, mode, integMeta: notifyMeta, durationMs: Date.now() - mailT0,
            });
            throw sent.error;
        }
        // BFSF-350: a mail skipped for want of a service mailbox or an owner
        // address stays a soft skip, but is reported as one, not as delivered.
        emailSkip = emailSkipOf(sent.value);
    }
    const deliveredChannels = emailSkip ? known.filter(c => c !== 'email') : known;
    // The ledger logs what actually went out: a skipped mail never reached
    // the mail host, so then only the bell (if requested) gets a row.
    const logMeta = emailSkip ? { ...notifyMeta, integration: 'notification_inapp', label: 'In-app notification', server: 'local', isLocal: true } : notifyMeta;
    if (deliveredChannels.length) {
        await safety.logEgress({
            toolName: logMeta.integration, toolArgs: { channels: deliveredChannels },
            result: { delivered: true }, probe: emailSkip ? null : mailProbe, policy: guardedNotify.policy,
            auditBase: guardedNotify.auditBase, mode, integMeta: logMeta,
            durationMs: wantsEmail && !emailSkip ? Date.now() - mailT0 : 0,
        });
    }
    const delivered = {
        title: outTitle, body: outBody, channels: deliveredChannels,
        ...(ignored.length ? { ignoredChannels: ignored } : {}), ...(emailSkip ? { skippedChannels: [emailSkip] } : {}),
    };
    // Email was the only channel and it was skipped: an amber row with the
    // reason, not a green success.
    if (!deliveredChannels.length) return { output: { delivered, skipped: emailSkip.message }, skippedReason: emailSkip.reason };
    return { output: { delivered } };
}

// 1MB response cap — shared with codeSandbox's defaultFetchHttp bridge via
// automation/httpResponseLimits.js, so both outbound-HTTP surfaces (code step
// + this declarative step) enforce the exact same ceiling from one constant.
// BFSF-436: unlike the code step's bridge, THIS surface fails the step rather
// than silently returning a clipped body under `success` — see the throw in
// execHttpRequest below.
const HTTP_REQUEST_RESPONSE_CAP = HTTP_RESPONSE_CAP;
const HTTP_REQUEST_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HTTP_PARSE_MODES = new Set(['auto', 'never', 'always']);

/**
 * The response body, parsed — or `undefined`, which means "no `data` key".
 *
 * Three rules, each paying for itself:
 *
 *  - NEVER THROWS. A malformed body is a bad answer from someone else's
 *    server; turning that into a failed run would replace "output I cannot
 *    use" with "automation that stops", which is strictly worse.
 *  - Never parses a TRUNCATED body. A response clipped at 1 MiB is invalid
 *    JSON by construction, and a half-parsed document that silently loses its
 *    tail is worse than the text we already have.
 *  - `auto` (the default) only parses when the server SAYS it is JSON, so a
 *    CSV or HTML response gains nothing and its output is byte-for-byte what
 *    it was before this existed.
 *
 * Semantics deliberately match the `parseJson()` expression function
 * (shared/expr/functions.mjs): strip a BOM, trim, and give up quietly.
 */
function parseHttpBody(text, contentType, mode, truncated) {
    const how = HTTP_PARSE_MODES.has(mode) ? mode : 'auto';
    if (how === 'never' || truncated) return undefined;
    if (how === 'auto' && !/\bjson\b/i.test(String(contentType || ''))) return undefined;
    let s = String(text ?? '');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    s = s.trim();
    if (!s) return undefined;
    try { return JSON.parse(s); } catch { return undefined; }
}

/**
 * Outbound HTTP/webhook call step. `blockPrivateTargets` (default true) is
 * an explicit, OPTIONAL per-step security toggle — not mandatory, per
 * product decision — that routes through utils/ssrfGuard's safeFetch
 * (literal-hostname screen + DNS-rebinding-safe validated lookup + a
 * connector that re-screens every redirect hop) instead of a bare fetch.
 * Turning it off is a deliberate escape hatch for automations that need to
 * reach an internal/private endpoint (e.g. a self-hosted user's own LAN
 * service) — the inspector surfaces a clear warning when it's disabled.
 *
 * Dry-run follows the same reads-live/writes-simulated convention as
 * execIntegrationAction's sideEffect gate: GET/HEAD execute for real so the
 * builder preview shows the actual response shape; POST/PUT/PATCH/DELETE
 * are synthesized so a preview can never cause a real external side effect.
 */
async function execHttpRequest(step, ctx, runState, mode) {
    // A request carries DATA, not prose: lists stay JSON here (listAs 'json').
    const asData = { listAs: 'json' };
    const url = interpolateTemplate(step.url || '', runState, asData);
    const method = (step.method || 'GET').toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(step.headers || {})) {
        headers[k] = interpolateTemplate(typeof v === 'string' ? v : '', runState, asData);
    }
    const isWrite = HTTP_REQUEST_WRITE_METHODS.has(method);
    const body = isWrite && step.body ? interpolateTemplate(step.body, runState, asData) : undefined;
    // Feature C — optional saved-credential reference. Absent/null auth keeps
    // the pre-existing path byte-for-byte (no store call, no decryption).
    const authConnectionId = (step.auth && typeof step.auth === 'object'
        && typeof step.auth.connectionId === 'string' && step.auth.connectionId)
        ? step.auth.connectionId : null;

    // Dry-run: writes stay synthesized as before; with a credential attached,
    // reads are synthesized too — a dry-run must NEVER decrypt or transmit a
    // stored credential.
    if (mode === 'dry_run' && (isWrite || authConnectionId)) {
        return {
            output: { status: 200, ok: true, headers: {}, body: '', data: null, _dryRun: true },
            dryRunSynthesised: true,
        };
    }

    let parsedUrl;
    try { parsedUrl = new URL(url); }
    catch (e) { throw new Error(`http_request: invalid URL "${url}" — ${e.message}`); }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`http_request: unsupported URL scheme "${parsedUrl.protocol}" — only http/https are allowed.`);
    }

    const blockPrivateTargets = step.blockPrivateTargets !== false; // default true

    // Header names injected from a stored credential. They are secrets, not
    // runState content — the guard must never tokenize or mask them.
    const authInjectedHeaders = new Set();
    // Identity of the credential for the response cache — NEVER its value. See
    // httpAuth.resolveHttpAuthHeaders and httpCache.canonicalHeaders.
    let credentialFingerprint = null;
    let credentialGrantId = null;
    if (authConnectionId) {
        const auth = await resolveHttpAuthHeaders({ connectionId: authConnectionId, blockPrivateTargets, auth: step.auth, url: parsedUrl.href }, ctx);
        credentialFingerprint = auth.fingerprint || null;
        credentialGrantId = auth.grantId || null;
        for (const [name, value] of Object.entries(auth.headers)) {
            authInjectedHeaders.add(name.toLowerCase());
            // The credential-injected header wins over a manual header,
            // case-insensitively (validate.js warns about the conflict).
            for (const k of Object.keys(headers)) {
                if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
            }
            headers[name] = value;
        }
        // Register mask needles BEFORE the fetch so even a thrown fetch error
        // recorded via recordRunStep masks the header value if it appears in
        // a message.
        (runState[MASK_VALUES] ||= []).push(...auth.maskValues);
    }

    // ── Safety: the URL, headers and body are all interpolated from runState,
    // so this step can post an org's personal data to any address. It used to
    // do that completely unscanned and unlogged.
    const destination = isPrivateHost(parsedUrl.hostname) ? 'internal' : 'external';
    const httpMeta = {
        integration: 'http_request',
        label: parsedUrl.hostname,
        server: parsedUrl.origin,
        direction: isWrite ? 'outbound' : 'both',
        dataCategories: 'auto_detected',
        isLocal: destination === 'internal',
    };
    // Guard the interpolated values that carry runState content. Credential
    // headers injected above are excluded — they are secrets, and masking them
    // would break the request rather than protect anyone.
    const guardableHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
        if (!authInjectedHeaders.has(k.toLowerCase())) guardableHeaders[k] = v;
    }
    const guardedHttp = await guardOutbound(step, ctx, mode, {
        toolName: 'http_request',
        payload: { url, body, headers: guardableHeaders },
        destination,
        integMeta: httpMeta,
    });
    if (mode === 'dry_run' && guardedHttp.guarded && guardedHttp.guarded.wouldBlock) {
        // A `block` policy THROWS in live mode but, in dry-run, hands the
        // payload back UNTRANSFORMED with wouldBlock — and this path used to
        // ignore that flag and dispatch, so the exact request that is blocked in
        // production was really sent during a preview. Every other outbound path
        // (execIntegrationAction, execAiStep, execParseJson) synthesizes here;
        // this one now does too, in the same shape so the inspector renders it
        // identically to the write/credential dry-run above.
        return {
            output: {
                status: 200, ok: true, headers: {}, body: '', data: null, _dryRun: true,
                _guardrailWouldBlock: guardedHttp.guarded.categories || [],
            },
            dryRunSynthesised: true,
            dryRunFallback: 'guardrail_block',
        };
    }
    const sendUrl = typeof guardedHttp.payload.url === 'string' ? guardedHttp.payload.url : url;
    const sendBody = body === undefined ? undefined : guardedHttp.payload.body;
    for (const [k, v] of Object.entries(guardedHttp.payload.headers || {})) {
        if (typeof v === 'string') headers[k] = v;
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
        step, ctx, mode, method, blockPrivateTargets,
        policy: guardedHttp.policy, destination, parsedUrl,
        sendUrl, sendBody, headers,
        authInjectedHeaders, credentialFingerprint,
        connectionId: authConnectionId, grantId: credentialGrantId,
    });
    if (cache && cache.served) {
        // The stored value is the PRE-parse response, so `data` is re-derived
        // under whatever parseResponse the step carries NOW.
        const hit = { ...cache.served.out };
        const hitParsed = parseHttpBody(hit.body, (hit.headers || {})['content-type'], step.parseResponse, hit.truncated);
        if (hitParsed !== undefined) hit.data = hitParsed;
        // A DURABLE or TABLE hit writes a FLAGGED ledger row: the org does use
        // this processor and the RoPA takes MAX(timestamp), but no bytes
        // crossed the boundary so the Art-44 transfer count excludes it. A
        // RUN-MEMO hit writes nothing — the first call in this run already
        // logged the real transfer, and a second row would double-count it.
        // The table tier makes this argument STRONGER, not weaker: a thirty-day
        // window can answer every call for a month, and a processor that
        // vanishes from an Art. 30 register for a month is not a rounding
        // error.
        if (cache.served.tier === 'stored' || cache.served.tier === 'table') {
            await safety.logEgress({
                toolName: 'http_request', toolArgs: { url: sendUrl, method },
                result: { status: hit.status }, policy: guardedHttp.policy,
                auditBase: guardedHttp.auditBase, mode, integMeta: httpMeta,
                durationMs: 0, servedFromCache: true,
            });
        }
        // The IDENTICAL guard tail a live call gets, so tokens are minted into
        // THIS run's vault and a hit and a fetch are the same shape downstream.
        const guardedHit = await safety.guardToolOutput(hit, guardedHttp.policy, guardedHttp.auditBase, mode, ctx);
        return { output: safety.restoreForRunState(guardedHit.result, ctx), reused: cache.served.tier };
    }
    // A conditional GET is a REAL call, so it logs a real egress row below. It
    // is the one mechanism here that cannot serve a stale answer: the origin
    // decides, with a 304 or a fresh 200.
    if (cache && cache.revalidate) Object.assign(headers, cache.revalidate.headers);

    const timeoutMs = typeof step.timeoutMs === 'number' ? step.timeoutMs : 10_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const httpT0 = Date.now();
    let httpProbe = null;
    try {
        const fetchImpl = blockPrivateTargets ? safeFetch : fetch;
        // Sent AND read inside the capture context: the peer (the address the
        // socket really reached, redirects included) comes from this call.
        const call = await captured(async () => {
            // A stored credential must never follow a redirect to another
            // host (the allowed-hosts binding is checked on the first URL only,
            // and a custom auth header survives a cross-origin hop): follow
            // same-host hops by hand and refuse the rest.
            const r = authInjectedHeaders.size > 0
                ? await fetchFollowingSameHost(fetchImpl, sendUrl, { method, headers, body: sendBody, signal: ac.signal })
                : await fetchImpl(sendUrl, { method, headers, body: sendBody, signal: ac.signal });
            return { resp: r, text: await r.text() };
        });
        httpProbe = call.probe;
        if (!call.ok) throw call.error;
        const { resp, text } = call.value;
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
        if (text.length > HTTP_REQUEST_RESPONSE_CAP) {
            throw new Error('response body exceeded the 1 MiB limit and was clipped mid-document — this call cannot be completed safely. Reduce the response size (pagination, a narrower query) or contact support if you need a higher limit.');
        }
        await safety.logEgress({
            toolName: 'http_request', toolArgs: { url: sendUrl, method },
            result: { status: resp.status }, probe: httpProbe, policy: guardedHttp.policy,
            auditBase: guardedHttp.auditBase, mode, integMeta: httpMeta,
            durationMs: Date.now() - httpT0,
        });
        // A 304 answering OUR conditional GET means the stored body is still
        // current: refresh its expiry and serve it. Only when we actually sent
        // the validators — an origin that answers 304 unprompted has told this
        // step nothing it can use, and the response passes through as-is.
        // `truncated` is always false past the throw above — there is no
        // partial-cap case left on this path.
        const out = (resp.status === 304 && cache && cache.revalidate)
            ? await httpCache.refresh(cache)
            : {
                status: resp.status,
                ok: resp.ok,
                headers: Object.fromEntries(resp.headers.entries()),
                body: text,
                truncated: false,
            };
        // Written BEFORE the output guard, so what is stored is what a live
        // call produced — a hit then falls into the identical guard tail. The
        // whole refusal matrix (2xx only, never truncated, never a response
        // carrying a session header, Cache-Control as a ceiling) lives in
        // httpCache.storability; a failed dispatch throws past this line and is
        // never stored.
        if (cache && !(resp.status === 304 && cache.revalidate)) await httpCache.store(cache, out);
        // `data` — the SAME body, parsed, when it is JSON.
        //
        // `body` deliberately stays a string forever: every saved automation, every
        // {{template}} and every {kind:'ref'} binding already reads it as text,
        // and changing its type would rewrite the meaning of those silently.
        // The parsed copy is additive, so a JSON API is finally usable as a
        // LIST — `arrayRef`/`repeat_for_each` both require a real array and a
        // string could never satisfy them.
        // out.truncated, not the local `truncated`: on the 304 path `out` is the
        // stored response and this request's own body was empty.
        const parsed = parseHttpBody(out.body, out.headers['content-type'], step.parseResponse, out.truncated);
        if (parsed !== undefined) out.data = parsed;
        // Guard the RESPONSE too (toolOutput scope) — a webhook reply can carry
        // personal data straight into runState and every downstream node.
        // `data` is inside `out`, so it is scanned on this same pass; parsing
        // after the guard would have created an unscanned path to the same
        // personal data.
        const guardedResp = await safety.guardToolOutput(out, guardedHttp.policy, guardedHttp.auditBase, mode, ctx);
        // The VISIBLE tier is written HERE and nowhere else: after the guard,
        // so what lands in a plaintext, org-readable, exportable column is the
        // value the Privacy Shield has already been through, and never the raw
        // third-party body. `out` still decides ELIGIBILITY (status, headers,
        // truncation) because the guard does not touch those.
        //
        // Never awaited into the step's failure: a full table, an over-large
        // answer or a service that echoed a secret back means the row is not
        // written and the next run asks again — which is what happened before
        // this feature existed. It is reported so a tick cannot silently do
        // nothing.
        let cacheInto = null;
        if (cache && cache.into) {
            cacheInto = await httpCache.storeInto(cache, out, guardedResp.result, {
                secretValues: secretValuesFor(runState),
            });
            if (cacheInto && cacheInto.stored === false) {
                log.warn(`[AutomationRunner] http_request answer not remembered in "${cache.into.table.key}": ${cacheInto.reason}`);
            }
        }
        return {
            output: safety.restoreForRunState(guardedResp.result, ctx),
            ...(cacheInto ? { cacheInto } : {}),
        };
    } catch (e) {
        await safety.logEgress({
            toolName: 'http_request', toolArgs: { url: sendUrl, method }, error: e,
            probe: httpProbe, policy: guardedHttp.policy, auditBase: guardedHttp.auditBase, mode,
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

/**
 * A dry run that cannot run the code at all, said the way it used to be said.
 *
 * Reached only when the sandbox is missing or the platform/org gates are shut
 * — i.e. when a LIVE run of this step would refuse too. A rehearsal must not
 * be the thing that tells an author their org has code steps switched off, so
 * it reports a skip rather than raising the refusal a live run raises.
 */
function codeStepSkipped(why) {
    return { output: { _dryRun: true, skipped: `code-step skipped in dry-run: ${why}` } };
}

async function execCode(step, ctx, runState, mode) {
    const rehearsal = mode === 'dry_run';
    // A DRY RUN USED TO SKIP THE CODE OUTRIGHT. Of every step type, this is
    // the one where skipping teaches nothing: the whole question about a code
    // step is whether the code works, and "code-step skipped in dry-run" is
    // the answer to a question nobody asked. Meanwhile the first time the
    // author found out about their typo was a live run — which is exactly the
    // run a rehearsal exists to save them from.
    //
    // It is also the step type with the broadest reach: ctx.integrations can
    // send mail, ctx.http can POST to any public host, ctx.db writes. So the
    // code RUNS and the outside is stubbed (codeSandbox testBridges): every
    // call is recorded and answered with an obviously-fake value, so the line
    // after it still executes and the author finds out their code throws on
    // line 12 instead of finding out that it "was skipped".
    if (!sandbox.isAvailable()) {
        if (rehearsal) return codeStepSkipped('the sandbox is not installed here');
        throw new Error(`Code step unavailable: ${sandbox.loadError()}`);
    }

    // There is no switch: code steps run wherever the sandbox is installed.
    // The platform flag and the per-org `ai_code_execution` beta that used to
    // sit here are gone; the sandbox is the safety boundary.

    // The code's own rules: BLOCK findings stop it, declared parameters get
    // their defaults and types, ctx.http keeps to the host list (codeStepGuard.js).
    const guard = prepareCodeRun(step, resolveInputs(step.inputs || {}, runState, { allowSecrets: false, listAs: 'json' }));
    if (guard.refusal) {
        if (rehearsal) return codeStepSkipped(guard.refusal);
        throw new Error(guard.refusal);
    }
    const inputs = guard.inputs;
    // Whether anything this code is about to read was invented upstream. Asked
    // BEFORE the run, because the answer is about the data going in, and used
    // only to label the rehearsal's output — see the note where it is attached.
    const syntheticInputs = rehearsal && stepInputsSynthetic(step, runState, ctx);
    // Secrets — step.inputs.secretKeys[] is an authoring-time declaration that
    // NOTHING in this build can honour. `runState.secrets` is initialised to
    // `{}` in execution.js and no bridge, resume path or store ever assigns to
    // it, so the loop that used to stand here resolved every declared key to
    // `null` and handed that map to the sandbox. A step declaring
    // `secretKeys: ['stripe_key']` therefore ran with a credential of null and
    // POSTed `Authorization: Bearer null` to a third party, and the author got
    // no signal at all — the run went green. A declared-but-unfillable
    // credential is a broken step, not a step with an empty credential, so
    // refuse it HERE, before any code runs and long before an outbound call,
    // rather than letting the failure happen at the far end where the only
    // evidence is a 401 from someone else's API.
    // The sandbox raises the matching refusal for the other half of the lie —
    // code that calls ctx.secrets() without declaring anything (codeSandbox.js
    // header explains the whole shape). Nothing is passed as bridges.secrets
    // any more: the sandbox ignores it.
    const declaredSecretKeys = Array.isArray(step.inputs?.secretKeys?.value) ? step.inputs.secretKeys.value
        : Array.isArray(step.inputs?.secretKeys) ? step.inputs.secretKeys
            : [];
    if (declaredSecretKeys.length > 0) {
        throw new Error(
            `This code step declares secretKeys (${declaredSecretKeys.join(', ')}), but `
            + sandbox.SECRETS_NOT_CONFIGURED_MESSAGE);
    }

    const declaredTools = new Set(step.allowedTools || []);
    // Defense-in-depth permission check — mirrors execIntegrationAction's
    // re-resolve above. step.allowedTools is design-time config; by the
    // time a scheduled automation actually fires, an org admin may have
    // disabled the integration or removed the user from the group that
    // granted it. Re-resolve the user's CURRENT allowed tool set (cached
    // on ctx so this only runs once per run, shared with any
    // integration_action steps in the same graph) and intersect it with
    // the step's declared allowlist before handing anything to the sandbox.
    // Skipped entirely when the step declares no tools — nothing to validate.
    if (declaredTools.size > 0 && !ctx.allowedToolNames) {
        try {
            const { getIntegrationTools } = require('../integrations/integrationTools');
            const lendPolicy = (ctx.resourceOwnerUserId && ctx.resourceOwnerUserId !== ctx.userId)
                ? { ownerUserId: ctx.resourceOwnerUserId, resourceType: 'automation', resourceId: ctx.automationId || null }
                : null;
            const r = await getIntegrationTools({
                userId: ctx.userId,
                session: ctx.session,
                isAdmin: !!ctx.session?.isAdmin || ctx.session?.user?.role === 'admin',
                automationStep: true,
                connectionPolicy: lendPolicy,
            });
            ctx.allowedToolNames = new Set((r.tools || []).map(t => t?.function?.name).filter(Boolean));
        } catch (e) {
            log.warn(`[AutomationRunner] Permission catalog lookup failed (code step): ${e.message}`);
            throw new Error('Could not verify your permission for this step\'s tools. The automation has been paused — please re-open it after refreshing your permissions.');
        }
    }
    const allowedTools = ctx.allowedToolNames
        ? new Set([...declaredTools].filter(name => ctx.allowedToolNames.has(name)))
        : declaredTools;
    const { executeTool } = require('../tools/toolDispatcher');

    const { result, logs, http, calls } = await sandbox.runCode({
        code: step.code,
        inputs,
        limits: step.limits || {},
        // Fairness unit for the sandbox's concurrency cap (codeSandboxSlots.js).
        concurrencyKey: ctx.orgId || ctx.userId || null,
        // The bridges below are still BUILT in a rehearsal and simply never
        // reached: the sandbox swaps them for recording stubs. Building them
        // anyway keeps the permission re-resolve above on the rehearsal path
        // too, so a dry run still refuses a tool the author has since lost
        // access to — a rehearsal that permits more than the real run would
        // teach exactly the wrong lesson.
        mode: rehearsal ? 'test' : 'live',
        bridges: {
            // Both bridges used to bypass the shield entirely: a code step
            // could call any permitted tool, or fetch any URL, with no scan
            // and no ledger row. They go through the same guard + log path as
            // every other outbound call now.
            executeTool: async (name, args) => {
                if (!allowedTools.has(name)) return { error: `tool "${name}" not allowed for this step` };
                const { resolveIntegration } = require('../integrations/integrationToolMap');
                const meta = resolveIntegration(name, args || {}, { nextcloudUrl: ctx.nextcloudUrl });
                let guardedCall;
                try {
                    guardedCall = await guardOutbound(step, ctx, mode, {
                        toolName: name,
                        payload: args || {},
                        destination: meta && meta.isLocal ? 'internal' : 'external',
                        integMeta: meta,
                    });
                } catch (err) {
                    if (err && err.guardrailBlocked) return { error: err.message };
                    throw err;
                }
                const t0 = Date.now();
                // Dispatched inside this bridge's own capture context, so the
                // dispatcher's chokepoint sees a probe and leaves the row to
                // the logEgress calls below (one row, with the peers).
                const call = await captured(() => executeTool(name, guardedCall.payload, {
                    userId: ctx.userId, session: ctx.session, orgId: ctx.orgId,
                    userGroupIds: ctx.userGroupIds || [],
                    userOrgIds: ctx.userOrgIds || [],
                    runScope: ctx.runId ? { runId: ctx.runId, rootRunId: ctx.rootRunId || ctx.runId } : null,
                    egress: false,
                }));
                try {
                    if (!call.ok) throw call.error;
                    const value = call.value;
                    await safety.logEgress({
                        toolName: name, toolArgs: guardedCall.payload, result: value, probe: call.probe,
                        policy: guardedCall.policy, auditBase: guardedCall.auditBase, mode,
                        durationMs: Date.now() - t0,
                    });
                    const gOut = await safety.guardToolOutput(value, guardedCall.policy, guardedCall.auditBase, mode, ctx);
                    return safety.restoreForRunState(gOut.result, ctx);
                } catch (err) {
                    await safety.logEgress({
                        toolName: name, toolArgs: guardedCall.payload, error: err, probe: call.probe,
                        policy: guardedCall.policy, auditBase: guardedCall.auditBase, mode,
                        durationMs: Date.now() - t0,
                    });
                    throw err;
                }
            },
            allowedTools,
            fetchHttp: async (url, options) => {
                let host = '';
                try { host = new URL(String(url)).hostname; } catch (_) { /* let the sandbox reject it */ }
                const offList = host ? guard.refuseHost(host) : null;
                if (offList) return { error: offList };
                const meta = {
                    integration: 'http_request', label: host || 'http',
                    server: host ? `https://${host}` : null, direction: 'both',
                    dataCategories: 'auto_detected', isLocal: isPrivateHost(host),
                };
                // REQUEST HEADERS are part of the egress. Only {url, body} used
                // to be guarded here while `options` was forwarded to safeFetch
                // verbatim, so anything the sandboxed code put in a header left
                // the platform unscanned, unmasked and unaudited — the exact
                // hole execHttpRequest closes with its guardableHeaders block.
                // `options` arrives JSON-parsed from the isolate, so headers is
                // a plain object; anything else is left alone rather than being
                // silently flattened into one.
                const rawHeaders = options && options.headers;
                const guardableHeaders = (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders))
                    ? rawHeaders : undefined;
                const guardedFetch = await guardOutbound(step, ctx, mode, {
                    toolName: 'code_fetch_http',
                    payload: { url: String(url), body: options && options.body, headers: guardableHeaders },
                    destination: isPrivateHost(host) ? 'internal' : 'external',
                    integMeta: meta,
                });
                const t0 = Date.now();
                // What travels is built FROM THE GUARDED RESULT, never from the
                // caller's object — that is the whole point of the guard.
                const sendOptions = { ...(options || {}) };
                if (guardedFetch.payload.body !== undefined) sendOptions.body = guardedFetch.payload.body;
                if (guardableHeaders) sendOptions.headers = guardedFetch.payload.headers || {};
                const call = await captured(() => sandbox.defaultFetchHttp(guardedFetch.payload.url, sendOptions));
                let res;
                try {
                    if (!call.ok) throw call.error;
                    res = call.value;
                    await safety.logEgress({
                        toolName: 'code_fetch_http', toolArgs: { url: guardedFetch.payload.url },
                        result: { ok: true }, probe: call.probe, policy: guardedFetch.policy,
                        auditBase: guardedFetch.auditBase, mode, integMeta: meta,
                        durationMs: Date.now() - t0,
                    });
                } catch (err) {
                    await safety.logEgress({
                        toolName: 'code_fetch_http', toolArgs: { url: guardedFetch.payload.url }, error: err,
                        probe: call.probe, policy: guardedFetch.policy, auditBase: guardedFetch.auditBase, mode,
                        integMeta: meta, durationMs: Date.now() - t0,
                    });
                    throw err;
                }
                // The RESPONSE is step output: the sandbox hands it to user code
                // and its return value is written into runState. execHttpRequest
                // has always guarded its reply (egressCoverage pins that
                // contract); this bridge did not, so the same third-party body
                // that a `block` policy stops on an http_request step landed
                // freely in runState via a code step.
                let guardedRes;
                try {
                    guardedRes = await safety.guardToolOutput(res, guardedFetch.policy, guardedFetch.auditBase, mode, ctx);
                } catch (err) {
                    // The sandbox already speaks `{ error }` — the same shape a
                    // refused URL or a blocked tool call comes back as.
                    if (err && err.guardrailBlocked) return { error: err.message };
                    throw err;
                }
                return safety.restoreForRunState(guardedRes.result, ctx);
            },
        },
    });
    // The sandbox's return value + logs go straight into runState and from
    // there into every downstream node — they used to do so with no output
    // guard at all, which made the code step a way around the toolOutput scope
    // that execIntegrationAction and execHttpRequest both enforce. Guard, then
    // restore from the run vault so downstream steps still see real values.
    const codePolicy = await safety.resolveAutomationPolicy(ctx);
    const codeAudit = safety.buildAuditBase(ctx, step);
    const guardedCode = await safety.guardToolOutput({ result, logs }, codePolicy, codeAudit, mode, ctx);
    const restoredCode = safety.restoreForRunState(guardedCode.result, ctx) || {};
    return {
        output: {
            result: restoredCode.result,
            logs: restoredCode.logs,
            httpCalls: http.calls,
            // A rehearsal SAYS what it would have done rather than letting a
            // stubbed answer pass for a real one. Without this the run reads
            // as a step that called nothing, which is the same false
            // reassurance the old skip gave, one layer further in.
            //
            // And when the inputs were SYNTHESIZED upstream (a sample
            // fallback, a simulated side effect, a synthetic trigger) it says
            // that too. The code still runs — a syntax error, a null deref or
            // a wrong branch is worth finding whatever the data was — but a
            // throw on a shape the real data would never have had is a false
            // alarm, and a false alarm that reads like a real one is how
            // people learn to ignore the rehearsal. execAi refuses to dispatch
            // at all in this case (dryRunFallback: 'synthetic_input'); here
            // running locally costs nothing and teaches more, so it runs and
            // is labelled instead.
            ...(rehearsal ? {
                _dryRun: true,
                wouldHaveCalled: calls || [],
                ...(syntheticInputs ? { _dryRunSyntheticInputs: true } : {}),
            } : {}),
        },
    };
}

module.exports = { execNotification, execHttpRequest, execCode };
