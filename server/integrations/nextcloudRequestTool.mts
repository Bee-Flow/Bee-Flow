/**
 * nextcloud_request: one OCS or WebDAV call to the user's own Nextcloud, for
 * the Nextcloud APIs no Bee Flow tool covers yet (an imported script that did a
 * single `fetch` against OCS lands here without AI).
 *
 *   { method, path, query?, body?, headers? }  ->  { status, ok, contentType, body, truncated }
 *
 * Automations only. The definition is not in NEXTCLOUD_TOOLS (the toolset chat,
 * agents, MCP and AI steps are offered); getIntegrationTools adds it for an
 * automation step alone, and the handler refuses a call from outside an
 * automation run as well.
 *
 * What keeps it narrow:
 *   - The request goes through the Nextcloud client the other tools use
 *     (connector, OAuth or app password), as the automation's owner. The uid
 *     comes from that identity, never from the arguments.
 *   - `path` is a path on the Nextcloud host, never a URL: it must start with
 *     one of /ocs/v1.php/, /ocs/v2.php/, /remote.php/dav/ or /index.php/apps/
 *     (the prefixes the connector proxies), with no "." or ".." segment, no
 *     empty segment, no encoded slash or backslash, no query or fragment.
 *     Each segment is decoded once and encoded again, so what is checked is
 *     what is sent.
 *   - Reads (GET, PROPFIND, REPORT) may go to any path under those prefixes,
 *     except the credential and trust paths in DENIED (app passwords, OAuth2
 *     clients, AppAPI, webhook registrations, user provisioning), which are
 *     refused for every method: their answers would land in the run output.
 *   - Writes only reach the paths of WRITE_RULES: the user's own Files tree,
 *     and OCS app paths that Bee Flow already writes to through its own tools.
 *     Everything else is refused (an owner who is a Nextcloud admin would
 *     otherwise reach every admin API). A MOVE or COPY destination must be in
 *     the user's own Files tree too.
 *   - Only the request headers of ALLOWED_HEADERS; X-HTTP-Method-Override and
 *     Authorization among the refused ones.
 *   - The answer is read within HTTP_RESPONSE_CAP and marked `truncated`.
 * All checks are plain string operations (no regular expression on request text).
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { readBodyBounded, HTTP_RESPONSE_CAP } = nodeRequire('../core/http/httpResponseLimits') as {
    readBodyBounded: (resp: unknown, opts?: { charCap?: number }) => Promise<{ text: string; truncated: boolean }>;
    HTTP_RESPONSE_CAP: number;
};

type NcResponse = { ok: boolean; status: number; headers?: { get?: (name: string) => string | null }; text: () => Promise<string>; body?: unknown };
type NcFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<NcResponse>;

export interface NcRequestCtx {
    baseUrl: string;
    ncFetch: NcFetch;
    authError: string;
    uid: string;
    /** Set by the automation runner only: the run, and the automation it belongs to. */
    runScope?: { runId: string; rootRunId?: string } | null;
    automationId?: string | null;
}

export interface NcRequestArgs { method?: unknown; path?: unknown; query?: unknown; body?: unknown; headers?: unknown }
export interface NcRequestResult { status: number; ok: boolean; contentType: string; body: unknown; truncated: boolean }

export const NC_REQUEST_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'REPORT', 'MKCOL', 'MOVE', 'COPY'];
export const NC_REQUEST_READ_METHODS: ReadonlySet<string> = new Set(['GET', 'PROPFIND', 'REPORT']);

const OCS_PREFIXES = ['/ocs/v1.php/', '/ocs/v2.php/'];
const ALLOWED_PREFIXES = [...OCS_PREFIXES, '/remote.php/dav/', '/index.php/apps/'];
const PATH_MAX = 2048;

/**
 * Refused for every method, compared on the lower-cased path. An OCS entry is
 * written once without the /ocs/v*.php part and checked under both versions.
 */
const DENIED_OCS = ['/core/getapppassword', '/core/apppassword', '/apps/oauth2', '/apps/provisioning_api', '/apps/webhook_listeners', '/apps/app_api'];
const DENIED_INDEX = ['/index.php/apps/oauth2', '/index.php/apps/app_api', '/index.php/apps/webhook_listeners', '/index.php/apps/settings'];
export const DENIED: readonly string[] = [
    ...OCS_PREFIXES.flatMap((v) => DENIED_OCS.map((p) => v.slice(0, -1) + p)),
    ...DENIED_INDEX,
];

