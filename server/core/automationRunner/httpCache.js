/**
 * "Ask this web service only once" — the whole policy for reusing an
 * http_request answer, kept out of execOutbound so that step keeps one job.
 *
 * The motivating shape is the one `askOnce` was built for: a forEach over 200
 * rows calling the same reference API per row. It is sharper here, because a
 * hand-written http_request usually points at a rate-limited third party the
 * customer pays per call — and until now this was the one outbound step an
 * author fully controls and the only one that always re-asks. `stepRules.js`
 * already validated `askOnce`'s shape on every step type, so an askOnce on an
 * http_request validated clean, earned the org-gate warning, and did nothing.
 *
 * ── THIS IS A LIST OF REFUSALS ──────────────────────────────────────
 * Everything below is written as something the cache will NOT do. A refusal
 * cannot regress; a key component can be forgotten.
 *
 *   NOT the method       every method is cacheable — see CACHEABLE_METHODS for
 *                        why that refusal was removed on 2026-09-02, and for
 *                        what it costs. The validator warns on a write method;
 *                        it does not block. This entry is kept in the list so
 *                        nobody reads the list as still being method-gated.
 *   2xx only             a cached 401 defeats execHttpRequest's evictToken
 *                        retry; a cached 5xx freezes a transient failure for
 *                        the whole TTL.
 *   never truncated      a clipped body replayed as whole is the BFSF-360
 *                        failure, where a collection step then reports
 *                        "arrayRef did not resolve to an array".
 *   never a session      set-cookie / www-authenticate / proxy-authenticate /
 *                        authentication-info REFUSE THE WHOLE RESPONSE rather
 *                        than being stripped: `out.headers` is copied verbatim
 *                        into runState, so stripping would make a hit and a
 *                        live call return different shapes.
 *   never with the       `blockPrivateTargets === false` is a refusal, not a
 *   SSRF guard off       key component. An answer fetched with the guard
 *                        disabled came from a target that was never screened,
 *                        and replaying it after a reviewer ticks the box back
 *                        on launders it past a control they believe is in
 *                        force — no fetch happens on a hit, so the guard's
 *                        refusal never fires.
 *   never a header       the identity string is PLAINTEXT in memory before it
 *   VALUE from a         is hashed. Credential-injected header names stay in
 *   credential           the key; their values are replaced by httpAuth's
 *                        fingerprint, which changes on a secret rotation.
 *   never under          egressMode must be 'real'. Under `tokenize` the
 *   tokenize/redact      outgoing values are run-vault placeholders and under
 *                        `redact` every person collapses to `[person]`, so two
 *                        data subjects produce the SAME request.
 *
 * ── WHERE IT SITS, AND WHY THAT IS THE SECURITY PROPERTY ────────────
 * Copied from execAi. The READ happens AFTER `resolveHttpAuthHeaders` and
 * AFTER `guardOutbound`. resolveHttpAuthHeaders is not a header renderer — it
 * is this step's live authorization gate, and `authorizeConnectionUse`
 * re-reads the connection row and re-evaluates the unscoped `connection_grants`
 * join for revocation and expiry on EVERY run. Hoisting the read above it to
 * skip the OAuth token fetch would keep a revoked lend flowing for a whole TTL
 * with no ledger row; the token is already process-cached, so the saved work is
 * nothing next to the avoided HTTP call.
 *
 * The WRITE happens after `out` is built and BEFORE `guardToolOutput`, so a hit
 * falls into the IDENTICAL guard → restoreForRunState tail and mints tokens
 * into THIS run's vault exactly as a live call would.
 *
 * ── TWO TIERS, AND THE ONE PLACEMENT THAT DIFFERS ───────────────────
 * `askOnce` is the INVISIBLE tier: a run memo, plus an optional AES-GCM row
 * with an hour's ceiling that nothing but the runner ever reads.
 * `cacheInto` is the VISIBLE one: an ordinary row in an ordinary datatable,
 * browsable, correctable, exportable, readable by another automation's find_rows,
 * and expired by the ordinary retention sweeper instead of by a hidden TTL.
 * They are independent ticks and either can be on alone.
 *
 * The visible tier's WRITE is the one thing here that sits AFTER
 * `guardToolOutput` rather than before it, and that is the point: what lands in
 * a plaintext, org-readable, CSV-exportable column is the value the Privacy
 * Shield has already been through. The cost is stated rather than hidden —
 * under a TOKENISING policy a later run is served the tokenised text, because
 * this run's vault is gone. That is the correct trade for a table colleagues
 * can read; the editor says so in words.
 *
 * ── WHAT DOES NOT GET THIS, AND WHY ─────────────────────────────────
 * `integration_action` already has it. Everything else is a position, not an
 * omission:
 *   ai_step / parse_json in AI mode — never. Temperature 0.2 is still
 *     non-deterministic, and "summarise today's data" returning yesterday's
 *     sentence is a silent correctness failure with no error to catch.
 *     Provider-side prompt caching is the right lever there.
 *   notification — never. It is a delivery; caching it means not sending.
 *   datatable — never. Local, and a stale row is a data-correctness bug.
 *   guard / tokenize — never. It has its own scan cache, and the org policy
 *     can change between runs.
 *   the code step's `fetchHttp` bridge — never. Imperative code inside a
 *     sandbox `while` loop has no per-call tick to express intent, and a
 *     silently replayed fetch in there is undebuggable.
 * DEFERRED rather than rejected: the ai_step tool-calling loop (execAi.js's
 * dispatch, where a model can call gmail_search four times in one iteration)
 * and the code step's `executeTool` bridge — both can reuse the identical
 * `isMemoisable` gate.
 */

