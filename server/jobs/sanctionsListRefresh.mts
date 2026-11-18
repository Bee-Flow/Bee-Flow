/**
 * Sanctions list refresh: download the official lists (core/sanctions/sources.mts), parse them
 * and swap each list's rows in one transaction (stores/sanctionsStore.mts replaceList).
 *
 * What never happens:
 *   - a failed download, a file that does not parse, or a parse with fewer entries than the
 *     list's floor (`minEntities`) never empties or shrinks the stored list: the error is
 *     recorded on the list's status row and the rows stay as they were;
 *   - nothing but the fixed public list addresses is fetched (fetchFixedEndpoint), and nothing
 *     about a screening, an organisation or a user is sent anywhere. A self-hosted server
 *     without internet just records the error.
 *
 * A pass only downloads when some organisation has the `sanctions-lists` integration switched
 * on, or a screening met an empty list recently (isUsed), so a server nobody screens on makes no
 * calls. The tick is hourly; each list is refreshed when due (isDue). A download below 70% of
 * the stored count is refused too, unless forced. The parse runs in a worker thread with a
 * memory limit (SANCTIONS_PARSE_MEMORY_MB), one list at a time. The platform admin's "refresh now" (route
 * routes/admin/sanctionsLists.mts) forces a pass regardless.
 *
 * An unchanged file is not parsed again: a single-file list sends If-None-Match /
 * If-Modified-Since, and every list compares the sha256 of what it downloaded.
 *
 * Environment (docs/docs/self-hosting/env.md):
 *   SANCTIONS_REFRESH_INTERVAL_HOURS  hours between passes (default 24; 0 = no automatic refresh)
 *   SANCTIONS_DOWNLOAD_TIMEOUT_MS     wait for the response headers per file (default 120000)
 *   SANCTIONS_MAX_DOWNLOAD_MB         largest file accepted (default 200; 0 = no limit)
 *   SANCTIONS_PARSE_MEMORY_MB         memory limit of the parse worker (default 1024; 0 = no limit)
 *
 * MULTI-POD SAFE: one pass at a time across replicas (core/scheduling/namedLock, key
 * LOCK_NAME). Started from boot (boot/startupJobs.js startSupportAndSyncJobs):
 *   require('../jobs/sanctionsListRefresh.mts').start();
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { LIST_SOURCES, decodeFiles, type ListSource } from '../core/sanctions/sources.mts';
import { indexEntity, type ParsedEntity } from '../core/sanctions/entity.mts';
import type { DownloadMeta, ListStatusRow, SanctionsStore } from '../stores/sanctionsStore.mts';

const nodeRequire = createRequire(import.meta.url);

export const LOCK_NAME = 'beeflow:job:sanctionsListRefresh';
export const INTEGRATION_ID = 'sanctions-lists';
const BOOT_DELAY_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<Response>;
type EnvInt = (name: string, fallback: number, bounds?: { min?: number; max?: number }) => number;

export interface RefreshDeps {
    pool: unknown;
    withNamedLock: <T>(pool: unknown, name: string, fn: () => Promise<T>) => Promise<{ ran: boolean; value?: T }>;
    store: () => SanctionsStore;
    fetch: FetchLike;
    envInt: EnvInt;
    sources: readonly ListSource[];
    log: { info: (m: string) => void; warn: (m: string, ...rest: unknown[]) => void };
    /** Parse one list's raw files (default: a worker thread for the real lists). */
    parse?: (source: ListSource, files: Record<string, Uint8Array>) => Promise<ParsedEntity[]>;
}

export type ListOutcome =
    | { listId: string; result: 'replaced'; entities: number; names: number }
    | { listId: string; result: 'unchanged' }
    | { listId: string; result: 'failed'; error: string };

export type PassResult =
    | { ran: true; outcomes: ListOutcome[] }
    | { ran: false; reason: 'running' | 'locked' | 'unused' | 'not_due' };

/** A download below this share of the stored entry count is refused unless forced. */
export const SHRINK_FLOOR = 0.7;
/** An empty list (never imported, or every import failed) is retried this often. */
const EMPTY_RETRY_MS = HOUR_MS;

function defaultDeps(): RefreshDeps {
    return {
        pool: nodeRequire('../db.js').pool,
        withNamedLock: nodeRequire('../core/scheduling/namedLock.js').withNamedLock,
        store: () => nodeRequire('../stores/sanctionsStore.mts').sanctionsStore(),
        fetch: (url, init) => nodeRequire('../utils/fixedEndpointFetch.mts').fetchFixedEndpoint(url, init),
        envInt: nodeRequire('../utils/envNumber.mts').envInt,
        sources: LIST_SOURCES,
        log: nodeRequire('../telemetry/log.js'),
    };
}

let deps: RefreshDeps | null = null;
let running = false;
const d = (): RefreshDeps => deps ?? (deps = defaultDeps());

/** Test hook: replace dependencies; no argument restores the real ones. */
export function _setDeps(next?: Partial<RefreshDeps> | null): void {
    deps = next ? { ...defaultDeps(), ...next } : null;
    running = false;
}