interface WriteRule { prefix: string; methods: readonly string[]; ownTree?: boolean }
const OCS_WRITES: ReadonlyArray<{ path: string; methods: readonly string[] }> = [
    // Talk: post into a conversation (nextcloud_talk_send_message).
    { path: '/apps/spreed/api/v1/chat/', methods: ['POST'] },
    // Shares: create and update; revoking stays with nextcloud_delete_share.
    { path: '/apps/files_sharing/api/v1/shares', methods: ['POST', 'PUT'] },
    // Tables rows, Forms, Deck, own status (the families of the Tables / Forms / Deck / Status tools).
    { path: '/apps/tables/api/', methods: ['POST', 'PUT'] },
    { path: '/apps/forms/api/', methods: ['POST', 'PATCH'] },
    { path: '/apps/deck/api/', methods: ['POST', 'PUT'] },
    { path: '/apps/user_status/api/v1/user_status', methods: ['PUT', 'DELETE'] },
];
const INDEX_WRITES: readonly WriteRule[] = [
    { prefix: '/index.php/apps/deck/api/', methods: ['POST', 'PUT'] },
    { prefix: '/index.php/apps/tables/api/', methods: ['POST', 'PUT'] },
    { prefix: '/index.php/apps/notes/api/', methods: ['POST', 'PUT'] },
];
export const WRITE_RULES: readonly WriteRule[] = [
    ...OCS_PREFIXES.flatMap((v) => OCS_WRITES.map((w) => ({ prefix: v.slice(0, -1) + w.path, methods: w.methods }))),
    ...INDEX_WRITES,
    // File comments (nextcloud_add_file_comment) and tags on a file (nextcloud_tag_file).
    { prefix: '/remote.php/dav/comments/files/', methods: ['POST'] },
    { prefix: '/remote.php/dav/systemtags-relations/files/', methods: ['PUT', 'DELETE'] },
];
const OWN_TREE_WRITES = ['PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY'];

/** Request headers a caller may set, lower-cased. Everything else is refused. */
const ALLOWED_HEADERS: ReadonlySet<string> = new Set(['accept', 'content-type', 'depth', 'destination', 'overwrite', 'if-match', 'if-none-match', 'ocs-apirequest']);
const DEPTH_VALUES: ReadonlySet<string> = new Set(['0', '1']);

export type Checked = { ok: true; path: string } | { ok: false; reason: string };

function hasControlChar(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
}

type Refusal = { ok: false; reason: string };
const refuse = (reason: string): Refusal => ({ ok: false, reason });

/** The checks on the raw text, before it is split: a refusal, or null. */
function rawPathRefusal(raw: unknown): Refusal | null {
    if (typeof raw !== 'string' || raw === '') return refuse('path is required (e.g. "/ocs/v2.php/apps/...")');
    if (raw.length > PATH_MAX) return refuse(`path is longer than ${PATH_MAX} characters`);
    if (!raw.startsWith('/') || raw.startsWith('//')) return refuse('path must be a path on the Nextcloud host starting with "/", not a URL');
    if (raw.includes('\\') || raw.includes('?') || raw.includes('#') || hasControlChar(raw)) {
        return refuse('path may not contain a backslash, a query ("?", use `query`), a fragment ("#") or control characters');
    }
    return null;
}

/** One segment decoded once and checked, or the refusal. Only the last segment may be empty (a trailing "/"). */
function decodeSegment(seg: string, isLast: boolean): { ok: true; plain: string } | Refusal {
    if (seg === '' && !isLast) return refuse('path may not contain an empty segment ("//")');
    let plain: string;
    try { plain = decodeURIComponent(seg); } catch { return refuse('path has a malformed percent-encoding'); }
    if (plain === '.' || plain === '..') return refuse('path may not contain "." or ".." segments');
    if (plain.includes('/') || plain.includes('\\') || plain.includes('%') || hasControlChar(plain)) {
        return refuse('path may not contain an encoded slash, backslash, percent sign or control character');
    }
    return { ok: true, plain };
}

/**
 * The path as it will be sent (each segment decoded once, checked, encoded
 * again) and its lower-cased decoded form for the policy, or the refusal.
 */
export function normalisePath(raw: unknown): { ok: true; path: string; lower: string } | Refusal {
    const bad = rawPathRefusal(raw);
    if (bad) return bad;
    const segments = String(raw).slice(1).split('/');
    const decoded: string[] = [];
    for (let i = 0; i < segments.length; i++) {
        const seg = decodeSegment(segments[i], i === segments.length - 1);
        if (seg.ok === false) return seg;
        decoded.push(seg.plain);
    }
    return { ok: true, path: `/${decoded.map(encodeURIComponent).join('/')}`, lower: `/${decoded.join('/')}`.toLowerCase() };
}

/** `lower` is `prefix` itself or lies below it (prefix ends in "/", or the next character is "/"). */
function under(lower: string, prefix: string): boolean {
    if (!lower.startsWith(prefix)) return false;
    return prefix.endsWith('/') || lower.length === prefix.length || lower[prefix.length] === '/';
}

function ownTreePrefix(uid: string): string {
    return `/remote.php/dav/files/${uid.toLowerCase()}/`;
}