'use strict';

const safety = require('./safety');
const { memoKeyParts, memoKeyFromParts } = require('./toolMemo');
const { envFlagOn, resolveCachePolicy, resolveCachePolicyFresh } = require('./integrationCachePolicy');
const log = require('../../telemetry/log');

/**
 * EVERY method may be cached. This is a deliberate product decision taken by the
 * owner on 2026-09-02, and it is the one refusal in this module that was REMOVED
 * rather than kept — so the reasoning belongs here in full.
 *
 * The original rule was GET/HEAD only, because those two methods PROMISE that
 * they change nothing: the semantics ride on the method, so the runtime can
 * decide on its own. Every other method promises nothing, and a cache hit means
 * THE CALL DOES NOT HAPPEN.
 *
 * That refusal also blocked the shape this feature was asked for. Many lookup
 * APIs are POST by design — DataForSEO's keyword_ideas/live, GraphQL,
 * Elasticsearch _search — because the query does not fit in a URL. Refusing them
 * means refusing precisely the expensive, repeated, read-only calls a cache
 * exists for.
 *
 * So the method no longer decides. What that costs, stated plainly: ticking
 * reuse on a step that DOES change something (an order, a message, a delete)
 * means the change silently does not happen on a hit. The validator therefore
 * WARNS on a write method — a warning, never a block, because the author was
 * given this control deliberately — and the request BODY is part of the cache
 * identity, so two different POST payloads are two different answers.
 *
 * Kept as a named set rather than deleted: the eligibility gate reads better
 * naming what it allows, and a future decision to narrow it again has one place
 * to land.
 */
const CACHEABLE_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A response carrying any of these establishes or challenges a session, so it
 * is by definition not a shared cacheable answer. `out.headers` is
 * `Object.fromEntries(resp.headers.entries())` — the WHOLE header set lands in
 * runState, and undici joins multiple Set-Cookie values into one string — so a
 * durable row would hold a replayable session. Refusing the response rather
 * than stripping the header keeps a hit and a live call the same shape.
 */
const CREDENTIAL_RESPONSE_HEADERS = ['set-cookie', 'www-authenticate', 'proxy-authenticate', 'authentication-info'];

/**
 * Mirrors execOutbound's HTTP_REQUEST_RESPONSE_CAP. toolMemo's own per-entry
 * ceiling is 256 KiB, so without this a 400 KiB catalogue in a 200-row loop
 * would be silently refused two hundred times.
 *
 * A body just under the cap can still be refused once JSON-escaped into the
 * entry — that is a counted refusal (memo.stats().refused), never a silent
 * truncation.
 */
const HTTP_MAX_ENTRY_BYTES = 1024 * 1024;

/**
 * The VISIBLE tier's default window, in days. Thirty, because the shape this
 * exists for is a keyword/SEO reference API whose answer is worth keeping for
 * a month — the reason a one-hour invisible TTL was never the answer to it.
 */
const CACHE_INTO_DEFAULT_DAYS = 30;
/** Same ten-year ceiling routes/datatables.js puts on a retention window. */
const CACHE_INTO_MAX_DAYS = 3650;

/** Rows are always in Postgres; the App Studio engine flag may say otherwise. */
const PG = { dialect: 'pg' };

/** Per-step reuse window, same 1..900s clamp execAi applies. */
function stepTtlMs(askOnce) {
    const n = (askOnce && typeof askOnce === 'object') ? Number(askOnce.ttlSeconds) : NaN;
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.max(1, Math.min(900, n)) * 1000;
}