export function settings(dep: RefreshDeps = d()): { intervalHours: number; timeoutMs: number; maxBytes: number; parseMemoryMb: number } {
    const intervalHours = dep.envInt('SANCTIONS_REFRESH_INTERVAL_HOURS', 24, { min: 0, max: 24 * 30 });
    const timeoutMs = dep.envInt('SANCTIONS_DOWNLOAD_TIMEOUT_MS', 120_000, { min: 1000 });
    const maxMb = dep.envInt('SANCTIONS_MAX_DOWNLOAD_MB', 200, { min: 0 });
    const parseMemoryMb = dep.envInt('SANCTIONS_PARSE_MEMORY_MB', 1024, { min: 0 });
    return { intervalHours, timeoutMs, maxBytes: maxMb === 0 ? Infinity : maxMb * 1024 * 1024, parseMemoryMb };
}

/** Is this list due: empty and not tried in the last hour, or older than the interval? */
export function isDue(prev: ListStatusRow | null | undefined, intervalHours: number, now = Date.now()): boolean {
    const tried = prev?.lastAttemptAt ? Date.parse(prev.lastAttemptAt) : NaN;
    if (!Number.isFinite(tried)) return true;
    if (!prev?.entityCount) return now - tried >= EMPTY_RETRY_MS;
    return now - tried >= Math.max(1, intervalHours) * HOUR_MS;
}

/** The body, refused once it passes `maxBytes`. */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`the file is larger than ${Math.round(maxBytes / 1048576)} MB`);
    if (!res.body) return Buffer.from(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`the file is larger than ${Math.round(maxBytes / 1048576)} MB`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

type Downloaded = { unchanged: true; meta: DownloadMeta } | { unchanged: false; files: Record<string, Uint8Array>; meta: DownloadMeta };

/** The parse of one list, in a worker thread with a memory limit (SANCTIONS_PARSE_MEMORY_MB, 0 = no limit). */
export function parseInWorker(source: ListSource, files: Record<string, Uint8Array>, memoryMb: number): Promise<ParsedEntity[]> {
    const { Worker } = nodeRequire('node:worker_threads') as typeof import('node:worker_threads');
    const transferList = Object.values(files).map((f) => f.buffer).filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./sanctionsParseWorker.mts', import.meta.url), {
            workerData: { listId: source.id, files }, transferList,
            ...(memoryMb > 0 ? { resourceLimits: { maxOldGenerationSizeMb: memoryMb } } : {}),
        });
        let settled = false;
        const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
        worker.once('message', (m: { ok: boolean; entities?: ParsedEntity[]; error?: string }) => done(() => (m.ok ? resolve(m.entities ?? []) : reject(new Error(m.error || 'the parse failed')))));
        worker.once('error', (err) => done(() => reject(new Error(`the parse stopped: ${err.message}`))));
        worker.once('exit', (code) => done(() => reject(new Error(`the parse stopped (exit ${code}); SANCTIONS_PARSE_MEMORY_MB may be too low`))));
    });
}

/** The real lists parse in a worker; a list a test hands in parses in this thread. */
function defaultParse(source: ListSource, files: Record<string, Uint8Array>, dep: RefreshDeps): Promise<ParsedEntity[]> {
    if (LIST_SOURCES.includes(source)) return parseInWorker(source, files, settings(dep).parseMemoryMb);
    return Promise.resolve(source.parse(decodeFiles(source, files)));
}

/** If-None-Match / If-Modified-Since for a single-file list that imported fine before. */
function conditionalHeaders(prev: ListStatusRow | null, single: boolean, force: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: '*/*' };
    if (!single || force || prev?.status !== 'ok') return headers;
    if (prev.etag) headers['If-None-Match'] = prev.etag;
    if (prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;
    return headers;
}