/** Inside the user's own Files tree, and not the tree's root itself. */
function inOwnTree(lower: string, uid: string): boolean {
    const prefix = ownTreePrefix(uid);
    return lower.startsWith(prefix) && lower.length > prefix.length;
}

/**
 * May this method go to this path for this user? `uid` is the caller's own
 * Nextcloud uid (from the identity, never from the arguments).
 */
export function checkRequestTarget(method: string, rawPath: unknown, uid: string): Checked {
    if (!NC_REQUEST_METHODS.includes(method)) return { ok: false, reason: `method must be one of ${NC_REQUEST_METHODS.join(', ')}` };
    const norm = normalisePath(rawPath);
    if (norm.ok === false) return norm;
    const { lower } = norm;
    if (!ALLOWED_PREFIXES.some((p) => lower.startsWith(p))) {
        return { ok: false, reason: `path must start with ${ALLOWED_PREFIXES.join(', ')}` };
    }
    if (DENIED.some((p) => lower.startsWith(p))) {
        return { ok: false, reason: 'this Nextcloud path manages credentials, apps or accounts and cannot be called from an automation' };
    }
    if (NC_REQUEST_READ_METHODS.has(method)) return { ok: true, path: norm.path };
    if (uid && inOwnTree(lower, uid) && OWN_TREE_WRITES.includes(method)) return { ok: true, path: norm.path };
    if (WRITE_RULES.some((r) => under(lower, r.prefix) && r.methods.includes(method))) return { ok: true, path: norm.path };
    return {
        ok: false,
        reason: `${method} is not allowed on this path. Writes go only to your own files (/remote.php/dav/files/<your user id>/...) `
            + 'and to the Nextcloud app paths Bee Flow writes to itself (Talk chat, shares, Tables, Forms, Deck, Notes, status, file comments and tags).',
    };
}

type Built = { ok: true; headers: Record<string, string> } | Refusal;

/** The caller's headers, lower-cased and checked against ALLOWED_HEADERS. */
function copyHeaders(raw: unknown): Built {
    const headers: Record<string, string> = {};
    if (raw === undefined || raw === null) return { ok: true, headers };
    if (typeof raw !== 'object' || Array.isArray(raw)) return refuse('headers must be an object of header name to value');
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        const key = name.toLowerCase();
        if (!ALLOWED_HEADERS.has(key)) return refuse(`header "${name}" is not allowed (allowed: ${[...ALLOWED_HEADERS].join(', ')})`);
        if (typeof value !== 'string' && typeof value !== 'number') return refuse(`header "${name}" must be a string`);
        const text = String(value);
        if (hasControlChar(text)) return refuse(`header "${name}" may not contain control characters`);
        headers[key] = text;
    }
    return { ok: true, headers };
}

/** A MOVE / COPY Destination: a path in the user's own tree, made absolute on the Nextcloud host. */
function destinationUrl(raw: string | undefined, ctx: NcRequestCtx): { ok: true; url: string } | Refusal {
    const dest = normalisePath(raw);
    if (dest.ok === false) return refuse(`Destination: ${dest.reason}`);
    if (!inOwnTree(dest.lower, ctx.uid)) return refuse('Destination must be a path in your own files (/remote.php/dav/files/<your user id>/...)');
    return { ok: true, url: `${ctx.baseUrl}${dest.path}` };
}

/** The request headers: the caller's (checked), the Destination of a MOVE / COPY, the OCS defaults. */
function buildHeaders(method: string, raw: unknown, ctx: NcRequestCtx, isOcs: boolean): Built {
    const copied = copyHeaders(raw);
    if (copied.ok === false) return copied;
    const { headers } = copied;
    if (headers.depth !== undefined && !DEPTH_VALUES.has(headers.depth)) return refuse('Depth must be "0" or "1"');
    if (method === 'MOVE' || method === 'COPY') {
        const dest = destinationUrl(headers.destination, ctx);
        if (dest.ok === false) return dest;
        headers.destination = dest.url;
    } else if (headers.destination !== undefined) {
        return refuse('Destination is only used by MOVE and COPY');
    }
    if (isOcs) {
        headers['ocs-apirequest'] = 'true';
        headers.accept ??= 'application/json';
    }
    return { ok: true, headers };
}

function buildQuery(raw: unknown): { ok: true; qs: string } | { ok: false; reason: string } {
    if (raw === undefined || raw === null) return { ok: true, qs: '' };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'query must be an object of name to value' };
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            for (const item of v) params.append(k, String(item));
        } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            params.append(k, String(v));
        } else {
            return { ok: false, reason: `query value "${k}" must be a string, number, boolean or a list of those` };
        }
    }
    const qs = params.toString();
    return { ok: true, qs: qs ? `?${qs}` : '' };
}

