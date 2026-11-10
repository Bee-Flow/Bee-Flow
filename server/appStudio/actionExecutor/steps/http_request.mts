/**
 * The `http_request` step: one call to a web service through a `rest` connector of the app.
 *
 * Order (each stage answers the step itself; nothing is thrown at the caller on purpose):
 *   1. the connector: it must be a `rest` connector of THIS app's data model; its URL gives
 *      the origin, and the step has no way to name another one (httpRequest/request.mts);
 *   2. the request: path placeholders filled URL-encoded, query, the author's headers
 *      (identity and framing headers refused, as is any header the connector sets), body;
 *   3. a dry run (app_run_action with dryRun) stops here for a write and says what it would send;
 *   4. the privacy check over everything authored that would leave (httpRequest/shield.mts):
 *      a finding fails the step with `pii_blocked`, there is no override;
 *   5. the connector's fixed headers and the owner's stored credential are added last, so a
 *      step can neither read nor replace them;
 *   6. the call: safeFetch (private and internal addresses refused at every connect),
 *      redirects followed by hand and only within the same origin, a time limit, and at most
 *      1 MB of answer;
 *   7. one row in the integration ledger.
 *
 * A write is answered `retryable: false` when it failed after it may have been sent and the
 * step carries no idempotencyKey: the walkers never repeat it on their own.
 */

import { createRequire } from 'node:module';

import { BODY_FORMATS, authoredHeaders, buildUrl, connectorOrigin, encodeBody, isWrite, plainBody, plainPath, queryPairs, HTTP_METHODS } from '../httpRequest/request.mts';
import type { Obj, Refusal, RestConnector } from '../httpRequest/request.mts';
import { fillPath, fillStatic, templateRoots } from '../httpRequest/template.mts';
import { checkOutbound, logCall, openShield } from '../httpRequest/shield.mts';
import type { ShieldApp, ShieldDeps, ShieldSession } from '../httpRequest/shield.mts';

const nodeRequire = createRequire(import.meta.url);

type StepResult = { ok: boolean; result?: unknown; error?: string; code?: string; retryable?: boolean; notes?: string[] };
type FetchResponse = { status: number; ok?: boolean; headers: { get(name: string): string | null }; body?: unknown; text?: () => Promise<string> };
type FetchImpl = (url: string | URL, init: RequestInit) => Promise<FetchResponse>;
type Captured<T> = { ok: boolean; value?: T; error?: unknown; probe?: unknown };

export type HttpStepDeps = ShieldDeps & {
    safeFetch: FetchImpl;
    isPrivateTarget: (url: string) => boolean;
    isPrivateAddressError: (e: unknown) => boolean;
    getProviderAuth: (userId: string, provider: string) => Promise<{ accessToken?: string | null } | null>;
    capture: <T>(fn: () => Promise<T>) => Promise<Captured<T>>;
    env: Record<string, string | undefined>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_IDEMPOTENCY_KEY_CHARS = 200;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (code: string, error: string, retryable = false, result?: unknown): StepResult => ({ ok: false, code, error, retryable, ...(result !== undefined ? { result } : {}) });
const refused = (r: Refusal): StepResult => fail(r.code, r.error);

/** A whole number of 0 or more from the environment; unset or invalid gives `fallback`. 0 means no limit. */
function limitFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function defaultDeps(): HttpStepDeps {
    const guard = nodeRequire('../../../utils/ssrfGuard.js') as { safeFetch: FetchImpl; isPrivateAddressError: (e: unknown) => boolean };
    return {
        safeFetch: guard.safeFetch,
        isPrivateAddressError: guard.isPrivateAddressError,
        isPrivateTarget: (url) => (nodeRequire('../../../utils/isPrivateTarget.js') as { isPrivateTarget: (u: string) => boolean }).isPrivateTarget(url),
        getProviderAuth: (userId, provider) => (nodeRequire('../../../auth/automationAuth.js') as { getProviderAuth: HttpStepDeps['getProviderAuth'] }).getProviderAuth(userId, provider),
        capture: (fn) => (nodeRequire('../../../core/http/captureCall.js') as { captureCall: HttpStepDeps['capture'] }).captureCall(fn),
        env: process.env,
    };
}

type Shared = {
    findConnector: (model: unknown, id: unknown) => RestConnector | null;
    buildServerScope: (ctx: Obj) => unknown;
    resolveBinding: (binding: unknown, ctx: Obj, scope: unknown) => unknown;
};

function shared(): Shared {
    const connectors = nodeRequire('../../connectors/shared.js') as { findConnector: Shared['findConnector'] };
    const exec = nodeRequire('../shared.js') as { buildServerScope: Shared['buildServerScope']; resolveBinding: Shared['resolveBinding'] };
    return { findConnector: connectors.findConnector, buildServerScope: exec.buildServerScope, resolveBinding: exec.resolveBinding };
}

type Prepared = {
    connector: RestConnector; origin: string; method: string; url: URL; path: string;
    pairs: Array<[string, string]>; headers: Record<string, string>;
    bodyText: string | undefined; contentType: string | null; idempotencyKey: string | null;
};

/** `{ name: binding }` resolved to `{ name: value }`. */
function resolveMap(map: unknown, ctx: Obj, scope: unknown, s: Shared): Obj {
    const out: Obj = {};
    if (!isObject(map)) return out;
    for (const [name, binding] of Object.entries(map)) out[name] = s.resolveBinding(binding, ctx, scope);
    return out;
}

/**
 * A static JSON text with its placeholders filled. The text is parsed BEFORE anything is filled
 * in, so a value can only ever land inside the text leaf that names it and never adds a key or
 * closes a quote. A text that is not JSON is handed on as it is and refused by the encoder.
 */
function fillJsonText(text: string, ctx: Obj): unknown {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return text; }
    const filled = fillStatic(parsed, templateRoots(ctx));
    // The encoder reads a text as JSON an author wrote: a filled text leaf goes back in as JSON.
    return typeof filled === 'string' ? JSON.stringify(filled) : filled;
}

