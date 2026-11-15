/**
 * windmillRemote.mts: read the flows of a standalone Windmill once, with a
 * URL, a workspace and a read-only token the person gives for this one
 * request (PLAN B1-W).
 *
 *   fetchWindmillExport({ baseUrl, workspace, token }, { maxBytes, maxFlows })
 *       → { input, notes }   input for the converter (toIntermediate)
 *   openWindmill(src, limits)                    one read session: its answers share one byte budget
 *   fetchFlowRuns(session, flowPath, n, { moduleIds })
 *       → WindmillRun[]      the last n completed runs of one flow, with their input and the
 *                            results of the named steps (PLAN B6, the side-by-side comparison)
 *
 * First the workspace archive (`workspaces/tarball`, zip, secrets skipped),
 * which carries flows, scripts, schedules and triggers together; when the
 * instance does not offer it, the flows one by one (`flows/list`,
 * `flows/get/<path>`), and the notes say that schedules and triggers were not
 * read that way.
 *
 * The rules this file keeps:
 *   - the token travels only in the Authorization header of these requests;
 *     it is never stored, never logged and never part of an error or a note;
 *   - every request goes through the guarded fetch (core/http/ssrfGuard
 *     safeFetch: HTTPS, public addresses only, no redirects) with the outbound
 *     time-out, and every body is read with a byte cap; all answers of one
 *     read share one total budget (`maxTotalBytes`);
 *   - an error is one of a few fixed sentences (WindmillRemoteError.code); the
 *     upstream body, status text or parse error never reaches the caller, so
 *     this cannot be used to read another server's answers;
 *   - `secrets` are never asked for: `skip_secrets=true`, `plain_secret=false`.
 *
 * A Windmill on a private address or plain HTTP is not reachable from here;
 * the person uploads the export instead.
 *
 * The run reads (Windmill OpenAPI, `listCompletedJobs`, `getCompletedJob`,
 * `getCompletedJobResult`):
 *   GET jobs/completed/list?script_path_exact=<path>&job_kinds=flow&has_null_parent=true&per_page=<n>
 *   GET jobs_u/completed/get/<id>            args, success, flow_status.modules[] { id, type, job }
 *   GET jobs_u/completed/get_result/<job>    the result of one step of that run
 * A run's input and results are customer data: they are returned to the caller
 * in memory and never logged here.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface RemoteSource {
    baseUrl: string;
    workspace: string;
    token: string;
}

export interface RemoteLimits {
    /** Bytes of one answer (0 = unlimited). */
    maxBytes: number;
    /** Flows read one by one (0 = unlimited). */
    maxFlows: number;
    /** Bytes of all answers of one read together (0 = unlimited; the route passes the unpacked-export cap). */
    maxTotalBytes?: number;
}

export type RemoteInput =
    | { kind: 'zip'; data: Uint8Array }
    | { kind: 'object'; value: unknown[]; name?: string };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    body: ReadableStream<Uint8Array> | null;
}>;

export type RemoteErrorCode = 'invalid_address' | 'invalid_workspace' | 'unreachable' | 'unauthorized' | 'not_windmill' | 'too_large';

const MESSAGES: Record<RemoteErrorCode, string> = {
    invalid_address: 'The Windmill address must be an https:// address without a user name, password, query or fragment.',
    invalid_workspace: 'The workspace id may only hold letters, digits, "-" and "_".',
    unreachable: 'This Windmill is not reachable from Bee Flow. Upload the export instead.',
    unauthorized: 'Windmill refused the token. Create a read-only token for this workspace and try again.',
    not_windmill: 'The address did not answer like a Windmill workspace. Check the address and the workspace id, or upload the export instead.',
    too_large: 'The workspace is larger than this server accepts in one import. Upload the export of a few folders instead.',
};

export class WindmillRemoteError extends Error {
    code: RemoteErrorCode;
    constructor(code: RemoteErrorCode) {
        super(MESSAGES[code]);
        this.name = 'WindmillRemoteError';
        this.code = code;
    }
}

const WORKSPACE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';