/**
 * Header names lower-cased and sorted, with credential-injected header VALUES
 * replaced by httpAuth's fingerprint.
 *
 * The NAME stays: two steps hitting the same URL with and without an
 * `X-Api-Key` are different requests and must not share an answer. The VALUE
 * never does: `memoKeyParts` builds a plaintext identity string that is only
 * then hashed, so a live bearer token would sit in process memory as
 * cache-key material. The fingerprint is `<connId>:<updatedAt>:<accessMode>`,
 * so rotating the secret bumps `updated_at` and invalidates the key for free.
 *
 * Sorting is belt-and-braces — stableStringify already sorts object keys — but
 * it makes the canonical form readable in a test failure.
 */
function canonicalHeaders(headers, authInjectedHeaders, credentialFingerprint) {
    const injected = authInjectedHeaders instanceof Set ? authInjectedHeaders : new Set();
    const out = {};
    for (const name of Object.keys(headers || {}).sort()) {
        const lower = name.toLowerCase();
        out[lower] = injected.has(lower)
            ? `cred:${credentialFingerprint || '-'}`
            : String(headers[name] ?? '');
    }
    return out;
}

/**
 * `Cache-Control` as a CEILING, never an extension.
 *
 * The origin is allowed to shorten our window or forbid storage entirely; it is
 * never allowed to lengthen it past what the org admin and the step author
 * agreed. `Vary: *` means the response depends on something not in the request,
 * so nothing about it is reusable.
 *
 * Any OTHER `Vary` needs no handling, and that is not a shortcut: the key
 * already carries the FULL canonical request header set, which is strictly
 * stronger than varying on the named subset. This is deliberately not an
 * implementation of RFC 9111.
 */