/** The body's value: a static body has its placeholders filled, any other binding is data as it is. */
function bodyValue(binding: unknown, format: string, ctx: Obj, scope: unknown, s: Shared): unknown {
    if (isObject(binding) && binding.kind === 'static') {
        if (format === 'json' && typeof binding.value === 'string') return fillJsonText(binding.value, ctx);
        return fillStatic(binding.value, templateRoots(ctx));
    }
    return s.resolveBinding(binding, ctx, scope);
}

function idempotencyKeyOf(step: Obj, ctx: Obj, scope: unknown, s: Shared): { ok: true; key: string | null } | Refusal {
    if (step.idempotencyKey === undefined || step.idempotencyKey === null) return { ok: true, key: null };
    const value = s.resolveBinding(step.idempotencyKey, ctx, scope);
    const text = typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value).trim() : '';
    if (!text || text.length > MAX_IDEMPOTENCY_KEY_CHARS) return { ok: false, code: 'http_bad_input', error: `idempotencyKey must resolve to a text or number of 1 to ${MAX_IDEMPOTENCY_KEY_CHARS} characters.` };
    for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (c < 0x21 || c > 0x7e) return { ok: false, code: 'http_bad_input', error: 'idempotencyKey may hold only visible ASCII characters without spaces.' };
    }
    return { ok: true, key: text };
}

