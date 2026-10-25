// @typecheck
/**
 * What an http_request answer becomes, for ./execHttpRequest.js: the body
 * parsed into `data`, a cache hit served through the same guard tail as a
 * live call, and a live answer stored, guarded and (for the visible tier)
 * remembered in a datatable.
 */

'use strict';

// "Ask this web service only once" — every rule about reusing an http_request
// answer lives there.
const httpCache = require('./httpCache');
// Every secret this run can see, for the one refusal the visible cache tier
// adds: a credential must never become a permanent row (execDatatable's own
// refusal #4, and a key can sit in a URL PATH segment as well as in a query).
const { secretValuesFor } = require('./shared');
const safety = require('./safety');
const log = require('../../telemetry/log');

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
 * @param {string} mode
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
 * A cache hit. The stored value is the PRE-parse response, so `data` is
 * re-derived under whatever parseResponse the step carries NOW.
 * @param {string} mode
 */
async function serveCachedHttp(step, ctx, mode, cache, { sendUrl, method, guarded, httpMeta }) {
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
            result: { status: hit.status }, policy: guarded.policy,
            auditBase: guarded.auditBase, mode, integMeta: httpMeta,
            durationMs: 0, servedFromCache: true,
        });
    }
    // The IDENTICAL guard tail a live call gets, so tokens are minted into
    // THIS run's vault and a hit and a fetch are the same shape downstream.
    const guardedHit = await safety.guardToolOutput(hit, guarded.policy, guarded.auditBase, mode, ctx);
    return { output: safety.restoreForRunState(guardedHit.result, ctx), reused: cache.served.tier };
}

/**
 * What a live answer becomes: the response cache written, `data` parsed,
 * the reply guarded, and the visible cache tier filled from the guarded
 * value.
 * @param {string} mode
 */
async function finishHttpResponse(step, ctx, runState, mode, { resp, text, cache, guarded }) {
    // A 304 answering OUR conditional GET means the stored body is still
    // current: refresh its expiry and serve it. Only when we actually sent
    // the validators — an origin that answers 304 unprompted has told this
    // step nothing it can use, and the response passes through as-is.
    // `truncated` is always false past the BFSF-436 throw — there is no
    // partial-cap case left on this path.
    const revalidated = resp.status === 304 && cache && cache.revalidate;
    const out = revalidated
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
    if (cache && !revalidated) await httpCache.store(cache, out);
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
    const guardedResp = await safety.guardToolOutput(out, guarded.policy, guarded.auditBase, mode, ctx);
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
    /** @type {{ stored: boolean; reason?: string; errorClass?: string; message?: string; } | null} */
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
}

module.exports = { parseHttpBody, serveCachedHttp, finishHttpResponse };