async function download(source: ListSource, prev: ListStatusRow | null, dep: RefreshDeps, force: boolean): Promise<Downloaded> {
    const { timeoutMs, maxBytes } = settings(dep);
    const single = source.files.length === 1;
    const hash = createHash('sha256');
    const files: Record<string, Uint8Array> = {};
    let meta: DownloadMeta = {};
    for (const file of source.files) {
        const headers = conditionalHeaders(prev, single, force);
        const res = await dep.fetch(file.url, { headers, timeoutMs, timeoutPhase: 'headers', redirect: 'follow' });
        if (res.status === 304) return { unchanged: true, meta: { etag: prev?.etag, lastModified: prev?.lastModified } };
        if (!res.ok) throw new Error(`${file.key}: the server answered HTTP ${res.status}`);
        const body = await readCapped(res, maxBytes);
        hash.update(file.key).update(body);
        files[file.key] = body;
        if (single) meta = { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    }
    meta.contentHash = hash.digest('hex');
    const same = !force && prev?.status === 'ok' && !!prev.contentHash && prev.contentHash === meta.contentHash;
    return same ? { unchanged: true, meta } : { unchanged: false, files, meta };
}

/** Throws when a download is too small to replace the stored list. */
function checkSize(source: ListSource, prev: ListStatusRow | null, count: number, force: boolean): void {
    if (count < source.minEntities) {
        throw new Error(`the download holds ${count} entries, fewer than the ${source.minEntities} expected; the stored list was kept`);
    }
    const stored = prev?.entityCount ?? 0;
    if (!force && stored > 0 && count < SHRINK_FLOOR * stored) {
        throw new Error(`the download holds ${count} entries, less than 70% of the ${stored} stored; the stored list was kept (a platform admin can force it with Refresh now)`);
    }
}

/** One list: downloaded, checked and swapped, or its failure recorded. Never throws. */
export async function refreshList(source: ListSource, prev: ListStatusRow | null, opts: { force?: boolean } = {}, dep: RefreshDeps = d()): Promise<ListOutcome> {
    const store = dep.store();
    try {
        const got = await download(source, prev, dep, !!opts.force);
        if (got.unchanged) {
            await store.recordUnchanged(source.id, source.label, got.meta);
            return { listId: source.id, result: 'unchanged' };
        }
        // The raw files are handed over (to the worker, which owns them from then on) and dropped here.
        const files = got.files;
        got.files = {};
        const entities = await (dep.parse ? dep.parse(source, files) : defaultParse(source, files, dep));
        checkSize(source, prev, entities.length, !!opts.force);
        const counts = await store.replaceList(source.id, source.label, entities.map(indexEntity), got.meta);
        return { listId: source.id, result: 'replaced', ...counts };
    } catch (err) {
        const error = (err as Error)?.message || String(err);
        dep.log.warn(`[sanctionsListRefresh] ${source.id}: ${error}`);
        await store.recordFailure(source.id, source.label, error).catch((e: unknown) => dep.log.warn('[sanctionsListRefresh] could not record the failure:', (e as Error).message));
        return { listId: source.id, result: 'failed', error };
    }
}

/**
 * One pass over every list. `force` (the admin's "refresh now") skips the "is it used?" check
 * and the unchanged-file shortcut.
 */
export async function runOnce(opts: { force?: boolean } = {}): Promise<PassResult> {
    if (running) return { ran: false, reason: 'running' };
    const dep = d();
    running = true;
    try {
        if (!opts.force && !(await isUsed(dep))) return { ran: false, reason: 'unused' };
        const { intervalHours } = settings(dep);
        const out = await dep.withNamedLock(dep.pool, LOCK_NAME, async () => {
            const prev = new Map((await dep.store().listStatus()).map((r) => [r.id, r]));
            const due = dep.sources.filter((s) => opts.force || isDue(prev.get(s.id), intervalHours));
            const outcomes: ListOutcome[] = [];
            // One list at a time: only one list's files and entities are in memory at once.
            for (const source of due) outcomes.push(await refreshList(source, prev.get(source.id) ?? null, opts, dep));
            return outcomes;
        });
        if (!out.ran) return { ran: false, reason: 'locked' };
        const outcomes = out.value ?? [];
        if (!outcomes.length) return { ran: false, reason: 'not_due' };
        dep.log.info(`[sanctionsListRefresh] pass done: ${outcomes.map((o) => `${o.listId}=${o.result}`).join(', ')}`);
        return { ran: true, outcomes };
    } catch (err) {
        dep.log.warn('[sanctionsListRefresh] pass failed:', (err as Error).message);
        return { ran: true, outcomes: [] };
    } finally {
        running = false;
    }
}

/**
 * Does anybody screen here? An organisation with the integration on, or a screening that met an
 * empty list in the last two intervals (sanctions_demand). The second covers a user without an
 * organisation, whose integration switch no organisation row holds.
 */
async function isUsed(dep: RefreshDeps): Promise<boolean> {
    const store = dep.store();
    if (await store.anyOrganisationUses(INTEGRATION_ID).catch(() => false)) return true;
    const hours = 2 * Math.max(24, settings(dep).intervalHours);
    return typeof store.hasRecentDemand === 'function' ? store.hasRecentDemand(hours).catch(() => false) : false;
}

/** Is a pass running in this process right now? */
export function isRunning(): boolean {
    return running;
}

let timer: { start: () => void; stop: () => void } | null = null;

/**
 * Starts the hourly tick, unless SANCTIONS_REFRESH_INTERVAL_HOURS is 0. A tick refreshes the lists
 * that are due (isDue): older than the interval, or empty and not tried in the last hour, so an
 * organisation that switches the integration on gets its lists within the hour.
 */
export function start(): void {
    if (timer) return;
    const { intervalHours } = settings();
    if (intervalHours === 0) {
        d().log.info('[sanctionsListRefresh] automatic refresh off (SANCTIONS_REFRESH_INTERVAL_HOURS=0)');
        return;
    }
    const { periodicJob } = nodeRequire('./lib/periodicTimer.js');
    timer = periodicJob({
        bootDelayMs: BOOT_DELAY_MS, intervalMs: HOUR_MS, run: () => runOnce(),
        onStart: () => d().log.info(`[sanctionsListRefresh] Started: a list is refreshed every ${intervalHours} h, an empty one every hour`),
    });
    timer!.start();
}

export function stop(): void {
    timer?.stop();
    timer = null;
}