/** Stages 1 and 2: the connector and the request, with nothing sent and no credential read. */
function prepare(model: unknown, step: Obj, ctx: Obj, deps: HttpStepDeps): { ok: true; req: Prepared } | StepResult {
    const s = shared();
    const connector = s.findConnector(model, step.connectorId);
    if (!connector || connector.kind !== 'rest') return fail('http_connector_missing', 'This step names a connection that is not a REST connection of this app.');
    const origin = connectorOrigin(connector);
    if (!origin) return fail('http_connector_invalid', 'The connection has no usable https address.');
    if (step.method !== undefined && (typeof step.method !== 'string' || !HTTP_METHODS.includes(step.method))) return fail('http_bad_input', `method must be one of ${HTTP_METHODS.join(', ')}.`);
    const method = typeof step.method === 'string' ? step.method : 'GET';

    const scope = s.buildServerScope(ctx);
    const filled = fillPath(typeof step.path === 'string' && step.path ? step.path : '/', templateRoots(ctx));
    if (!filled.ok) return fail('http_bad_input', filled.error);
    const pairs = queryPairs(resolveMap(step.query, ctx, scope, s));
    if (!pairs.ok) return refused(pairs);
    const url = buildUrl(origin, filled.path, pairs.pairs);
    if (!url.ok) return refused(url);
    const headers = authoredHeaders(resolveMap(step.headers, ctx, scope, s), connector);
    if (!headers.ok) return refused(headers);
    const format = typeof step.bodyFormat === 'string' && BODY_FORMATS.includes(step.bodyFormat) ? step.bodyFormat : 'json';
    const body = encodeBody(step.body === undefined ? null : bodyValue(step.body, format, ctx, scope, s), format, method);
    if (!body.ok) return refused(body);
    const maxBody = limitFromEnv(deps.env, 'STUDIO_APP_HTTP_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES);
    if (maxBody && body.text !== undefined && Buffer.byteLength(body.text, 'utf8') > maxBody) {
        return fail('http_body_too_large', `The body is larger than ${maxBody} bytes (STUDIO_APP_HTTP_MAX_BODY_BYTES=${maxBody}).`);
    }
    const key = idempotencyKeyOf(step, ctx, scope, s);
    if (!key.ok) return refused(key);
    return {
        ok: true,
        req: { connector, origin, method, url: url.url, path: filled.path, pairs: pairs.pairs, headers: headers.headers, bodyText: body.text, contentType: body.contentType, idempotencyKey: key.key },
    };
}

/** What a dry run says about a write instead of sending it. */
function simulated(req: Prepared): StepResult {
    return {
        ok: true,
        result: {
            simulated: true, status: null, body: null,
            wouldSend: { method: req.method, url: req.url.href, headers: Object.keys(req.headers), body: req.bodyText === undefined ? null : req.bodyText.slice(0, 2000) },
        },
        notes: [`dryRun: ${req.method} ${req.url.origin}${req.url.pathname} was not sent (a write is simulated; the privacy check and the credential were not used)`],
    };
}

/**
 * Everything authored that would leave, as texts for the privacy check. The path and a form
 * body are handed over as their values read, not URL-encoded: an encoded value is not what
 * the check knows how to recognise.
 */
function outboundTexts(req: Prepared): string[] {
    return [
        plainPath(req.path),
        ...req.pairs.map(([name, value]) => `${name}=${value}`),
        ...Object.values(req.headers),
        plainBody(req.bodyText, req.contentType),
        req.idempotencyKey ?? '',
    ];
}

/** Stage 5: the author's headers, then what the connector fixes, then the owner's credential. */
async function finalHeaders(app: ShieldApp, req: Prepared, expectJson: boolean, deps: HttpStepDeps): Promise<{ ok: true; headers: Record<string, string> } | StepResult> {
    const headers: Record<string, string> = { Accept: expectJson ? 'application/json' : '*/*', ...req.headers };
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    if (req.bodyText !== undefined && req.contentType && !hasContentType) headers['Content-Type'] = req.contentType;
    if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;
    const fixed = isObject(req.connector.headers) ? req.connector.headers : {};
    for (const [name, value] of Object.entries(fixed)) {
        if (typeof value === 'string' || typeof value === 'number') headers[name] = String(value);
    }
    const auth = isObject(req.connector.auth) ? req.connector.auth : null;
    if (auth && typeof auth.credentialProvider === 'string' && auth.credentialProvider) {
        let token: string | null = null;
        try { token = (await deps.getProviderAuth(app.userId, auth.credentialProvider))?.accessToken || null; } catch { token = null; }
        if (!token) return fail('http_credential_unavailable', 'The credential of this connection is not available. The app owner reconnects it under Settings.');
        if (auth.type === 'header' && typeof auth.header === 'string' && auth.header) headers[auth.header] = token;
        else headers.Authorization = `Bearer ${token}`;
    }
    return { ok: true, headers };
}

type Answer = { status: number; text: string; truncated: boolean };

/** Stage 6: the call. A redirect is followed only while it stays on the connector's origin. */
async function send(req: Prepared, headers: Record<string, string>, deps: HttpStepDeps): Promise<Captured<Answer>> {
    const { fetchFollowingSameHost } = nodeRequire('../../../core/automationRunner/sameHostFetch.js') as {
        fetchFollowingSameHost: (f: FetchImpl, url: string, init: RequestInit) => Promise<FetchResponse>;
    };
    const { readBodyBounded, HTTP_RESPONSE_CAP } = nodeRequire('../../../core/http/httpResponseLimits.js') as {
        readBodyBounded: (r: FetchResponse, o: { charCap: number; stopOnOversizeHeader: boolean }) => Promise<{ text: string; truncated: boolean }>;
        HTTP_RESPONSE_CAP: number;
    };
    // The same-host follower compares host names; this pins scheme and port as well.
    const pinned: FetchImpl = async (target, init) => {
        if (new URL(String(target)).origin !== req.origin) throw new Error('redirected away from the connection');
        return deps.safeFetch(target, init);
    };
    const timeoutMs = limitFromEnv(deps.env, 'STUDIO_APP_HTTP_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const ac = new AbortController();
    const timer = timeoutMs ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
        return await deps.capture(async () => {
            const resp = await fetchFollowingSameHost(pinned, req.url.href, { method: req.method, headers, body: req.bodyText, signal: ac.signal });
            const read = await readBodyBounded(resp, { charCap: HTTP_RESPONSE_CAP, stopOnOversizeHeader: true });
            return { status: resp.status, text: read.text, truncated: read.truncated };
        });
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Why the call got no answer, as a step failure. Never the transport's own text. */
function sendFailure(error: unknown, mayRepeat: boolean, deps: HttpStepDeps): StepResult {
    if (deps.isPrivateAddressError(error)) return fail('http_private_target', 'The connection points at a private or internal address, which a step does not reach.');
    const e = error as { name?: unknown; message?: unknown };
    if (e && e.name === 'AbortError') return fail('http_timeout', 'The service did not answer in time.', mayRepeat);
    if (e && typeof e.message === 'string' && e.message.includes('redirect')) return fail('http_redirect_refused', 'The service redirected to another address; the credential is not sent there.');
    return fail('http_unreachable', 'The service could not be reached.', mayRepeat);
}

/** Stage 6, the answer: a status outside 200-299 fails the step, the body is read as `expect` says. */
function answerOf(answer: Answer, expectJson: boolean, mayRepeat: boolean): StepResult {
    const { status, text } = answer;
    if (answer.truncated) return fail('http_response_too_large', 'The answer is larger than 1 MB. Ask for less (a page, a narrower query).');
    if (status < 200 || status > 299) {
        return fail('http_status', `The service answered ${status}.`, mayRepeat && (status >= 500 || status === 429 || status === 408), { status });
    }
    if (!expectJson) return { ok: true, result: { status, body: text } };
    if (!text.trim()) return { ok: true, result: { status, body: null } };
    try {
        return { ok: true, result: { status, body: JSON.parse(text) } };
    } catch {
        return fail('http_not_json', 'The service did not answer with JSON. Set expect to "text" to read the answer as text.', false, { status });
    }
}

async function sendChecked(app: ShieldApp, req: Prepared, step: Obj, session: ShieldSession, deps: HttpStepDeps): Promise<StepResult> {
    const expectJson = step.expect !== 'text';
    // A GET, or a write that names itself, may be sent again; any other write may not.
    const mayRepeat = !isWrite(req.method) || req.idempotencyKey !== null;
    const headers = await finalHeaders(app, req, expectJson, deps);
    if (!('headers' in headers)) return headers;
    const startedAt = Date.now();
    const sent = await send(req, headers.headers, deps);
    const logged = { url: req.url.href, method: req.method, probe: sent.probe, ms: Date.now() - startedAt };
    if (!sent.ok || !sent.value) {
        await logCall(session, { ...logged, error: new Error('request failed') });
        return sendFailure(sent.error, mayRepeat, deps);
    }
    await logCall(session, { ...logged, status: sent.value.status });
    return answerOf(sent.value, expectJson, mayRepeat);
}

export async function runHttpRequest(app: ShieldApp, model: unknown, step: Obj, ctx: Obj, deps: HttpStepDeps = defaultDeps()): Promise<StepResult> {
    const prepared = prepare(model, step, ctx, deps);
    if (!('req' in prepared)) return prepared;
    const req = prepared.req;
    if (ctx.dryRun === true && isWrite(req.method)) return simulated(req);
    if (deps.isPrivateTarget(req.url.href)) return fail('http_private_target', 'The connection points at a private or internal address, which a step does not reach.');

    const session = await openShield(app, ctx.actionId, { origin: req.origin, hostname: req.url.hostname, write: isWrite(req.method) }, deps);
    const verdict = await checkOutbound(session, outboundTexts(req));
    // Nothing was sent, so trying again after an unavailable check is safe for a write too.
    if (!verdict.ok) return fail(verdict.code, verdict.error, verdict.code === 'pii_check_unavailable');
    return sendChecked(app, req, step, session, deps);
}

/** The registry entry point (actionExecutor/dispatch.js fileStepHandler). */
export async function runStep(app: unknown, model: unknown, step: unknown, ctx: unknown): Promise<StepResult> {
    return runHttpRequest(app as ShieldApp, model, step as Obj, (ctx ?? {}) as Obj);
}