function parseCacheControl(headers) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;

    if (String(h.vary || '').trim() === '*') return { tier: 'none', maxAgeSeconds: null };

    const cc = String(h['cache-control'] || '').toLowerCase();
    const directives = cc.split(',').map(s => s.trim()).filter(Boolean);
    const has = (name) => directives.some(d => d === name || d.startsWith(`${name}=`));

    if (has('no-store')) return { tier: 'none', maxAgeSeconds: null };

    let maxAgeSeconds = null;
    for (const name of ['s-maxage', 'max-age']) {
        const hit = directives.find(d => d.startsWith(`${name}=`));
        if (!hit) continue;
        const n = Number(hit.slice(name.length + 1).replace(/"/g, ''));
        if (!Number.isFinite(n) || n < 0) continue;
        // s-maxage wins where both are present, which is why it is tried first.
        maxAgeSeconds = maxAgeSeconds === null ? n : Math.min(maxAgeSeconds, n);
        break;
    }
    if (maxAgeSeconds === 0) return { tier: 'none', maxAgeSeconds: 0 };

    // `private` and `no-cache` both mean "do not keep this where a later run
    // can read it". Within one run the answer is still the same answer, so the
    // memo — which dies with the run and cannot cross a replica — stays open.
    if (has('private') || has('no-cache')) return { tier: 'memo', maxAgeSeconds };

    return { tier: 'both', maxAgeSeconds };
}

/**
 * May this response be kept at all, and in which tier?
 * → { tier: 'none' | 'memo' | 'both', maxAgeSeconds }
 */
function storability(out) {
    if (!out || typeof out !== 'object') return { tier: 'none', maxAgeSeconds: null };
    // 2xx only. `ok` alone would already exclude 3xx, but a 304 arrives with
    // ok=false on some shims and the explicit bound says what is meant.
    if (!out.ok || !(out.status >= 200 && out.status < 300)) return { tier: 'none', maxAgeSeconds: null };
    if (out.truncated) return { tier: 'none', maxAgeSeconds: null };
    const lower = {};
    for (const [k, v] of Object.entries(out.headers || {})) lower[String(k).toLowerCase()] = v;
    for (const name of CREDENTIAL_RESPONSE_HEADERS) {
        if (lower[name] !== undefined && lower[name] !== null) return { tier: 'none', maxAgeSeconds: null };
    }
    return parseCacheControl(lower);
}

/** The validators a conditional GET reissues, or null when the origin gave none. */
function validatorsOf(out) {
    const lower = {};
    for (const [k, v] of Object.entries((out && out.headers) || {})) lower[String(k).toLowerCase()] = v;
    const etag = typeof lower.etag === 'string' && lower.etag ? lower.etag : null;
    const lastModified = typeof lower['last-modified'] === 'string' && lower['last-modified'] ? lower['last-modified'] : null;
    if (!etag && !lastModified) return null;
    return { etag, lastModified };
}

// ── THE VISIBLE TIER: `step.cacheInto` ──────────────────────────────
//
// The same answer, kept somewhere a PERSON can look at it. `askOnce` stores an
// AES-GCM blob under a hashed key with a one-hour ceiling and no reader but the
// runner; `cacheInto` writes an ordinary row into an ordinary datatable, which
// the author can browse, correct, export and read from another automation — and
// which the ordinary retention sweeper expires. One mechanism, two features:
// the table's `retention_days` IS the expiry.
//
// TWO THINGS ARE DELIBERATELY NOT WRITTEN, and they are the whole reason this
// tier needed its own decision rather than mirroring the durable one:
//
//   THE RESOLVED URL. execOutbound interpolates `step.url` against RAW
//   runState, so `{{secrets.api_key}}` resolves INTO it — the single commonest
//   auth shape for exactly the keyword APIs this targets. These are plaintext,
//   org-readable, CSV-exportable columns, so the query string is dropped
//   entirely and lives only inside the hashed `cache_key`. `secretValues` is
//   scanned on top of that, because a key can sit in a path segment too.
//
//   THE RAW PRE-GUARD BODY. What is stored is the value the Privacy Shield has
//   already been through — see storeInto. Raw storage is defensible for an
//   encrypted store with a one-hour TTL and no human reader; it is not
//   defensible for plaintext columns with a thirty-day window, an org audience
//   and an export button. The consequence is stated where it bites: under a
//   TOKENISING policy the row holds the tokenised text, so a later run is
//   served the redacted answer. That is the correct trade for a table
//   colleagues can read, and it is why the editor says so in words.

/**
 * The step's `cacheInto`, normalised — or null, which means the tick is off.
 *
 * `maxAgeDays` is clamped rather than refused: the validator is where an author
 * finds out that 4000 is not a number of days, and by the time the runner has
 * the step in its hands, refusing the whole call over it would only turn a
 * cache setting into a broken automation.
 */
function readCacheInto(step) {
    const c = step && step.cacheInto;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const datatableId = typeof c.datatableId === 'string' ? c.datatableId.trim() : '';
    if (!datatableId) return null;
    const n = Math.floor(Number(c.maxAgeDays));
    return {
        datatableId,
        maxAgeDays: Number.isFinite(n) && n >= 1 ? Math.min(n, CACHE_INTO_MAX_DAYS) : CACHE_INTO_DEFAULT_DAYS,
    };
}

/**
 * Resolve the table and the caller's grade.
 *
 * EDITOR, not viewer, even though a hit only reads: a step that could serve
 * from the table but never refill it would look like it worked and quietly
 * re-ask the paid API for ever. And unlike every other failure in this module,
 * this one THROWS rather than degrading to a miss — the author named a
 * specific table, so "you may not use it" is a configuration error they have to
 * see, carrying the datatable error class their on_error branch already
 * matches, not an HTTP one.
 */
async function openInto(cfg, ctx) {
    const { resolveDatatableForStep } = require('./datatableResolve');
    const accessFilter = require('../dataEngine/accessFilter');
    const resolved = await resolveDatatableForStep(cfg.datatableId, ctx, { needed: 'editor' });
    return {
        ...resolved,
        maxAgeMs: cfg.maxAgeDays * 24 * 60 * 60 * 1000,
        // Compiled once here so a read and a write cannot end up scoped
        // differently, and so the compiler is never called unscoped.
        readFilter: accessFilter.compileAccessFilter(
            resolved.tableMeta, resolved.grade, { id: ctx.userId }, 'read', PG,
        ),
        updateFilter: accessFilter.compileAccessFilter(
            resolved.tableMeta, resolved.grade, { id: ctx.userId }, 'update', PG,
        ),
    };
}

/**
 * The stored answer, if there is one and it is young enough.
 *
 * Rebuilt into the SAME shape a live call produces, minus `data`: the caller
 * re-derives that with whatever `parseResponse` the step carries now, exactly
 * as it does for the other two tiers.
 */
async function readInto(into, key) {
    const queryCompiler = require('../dataEngine/queryCompiler');
    const datatableDbStore = require('../../stores/datatableDbStore');
    const compiled = queryCompiler.compileRecordList(into.tableMeta, {
        filters: [{ field: 'cache_key', op: 'eq', value: key }],
        limit: 1, dialect: 'pg',
    }, into.readFilter);
    const res = await datatableDbStore.query(into.scopeKey, into.scopeKey, compiled.sql, compiled.params);
    // compileRecordList asks for limit+1 as its cursor probe; the extra row is
    // never part of the answer.
    const row = (res.rows || [])[0];
    if (!row) return null;
    const fetchedAt = row.fetched_at ? new Date(row.fetched_at).getTime() : NaN;
    // An undated row is not an expired one, but it is not a servable one
    // either: without a date there is no window to be inside. Somebody edited
    // it by hand, and the honest answer is to ask the service again.
    if (!Number.isFinite(fetchedAt)) return null;
    if (Date.now() - fetchedAt > into.maxAgeMs) return null;

    const status = Number(row.response_status);
    if (!Number.isFinite(status)) return null;
    let headers = {};
    try {
        const parsed = JSON.parse(row.response_headers || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = parsed;
    } catch { /* a hand-edited header cell is not worth failing a run over */ }
    return {
        status,
        ok: status >= 200 && status < 300,
        headers,
        body: String(row.response_body ?? ''),
        // Always false: a truncated response is never stored (storability
        // refuses it), so a stored one cannot be a clipped document.
        truncated: false,
    };
}

/**
 * Remember an answer as a ROW.
 *
 * @param {object} plan          the lookup plan
 * @param {object} out           the PRE-guard response — what decides eligibility
 * @param {object} storedValue   the POST-guard response — what is actually written
 * @param {object} [opts]
 * @param {string[]} [opts.secretValues]  every secret this run can see
 * @returns {Promise<{stored: boolean, reason?: string, errorClass?: string, message?: string}|null>}
 *
 * A refusal here is NEVER a failed step. The call succeeded and the answer is
 * in hand; a full table or an over-large body means the next run asks again,
 * which is the behaviour before this feature existed. The reason is reported so
 * the caller can surface it rather than leaving a tick that silently does
 * nothing.
 */
async function storeInto(plan, out, storedValue, { secretValues = [] } = {}) {
    if (!plan || !plan.into) return null;
    const into = plan.into;

    // The identical refusal matrix the invisible tier uses — 2xx only, never
    // truncated, never a response that establishes a session, Cache-Control as
    // a ceiling. `both` and not merely `not none`: `private`/`no-cache` mean
    // "do not keep this where a LATER run can read it", and a datatable row is
    // the most readable place there is.
    const { tier } = storability(out);
    if (tier !== 'both') return { stored: false, reason: 'not_cacheable' };

    const value = (storedValue && typeof storedValue === 'object') ? storedValue : out;
    const body = String(value.body ?? '');
    // Refused, never truncated: a clipped body replayed as a whole one is the
    // BFSF-360 failure, where the next collection step reports "arrayRef did
    // not resolve to an array" about data that was fine when it arrived.
    if (Buffer.byteLength(body, 'utf8') > HTTP_MAX_ENTRY_BYTES) {
        return { stored: false, reason: 'too_large' };
    }

    // scheme+host, and the path with its QUERY STRING DROPPED. See the tier
    // comment above: the query is where an API key lives.
    const requestHost = plan.parsedOrigin || '';
    const requestPath = plan.parsedPath || '';
    const needles = (Array.isArray(secretValues) ? secretValues : []).filter(v => typeof v === 'string' && v);
    if (needles.length) {
        // Same rule execDatatable states as refusal #4 — a credential must
        // never become a permanent row — applied to the two places one can
        // still reach: a key in a PATH segment rather than the query, and a
        // service that echoes what it was sent.
        const surfaces = [requestHost, requestPath, body];
        if (surfaces.some(s => needles.some(n => s.includes(n)))) {
            return { stored: false, reason: 'secret_in_answer' };
        }
    }

    const queryCompiler = require('../dataEngine/queryCompiler');
    const datatableDbStore = require('../../stores/datatableDbStore');
    const datatableStore = require('../../stores/datatableStore');
    const { assertDatatableQuota } = require('../dataEngine/datatableLimits');

    // A Solution stage's reference table: its rows are the release's and the
    // upsert below would be refused (RowsLockedError). Named as such, never as
    // a quota or a write failure, and still not a failed step.
    try { queryCompiler.assertRowsWritable(into.tableMeta); } catch (e) {
        return { stored: false, reason: 'managed_part', errorClass: e.errorClass, message: e.message };
    }

    // Is this a refresh or a new answer? Asked with compileKeyIndex, which is
    // exactly the (key → id) probe it exists for. Only the COUNTER and the
    // quota depend on the answer — the write below is an upsert either way, so
    // a racer landing between the two cannot produce a duplicate.
    let existing = null;
    try {
        const probe = queryCompiler.compileKeyIndex(into.tableMeta, 'cache_key', [plan.memoKey], into.readFilter, PG);
        const found = await datatableDbStore.query(into.scopeKey, into.scopeKey, probe.sql, probe.params);
        existing = (found.rows || [])[0] || null;
    } catch (e) {
        log.warn('[AutomationRunner] cacheInto probe failed:', e.message);
    }

    if (!existing) {
        // The SAME storage envelope every other datatable write answers to. A
        // full table refuses the row and lets the run carry on with the live
        // answer — amber, never fatal.
        try {
            await assertDatatableQuota(into.scope, { table: into.table, addRows: 1 });
        } catch (e) {
            return { stored: false, reason: e.errorClass === 'datatable_quota' ? 'quota' : 'refused', message: e.message };
        }
    }

    const values = {
        cache_key: plan.memoKey,
        request_host: requestHost,
        request_path: requestPath,
        request_method: plan.method || 'GET',
        response_status: Number(value.status) || 0,
        response_body: body,
        response_headers: JSON.stringify(value.headers || {}),
        fetched_at: new Date().toISOString(),
    };
    try {
        const upsert = queryCompiler.compileUpsertByKey(into.tableMeta, 'cache_key', values, into.updateFilter, {
            createdBy: plan.userId, orgId: into.orgId, dialect: 'pg',
        });
        await datatableDbStore.exec(into.scopeKey, into.scopeKey, upsert.sql, upsert.params);
        await datatableStore.bumpAfterWrite(into.table.id, into.scope, existing ? 0 : 1);
    } catch (e) {
        // A cache write is never worth failing a step for — the caller already
        // has the answer it went out for.
        log.warn('[AutomationRunner] cacheInto write failed:', e.message);
        return { stored: false, reason: 'write_failed', message: e.message };
    }
    return { stored: true, refreshed: !!existing };
}

/**
 * Everything the http path needs to know before it dispatches — or `null`,
 * which means "this call was never eligible" and is NOT a miss.
 *
 * `null` and a plan with `served: null` are deliberately different: only the
 * second one counts a miss, so an automation nobody ticked never reports reuse
 * doing nothing.
 */
async function lookup({
    step, ctx, mode, method, blockPrivateTargets,
    policy, destination, parsedUrl, sendUrl, sendBody, headers,
    authInjectedHeaders = null, credentialFingerprint = null,
    connectionId = null, grantId = null,
}) {
    const memo = ctx && ctx._toolMemo;
    // The visible tier is independent of the run memo: an author who ticked
    // only "remember answers in a table" gets it whether or not this run has
    // one, and the memo-backed tiers below each guard on `plan.memo`.
    const into = readCacheInto(step);
    // envFlagOn, not bare truthiness: `AUTOMATION_ASK_ONCE_DISABLED=0` is a
    // non-empty string, so `!process.env.X` would read an operator's "leave it
    // on" as "switch it off". It brakes BOTH tiers — an operator switching
    // reuse off during an incident means all of it.
    const wants = (!!memo && !!step.askOnce) || !!into;
    const eligible = wants
        && mode !== 'dry_run'
        && CACHEABLE_METHODS.has(method)
        && blockPrivateTargets !== false
        && !envFlagOn('AUTOMATION_ASK_ONCE_DISABLED')
        && safety.egressMode(policy, destination) === 'real';
    if (!eligible) return null;

    // toolMemo.memoKeyParts stays the SINGLE producer of the identity string,
    // unchanged and still 'v1'. `toolName: 'http_request'` already namespaces
    // the key, so no catalog-tool row can collide with an http row and no
    // stored durable answer is invalidated by this feature shipping.
    //
    // The args are the GUARDED url/headers/body — what actually travels, not
    // what the author typed. `step.parseResponse` is deliberately absent: the
    // stored value is the PRE-parse `out`, and the hit re-runs parseHttpBody
    // with this step's setting.
    const identity = memoKeyParts({
        toolName: 'http_request',
        stepUserId: ctx.userId,
        stepOrgId: ctx.orgId,
        connectionId,
        grantId,
        integrationServer: parsedUrl.origin,
        destination,
        policyAction: policy && policy.action,
        policyScope: policy && policy.privacyScope,
        args: {
            method,
            url: sendUrl,
            headers: canonicalHeaders(headers, authInjectedHeaders, credentialFingerprint),
            body: sendBody === undefined ? null : sendBody,
        },
    });

    const plan = {
        memo,
        memoKey: memoKeyFromParts(identity),
        memoTtlMs: stepTtlMs(step.askOnce),
        // The durable row carries an owner, because erasure has to be able to
        // find it: a cached answer was fetched with this person's credentials
        // and is about the things they can see.
        userId: ctx.userId,
        hostname: parsedUrl.hostname,
        method,
        // The REDACTED url, split for the two visible columns and built here so
        // there is one definition of "what may be written down" rather than one
        // per call site. `origin` is scheme+host(+port) — http and https are
        // different endpoints — and `pathname` deliberately excludes `search`.
        parsedOrigin: parsedUrl.origin,
        parsedPath: parsedUrl.pathname,
        durable: null,
        into: null,
        served: null,
        revalidate: null,
    };

    // ── The DURABLE tier — three switches, all of which must say yes ──
    //
    // `!memo.hasSlept()`: a Wait clears the run memo precisely so the next
    // look-up asks again. Without this the call falls THROUGH to the durable
    // cache and is handed the very answer the clear was meant to discard.
    //
    // `scopes.http`: an admin who consented to "what an app answers may be
    // stored" did not consent to arbitrary outbound HTTP. One key, two ticks.
    const slept = !!memo && memo.hasSlept();
    if (!!memo && !slept && typeof step.askOnce === 'object'
        && step.askOnce.acrossRuns === true && ctx.orgId) {
        try {
            const cachePolicy = await resolveCachePolicy(ctx.orgId);
            if (cachePolicy.enabled && cachePolicy.scopes && cachePolicy.scopes.http === true) {
                const store = require('../../stores/integrationCacheStore');
                const stepTtlSeconds = plan.memoTtlMs ? Math.round(plan.memoTtlMs / 1000) : null;
                plan.durable = {
                    store,
                    key: store.cacheKey(identity),
                    organizationId: ctx.orgId,
                    stepTtlSeconds,
                    ttlSeconds: Math.min(cachePolicy.ttlSeconds, stepTtlSeconds ?? cachePolicy.ttlSeconds),
                };
            }
        } catch (e) {
            // A cache that cannot be consulted is a miss, never an error: the
            // only correct response is to make the call for real.
            log.warn('[AutomationRunner] http durable cache unavailable:', e.message);
            plan.durable = null;
        }
    }

    const fromMemo = memo ? memo.peek(plan.memoKey) : undefined;
    if (fromMemo !== undefined) {
        plan.served = { tier: 'run', out: fromMemo };
        return plan;
    }

    // The VISIBLE tier is opened whether or not it will SERVE, because the
    // write needs it too — a miss here is the reason the table gets filled at
    // all. Opening it can THROW (a table this automation may not write to), and
    // that throw is deliberate: see openInto.
    //
    // Below the memo peek, not above it, because the motivating shape is a
    // forEach over 200 rows: resolving the table, its grants and its columns
    // per iteration would be 600 queries to re-decide a question this run
    // answered on its first iteration. A memo hit is an answer already
    // authorised moments ago in this same run; every other path resolves
    // afresh, next to a real HTTP call that dwarfs it.
    if (into) plan.into = await openInto(into, ctx);

    // maxAgeSeconds is the window as it stands NOW — expires_at was stamped at
    // write time, so an admin who shortened it after noticing stale data would
    // otherwise keep being served the old answers until the OLD expiry.
    let row = null;
    if (plan.durable) {
        try {
            row = await plan.durable.store.get(plan.durable.key, plan.durable.organizationId, {
                maxAgeSeconds: plan.durable.ttlSeconds,
            });
        } catch (e) {
            log.warn('[AutomationRunner] http durable cache read failed:', e.message);
        }
    }
    if (row) {
        plan.served = { tier: 'stored', out: row.value };
        // Written back so the rest of THIS run answers from memory rather than
        // the database.
        plan.memo.recordDurableHit();
        plan.memo.store(plan.memoKey, row.value, plan.memoTtlMs, HTTP_MAX_ENTRY_BYTES);
        return plan;
    }

    // The table, AFTER both invisible tiers have missed — it is the widest
    // window, so consulting it first would hand back a month-old answer while a
    // fresher one sat in the encrypted store.
    //
    // `slept` applies here for the same reason it applies to the durable tier: a
    // Wait clears the run memo precisely so the next look-up asks again, and
    // falling through to a stored row hands back the very answer the clear was
    // meant to discard. The row is still REFRESHED on the way out, so the table
    // does not go stale — only this call pays for a real request.
    if (plan.into && !slept) {
        let stored = null;
        try {
            stored = await readInto(plan.into, plan.memoKey);
        } catch (e) {
            // Consistent with every other read here: a cache that cannot be
            // consulted is a miss. The AUTHORISATION half already threw, above.
            log.warn('[AutomationRunner] cacheInto read failed:', e.message);
        }
        if (stored) {
            plan.served = { tier: 'table', out: stored };
            if (memo) memo.store(plan.memoKey, stored, plan.memoTtlMs, HTTP_MAX_ENTRY_BYTES);
            return plan;
        }
    }
    if (!plan.durable) return plan;

    // ── Conditional revalidation ────────────────────────────────────
    //
    // The only mechanism here that CANNOT serve a stale answer, and the one
    // that would earn a longer window later. An entry whose TTL has lapsed but
    // which is still inside a one-TTL grace window is reissued as the same GET
    // with If-None-Match / If-Modified-Since: a 304 refreshes its expiry and
    // returns the stored body, a 200 replaces it. Either way it is a REAL call,
    // so a real egress row is written.
    let stale = null;
    try {
        stale = await plan.durable.store.getStale(plan.durable.key, plan.durable.organizationId, {
            graceSeconds: plan.durable.ttlSeconds,
        });
    } catch (e) {
        log.warn('[AutomationRunner] http durable cache stale read failed:', e.message);
    }
    const validators = stale ? validatorsOf(stale.value) : null;
    if (stale && validators) {
        plan.revalidate = { out: stale.value, headers: {} };
        if (validators.etag) plan.revalidate.headers['If-None-Match'] = validators.etag;
        if (validators.lastModified) plan.revalidate.headers['If-Modified-Since'] = validators.lastModified;
    }
    return plan;
}

/**
 * A 304 answered the conditional GET: the stored body is still current. Push
 * its expiry out by one window and hand it back.
 *
 * `touch` also resets created_at, because `get`'s maxAgeSeconds check is on
 * created_at and the origin has just said this body is current NOW.
 */
async function refresh(plan) {
    if (!plan || !plan.revalidate) return null;
    if (plan.durable) {
        try {
            await plan.durable.store.touch(plan.durable.key, plan.durable.organizationId, plan.durable.ttlSeconds);
        } catch (e) {
            log.warn('[AutomationRunner] http durable cache touch failed:', e.message);
        }
    }
    // The run memo takes it too, so the rest of this run does not reissue the
    // conditional GET once per loop iteration.
    if (plan.memo) plan.memo.store(plan.memoKey, plan.revalidate.out, plan.memoTtlMs, HTTP_MAX_ENTRY_BYTES);
    return plan.revalidate.out;
}

/**
 * Remember an answer. `out` is the PRE-parse response object, so a later hit
 * can re-derive `data` under whatever `parseResponse` the step carries then.
 *
 * Returns 'both' | 'memo' | null describing what was actually kept, so a caller
 * can tell "not stored" from "stored" without re-deriving the policy.
 */
async function store(plan, out) {
    if (!plan) return null;
    const { tier, maxAgeSeconds } = storability(out);
    if (tier === 'none') return null;

    // Snapshotted, not referenced. The caller adds `out.data` a few lines
    // later, and the durable write below is detached — without this copy the
    // stored value would be the POST-parse object, and `parseResponse` would
    // effectively become part of the cached answer while staying out of the key.
    const snapshot = { ...out };
    // The run memo takes it whichever tick is on. "Remember this answer for
    // thirty days" plainly includes "for the rest of this run", and answering
    // the second iteration of a loop from memory rather than from the database
    // is the same answer for less work. `plan.memo` is only absent when the run
    // has no memo at all — the visible tier does not require one.
    if (plan.memo) plan.memo.store(plan.memoKey, snapshot, plan.memoTtlMs, HTTP_MAX_ENTRY_BYTES);
    if (tier !== 'both' || !plan.durable) return plan.memo ? 'memo' : null;

    // The org policy is re-read WITHOUT the 30-second memo before the row is
    // written. invalidateCachePolicy is in-process only, so a replica that has
    // not seen the admin's "switch it off and delete everything" would
    // otherwise refill the table right behind them.
    //
    // Not awaited on the critical path — a slow write must not slow the step,
    // and a failed one is only a future miss.
    (async () => {
        const fresh = await resolveCachePolicyFresh(plan.durable.organizationId);
        if (!fresh.enabled || !fresh.scopes || fresh.scopes.http !== true) return;
        // Cache-Control is a ceiling, never an extension: min(step, org, max-age).
        let ttlSeconds = Math.min(fresh.ttlSeconds, plan.durable.stepTtlSeconds ?? fresh.ttlSeconds);
        if (Number.isFinite(maxAgeSeconds) && maxAgeSeconds !== null) ttlSeconds = Math.min(ttlSeconds, maxAgeSeconds);
        if (!(ttlSeconds >= 1)) return;
        await plan.durable.store.put({
            key: plan.durable.key,
            organizationId: plan.durable.organizationId,
            // PROVENANCE: the hostname, never the URL. execOutbound interpolates
            // `step.url` against RAW runState, so a `{{secrets.api_key}}`
            // resolves INTO it — the standard shape for keyed REST APIs — and
            // tool_name is a plaintext column an admin screen can read.
            toolName: `http:${plan.hostname || ''}`,
            userId: plan.userId,
            value: snapshot,
            ttlSeconds,
            maxBytes: HTTP_MAX_ENTRY_BYTES,
        });
    })().catch(() => { /* a cache write is never worth failing a step */ });
    return 'both';
}

module.exports = {
    lookup, refresh, store,
    // The visible tier — `step.cacheInto`.
    readCacheInto, storeInto,
    canonicalHeaders, parseCacheControl, storability, validatorsOf,
    CACHEABLE_METHODS, CREDENTIAL_RESPONSE_HEADERS, HTTP_MAX_ENTRY_BYTES,
    CACHE_INTO_DEFAULT_DAYS, CACHE_INTO_MAX_DAYS,
};
