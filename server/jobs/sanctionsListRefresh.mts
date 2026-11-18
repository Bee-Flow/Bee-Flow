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
 * on, so a server nobody screens on makes no calls. The platform admin's "refresh now" (route
 * routes/admin/sanctionsLists.mts) forces a pass regardless.
 *
 * An unchanged file is not parsed again: a single-file list sends If-None-Match /
 * If-Modified-Since, and every list compares the sha256 of what it downloaded.
 *
 * Environment (docs/docs/self-hosting/env.md):
 *   SANCTIONS_REFRESH_INTERVAL_HOURS  hours between passes (default 24; 0 = no automatic refresh)
 *   SANCTIONS_DOWNLOAD_TIMEOUT_MS     wait for the response headers per file (default 120000)
 *   SANCTIONS_MAX_DOWNLOAD_MB         largest file accepted (default 200; 0 = no limit)
 *
 * MULTI-POD SAFE: one pass at a time across replicas (core/scheduling/namedLock, key
 * LOCK_NAME). Started from boot (boot/startupJobs.js startSupportAndSyncJobs):
 *   require('../jobs/sanctionsListRefresh.mts').start();
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { LIST_SOURCES, type ListSource } from '../core/sanctions/sources.mts';
import { indexEntity } from '../core/sanctions/entity.mts';
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
}

export type ListOutcome =
    | { listId: string; result: 'replaced'; entities: number; names: number }
    | { listId: string; result: 'unchanged' }
    | { listId: string; result: 'failed'; error: string };

export type PassResult =
    | { ran: true; outcomes: ListOutcome[] }
    | { ran: false; reason: 'running' | 'locked' | 'unused' };

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

export function settings(dep: RefreshDeps = d()): { intervalHours: number; timeoutMs: number; maxBytes: number } {
    const intervalHours = dep.envInt('SANCTIONS_REFRESH_INTERVAL_HOURS', 24, { min: 0, max: 24 * 30 });
    const timeoutMs = dep.envInt('SANCTIONS_DOWNLOAD_TIMEOUT_MS', 120_000, { min: 1000 });
    const maxMb = dep.envInt('SANCTIONS_MAX_DOWNLOAD_MB', 200, { min: 0 });
    return { intervalHours, timeoutMs, maxBytes: maxMb === 0 ? Infinity : maxMb * 1024 * 1024 };
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

type Downloaded = { unchanged: true; meta: DownloadMeta } | { unchanged: false; files: Record<string, string | Buffer>; meta: DownloadMeta };

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
    const files: Record<string, string | Buffer> = {};
    let meta: DownloadMeta = {};
    for (const file of source.files) {
        const headers = conditionalHeaders(prev, single, force);
        const res = await dep.fetch(file.url, { headers, timeoutMs, timeoutPhase: 'headers', redirect: 'follow' });
        if (res.status === 304) return { unchanged: true, meta: { etag: prev?.etag, lastModified: prev?.lastModified } };
        if (!res.ok) throw new Error(`${file.key}: the server answered HTTP ${res.status}`);
        const body = await readCapped(res, maxBytes);
        hash.update(file.key).update(body);
        files[file.key] = file.as === 'binary' ? body : body.toString('utf8');
        if (single) meta = { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    }
    meta.contentHash = hash.digest('hex');
    const same = !force && prev?.status === 'ok' && !!prev.contentHash && prev.contentHash === meta.contentHash;
    return same ? { unchanged: true, meta } : { unchanged: false, files, meta };
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
        const entities = await source.parse(got.files);
        if (entities.length < source.minEntities) {
            throw new Error(`the download holds ${entities.length} entries, fewer than the ${source.minEntities} expected; the stored list was kept`);
        }
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
        if (!opts.force && !(await dep.store().anyOrganisationUses(INTEGRATION_ID).catch(() => false))) return { ran: false, reason: 'unused' };
        const out = await dep.withNamedLock(dep.pool, LOCK_NAME, async () => {
            const prev = new Map((await dep.store().listStatus()).map((r) => [r.id, r]));
            const outcomes: ListOutcome[] = [];
            for (const source of dep.sources) outcomes.push(await refreshList(source, prev.get(source.id) ?? null, opts, dep));
            return outcomes;
        });
        if (!out.ran) return { ran: false, reason: 'locked' };
        const outcomes = out.value ?? [];
        dep.log.info(`[sanctionsListRefresh] pass done: ${outcomes.map((o) => `${o.listId}=${o.result}`).join(', ')}`);
        return { ran: true, outcomes };
    } catch (err) {
        dep.log.warn('[sanctionsListRefresh] pass failed:', (err as Error).message);
        return { ran: true, outcomes: [] };
    } finally {
        running = false;
    }
}

/** Is a pass running in this process right now? */
export function isRunning(): boolean {
    return running;
}

let timer: { start: () => void; stop: () => void } | null = null;

/** Starts the periodic pass, unless SANCTIONS_REFRESH_INTERVAL_HOURS is 0. */
export function start(): void {
    if (timer) return;
    const { intervalHours } = settings();
    if (intervalHours === 0) {
        d().log.info('[sanctionsListRefresh] automatic refresh off (SANCTIONS_REFRESH_INTERVAL_HOURS=0)');
        return;
    }
    const { periodicJob } = nodeRequire('./lib/periodicTimer.js');
    timer = periodicJob({
        bootDelayMs: BOOT_DELAY_MS, intervalMs: intervalHours * HOUR_MS, run: () => runOnce(),
        onStart: () => d().log.info(`[sanctionsListRefresh] Started: every ${intervalHours} h`),
    });
    timer!.start();
}

export function stop(): void {
    timer?.stop();
    timer = null;
}