function buildBody(raw: unknown, headers: Record<string, string>): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'string') return raw;
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json';
    return JSON.stringify(raw);
}

function parseAnswer(text: string, contentType: string, truncated: boolean): unknown {
    if (truncated || !contentType.toLowerCase().includes('json')) return text;
    try { return JSON.parse(text); } catch { return text; }
}

const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'DELETE', 'MOVE', 'COPY']);

type Prepared = { ok: true; method: string; path: string; url: string; init: { method: string; headers: Record<string, string>; body?: string } } | Refusal;

/** Every check, then the URL and the request init; nothing is sent here. */
function prepareRequest(args: NcRequestArgs, ctx: NcRequestCtx): Prepared {
    const method = typeof args.method === 'string' ? args.method.trim().toUpperCase() : '';
    const target = checkRequestTarget(method, args.path, ctx.uid);
    if (target.ok === false) return target;
    const isOcs = OCS_PREFIXES.some((p) => target.path.toLowerCase().startsWith(p));
    const built = buildHeaders(method, args.headers, ctx, isOcs);
    if (built.ok === false) return built;
    const query = buildQuery(args.query);
    if (query.ok === false) return query;
    const hasBody = args.body !== undefined && args.body !== null;
    if (hasBody && BODYLESS_METHODS.has(method)) return refuse(`${method} takes no body`);
    const body = buildBody(args.body, built.headers);
    const init = body === undefined ? { method, headers: built.headers } : { method, headers: built.headers, body };
    return { ok: true, method, path: target.path, url: `${ctx.baseUrl}${target.path}${query.qs}`, init };
}

/** The nextcloud_request handler. */
export async function executeNextcloudRequest(args: NcRequestArgs, ctx: NcRequestCtx): Promise<NcRequestResult | { error: string; status?: number; body?: unknown }> {
    if (!ctx.runScope && !ctx.automationId) return { error: 'nextcloud_request only runs as a step of an automation.' };
    const req = prepareRequest(args, ctx);
    if (req.ok === false) return { error: req.reason };
    const res = await ctx.ncFetch(req.url, req.init);
    if (res.status === 401) return { error: ctx.authError, status: 401 };
    const contentType = res.headers?.get?.('content-type') || '';
    const { text, truncated } = await readBodyBounded(res, { charCap: HTTP_RESPONSE_CAP });
    const answer = parseAnswer(text, contentType, truncated);
    if (res.status >= 400) return { error: `Nextcloud answered ${res.status} to ${req.method} ${req.path}`, status: res.status, body: answer };
    return { status: res.status, ok: res.ok, contentType, body: answer, truncated };
}

export const NEXTCLOUD_REQUEST_TOOLS = [
    {
        type: 'function',
        // Read by the agent tool picker (routes/agents/toolCatalog.js), which leaves it out.
        availableTo: ['automation_step'],
        function: {
            name: 'nextcloud_request',
            description: 'Call one Nextcloud OCS or WebDAV endpoint directly, as the automation owner, for a Nextcloud API no other Nextcloud action covers. '
                + 'Automations only. `path` is a path on the Nextcloud host starting with /ocs/v2.php/, /ocs/v1.php/, /remote.php/dav/ or /index.php/apps/ (no full URL, no "..", the query string goes in `query`). '
                + 'Reads (GET, PROPFIND, REPORT) work on any such path except credential, app-management and user-provisioning paths. '
                + 'Writes work only on your own files (/remote.php/dav/files/<your user id>/...) and on the Talk chat, share, Tables, Forms, Deck, Notes, status, comment and tag paths. '
                + 'OCS calls get OCS-APIRequest and a JSON Accept header automatically. Returns { status, ok, contentType, body (parsed JSON, else text), truncated }; a 4xx/5xx answer fails the step.',
            parameters: {
                type: 'object',
                properties: {
                    method: { type: 'string', enum: [...NC_REQUEST_METHODS], description: 'HTTP or WebDAV method.' },
                    path: { type: 'string', description: 'Path on the Nextcloud host, e.g. "/ocs/v2.php/apps/files_sharing/api/v1/shares" or "/remote.php/dav/files/<uid>/Reports".' },
                    query: { type: 'object', description: 'Query parameters, name to value (e.g. { "format": "json" }).' },
                    body: { description: 'Request body: an object or array is sent as JSON, a string as is (e.g. a WebDAV XML body).' },
                    headers: { type: 'object', description: 'Extra request headers. Only Accept, Content-Type, Depth ("0" or "1"), Destination (a path in your own files, for MOVE / COPY), Overwrite, If-Match, If-None-Match and OCS-APIRequest.' },
                },
                required: ['method', 'path'],
            },
        },
    },
];

export function isNextcloudRequestTool(toolName: string): boolean {
    return toolName === 'nextcloud_request';
}