/** The base address as https://host[:port][/prefix], without a trailing slash. Throws invalid_address. */
export function normaliseBaseUrl(raw: string): string {
    let u: URL;
    try { u = new URL(String(raw).trim()); } catch { throw new WindmillRemoteError('invalid_address'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new WindmillRemoteError('invalid_address');
    const path = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
    return `${u.origin}${path}`;
}

/** A Windmill workspace id: letters, digits, "-" and "_", at most 64. Throws invalid_workspace. */
export function checkWorkspace(raw: string): string {
    const ws = String(raw).trim();
    if (!ws || ws.length > 64) throw new WindmillRemoteError('invalid_workspace');
    for (const ch of ws) if (!WORKSPACE_CHARS.includes(ch)) throw new WindmillRemoteError('invalid_workspace');
    return ws;
}

/** A flow path as Windmill names it (`f/folder/name`, `u/user/name`): each segment encoded on its own. */
export function encodePath(path: string): string {
    return String(path).split('/').map((s) => encodeURIComponent(s)).join('/');
}

function defaultFetch(): FetchLike {
    const { safeFetch } = nodeRequire('../../core/http/ssrfGuard') as { safeFetch: FetchLike };
    return safeFetch;
}

function timeoutSignal(): AbortSignal | undefined {
    const { defaultTimeoutSignal } = nodeRequire('../../utils/outboundTimeout.mts') as { defaultTimeoutSignal: () => AbortSignal | undefined };
    return defaultTimeoutSignal();
}

/** The body as bytes, never more than `maxBytes` held (0 = unlimited). Throws too_large past it. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, declared: string | null, maxBytes: number): Promise<Uint8Array> {
    if (!body) return new Uint8Array(0);
    const declaredN = Number(declared);
    if (maxBytes > 0 && Number.isFinite(declaredN) && declaredN > maxBytes) {
        try { await body.cancel(); } catch { /* the refusal stands */ }
        throw new WindmillRemoteError('too_large');
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (maxBytes > 0 && total > maxBytes) {
            try { await reader.cancel(); } catch { /* the refusal stands */ }
            throw new WindmillRemoteError('too_large');
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

/** One read session: every answer of it counts against the same byte budget. */
export interface WindmillSession {
    get(path: string): Promise<{ status: number; bytes: Uint8Array | null }>;
}
type Client = WindmillSession;

/**
 * The cap of the next answer: the per-answer cap, lowered to what is left of
 * the total budget. 0 = unlimited. Throws too_large once the budget is spent.
 */
function nextCap(limits: RemoteLimits, spent: number): number {
    const total = limits.maxTotalBytes ?? 0;
    if (total <= 0) return limits.maxBytes;
    const left = total - spent;
    if (left <= 0) throw new WindmillRemoteError('too_large');
    return limits.maxBytes > 0 ? Math.min(limits.maxBytes, left) : left;
}

function clientFor(src: RemoteSource, limits: RemoteLimits, fetchImpl: FetchLike): Client {
    const base = normaliseBaseUrl(src.baseUrl);
    const ws = checkWorkspace(src.workspace);
    // Every answer of this read counts against one budget (the flow-by-flow fallback included).
    let spent = 0;
    return {
        async get(path: string) {
            const cap = nextCap(limits, spent);
            let res;
            try {
                res = await fetchImpl(`${base}/api/w/${ws}/${path}`, {
                    method: 'GET',
                    headers: { authorization: `Bearer ${src.token}`, accept: 'application/json, application/zip' },
                    signal: timeoutSignal(),
                });
            } catch {
                // A refused address, DNS, TLS or a time-out: one sentence for all of them.
                throw new WindmillRemoteError('unreachable');
            }
            if (res.status === 401 || res.status === 403) {
                try { await res.body?.cancel(); } catch { /* nothing to read */ }
                throw new WindmillRemoteError('unauthorized');
            }
            if (!res.ok) {
                try { await res.body?.cancel(); } catch { /* nothing to read */ }
                return { status: res.status, bytes: null };
            }
            const bytes = await readCapped(res.body, res.headers.get('content-length'), cap);
            spent += bytes.length;
            return { status: res.status, bytes };
        },
    };
}

const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;

function parseJson(bytes: Uint8Array): unknown {
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new WindmillRemoteError('not_windmill'); }
}

/** A read session on one Windmill workspace (throws invalid_address / invalid_workspace at once). */
export function openWindmill(src: RemoteSource, limits: RemoteLimits, { fetchImpl }: { fetchImpl?: FetchLike } = {}): WindmillSession {
    return clientFor(src, limits, fetchImpl ?? defaultFetch());
}

/** The workspace's flows, read once. The token is used for these requests only. */
export async function fetchWindmillExport(src: RemoteSource, limits: RemoteLimits, { fetchImpl, session }: { fetchImpl?: FetchLike; session?: WindmillSession } = {}): Promise<{ input: RemoteInput; notes: string[] }> {
    const client = session ?? clientFor(src, limits, fetchImpl ?? defaultFetch());
    const tarball = await client.get('workspaces/tarball?archive_type=zip&skip_secrets=true&plain_secret=false&include_schedules=true&include_triggers=true&skip_variables=true&skip_resources=true');
    if (tarball.bytes && isZip(tarball.bytes)) return { input: { kind: 'zip', data: tarball.bytes }, notes: [] };

    const list = await client.get('flows/list?per_page=1000');
    if (!list.bytes) throw new WindmillRemoteError('not_windmill');
    const listed = parseJson(list.bytes);
    if (!Array.isArray(listed)) throw new WindmillRemoteError('not_windmill');
    const paths = listed.map((f) => (f && typeof f === 'object' ? (f as { path?: unknown }).path : null)).filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (limits.maxFlows > 0 && paths.length > limits.maxFlows) throw new WindmillRemoteError('too_large');
    const flows: unknown[] = [];
    for (const p of paths) {
        const one = await client.get(`flows/get/${encodePath(p)}`);
        if (!one.bytes) continue;
        const value = parseJson(one.bytes);
        if (value && typeof value === 'object') flows.push(value);
    }
    return {
        input: { kind: 'object', value: flows, name: 'windmill' },
        notes: ['This Windmill does not offer the workspace archive, so the flows were read one by one: schedules, triggers and the scripts the flows call were not read. Upload a `wmill sync pull` export to carry them over.'],
    };
}

// ── Runs of one flow (PLAN B6) ───────────────────────────────────────────

export interface WindmillRun {
    /** Windmill's job id (a uuid). */
    id: string;
    /** Whether Windmill finished the run without an error; null when it did not say. */
    success: boolean | null;
    /** The run's `flow_input`, as Windmill recorded it. */
    args: unknown;
    /** Windmill step id → that step's result, for the steps asked for that finished. */
    stepResults: Map<string, unknown>;
}

/** Windmill per_page caps at 100. */
const MAX_PER_PAGE = 100;
const JOB_ID_CHARS = '0123456789abcdefABCDEF-';

function isJobId(v: unknown): v is string {
    if (typeof v !== 'string' || v.length < 1 || v.length > 64) return false;
    for (const ch of v) if (!JOB_ID_CHARS.includes(ch)) return false;
    return true;
}

const field = (v: unknown, key: string): unknown => (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined);

/**
 * The last `n` completed top-level runs of the flow at `flowPath`, newest
 * first, each with its input and the results of the steps in `moduleIds`
 * (all finished top-level steps when it is left out). Throws the same codes as
 * the export read; a run or a step whose answer is missing is left out.
 */
export async function fetchFlowRuns(session: WindmillSession, flowPath: string, n: number, { moduleIds }: { moduleIds?: ReadonlySet<string> } = {}): Promise<WindmillRun[]> {
    // The list filter takes a comma-separated list and a "!" negation: such a path is not one flow.
    if (n <= 0 || !flowPath || flowPath.includes(',') || flowPath.startsWith('!')) return [];
    const perPage = Math.min(Math.floor(n), MAX_PER_PAGE);
    const list = await session.get(`jobs/completed/list?script_path_exact=${encodeURIComponent(flowPath)}&job_kinds=flow&has_null_parent=true&is_skipped=false&order_desc=true&per_page=${perPage}`);
    if (!list.bytes) throw new WindmillRemoteError('not_windmill');
    const listed = parseJson(list.bytes);
    if (!Array.isArray(listed)) throw new WindmillRemoteError('not_windmill');
    const ids = listed.map((j) => field(j, 'id')).filter(isJobId).slice(0, perPage);
    const runs: WindmillRun[] = [];
    for (const id of ids) {
        const one = await session.get(`jobs_u/completed/get/${encodeURIComponent(id)}`);
        if (!one.bytes) continue;
        const job = parseJson(one.bytes);
        if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
        const success = field(job, 'success');
        runs.push({ id, success: typeof success === 'boolean' ? success : null, args: field(job, 'args') ?? {}, stepResults: await stepResultsOf(session, job, moduleIds) });
    }
    return runs;
}

async function stepResultsOf(session: WindmillSession, job: unknown, moduleIds: ReadonlySet<string> | undefined): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    const modules = field(field(job, 'flow_status'), 'modules');
    if (!Array.isArray(modules)) return out;
    for (const m of modules) {
        const stepId = field(m, 'id');
        const jobId = field(m, 'job');
        if (field(m, 'type') !== 'Success' || typeof stepId !== 'string' || !isJobId(jobId) || out.has(stepId)) continue;
        if (moduleIds && !moduleIds.has(stepId)) continue;
        const r = await session.get(`jobs_u/completed/get_result/${encodeURIComponent(jobId)}`);
        if (!r.bytes) continue;
        try { out.set(stepId, JSON.parse(new TextDecoder().decode(r.bytes))); } catch { /* not JSON: that step is not compared */ }
    }
    return out;
}
