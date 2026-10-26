/**
 * nmbrsPageCache.mts: a short-lived, in-process cache of the FULL list a NMBRS
 * list tool fetched, so the later pages of one paged read are served from it.
 *
 * Why: the SOAP calls behind the NMBRS list tools return the whole list at
 * once and the tool pages over the parsed array. Without a cache every page
 * costs one heavy SOAP call, so reading a large company page by page made
 * about 75 calls where about 5 do.
 *
 * Rules (see also the callers in nmbrsBulkTools.js and nmbrsTools.js):
 *   - Memory only: no Redis, no disk, no database. A restart empties it.
 *   - The key holds the organisation, the user, a FINGERPRINT of the NMBRS
 *     credentials (an HMAC under a per-process random key: the secret itself
 *     is never part of a key, a log line or a stat), the tool, the company
 *     and every argument that changes the full list. Offset and limit are not
 *     part of it.
 *   - The FIRST page (`fresh: true`) always fetches and replaces the entry,
 *     so a new run never reads an old list. A later page reads the entry when
 *     it is fresh and fetches (and stores) otherwise.
 *   - Concurrent requests for one key share one in-flight fetch. A failed
 *     fetch is never stored; every waiting caller gets the same error.
 *   - Entries expire after `ttlMs` (lazily, there is no timer, so nothing
 *     keeps the process alive) and the cache is bounded in entries and in
 *     total rows, least recently used first.
 *   - PRIVACY: the rows held here are exactly what the tool would return
 *     after its field allow-list. Nothing in this module logs or counts row
 *     contents; the stats hold counts per tool name only.
 *
 * Limits are configurable, none is hard: `0` means unlimited for the bounds
 * and disabled for the TTL (NMBRS_PAGE_CACHE_*, see readPageCacheConfig).
 */

import { createHmac, randomBytes } from 'node:crypto';

export const DEFAULT_TTL_MS = 120_000;
export const DEFAULT_MAX_ENTRIES = 50;
export const DEFAULT_MAX_ITEMS = 200_000;

export interface PageCacheConfig {
    /** How long a fetched list stays usable. 0 disables the cache altogether. */
    ttlMs: number;
    /** Most lists held at once. 0 = unlimited. */
    maxEntries: number;
    /** Most rows held over all lists. 0 = unlimited. */
    maxItems: number;
}

export type CacheOutcome = 'hit' | 'miss' | 'refresh' | 'shared' | 'bypass';
export type CacheCount = CacheOutcome | 'evicted';

export interface PageCacheKeyParts {
    orgId: string | null | undefined;
    userId: string;
    /** From credentialFingerprint(): never the secret. */
    credential: string;
    tool: string;
    companyId: string;
    /** Every argument that changes the full list, but never offset or limit. */
    args: Record<string, unknown>;
}

export interface PageCacheOptions extends Partial<PageCacheConfig> {
    now?: () => number;
    /** Called once per request with the outcome. Carries no row data. */
    onOutcome?: (tool: string, outcome: CacheOutcome) => void;
}

interface Entry {
    rows: unknown[];
    expiresAt: number;
    orgId: string;
    userId: string;
    tool: string;
}

interface Inflight {
    promise: Promise<unknown[]>;
    orgId: string;
    userId: string;
    /** Set when the entry's owner was invalidated while the fetch ran: the result is returned but not stored. */
    discarded: boolean;
}

/** A non-negative whole number from an env value; anything else gives the default. */
function wholeNumber(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function readPageCacheConfig(env: Record<string, string | undefined> = process.env): PageCacheConfig {
    return {
        ttlMs: wholeNumber(env.NMBRS_PAGE_CACHE_TTL_MS, DEFAULT_TTL_MS),
        maxEntries: wholeNumber(env.NMBRS_PAGE_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES),
        maxItems: wholeNumber(env.NMBRS_PAGE_CACHE_MAX_ITEMS, DEFAULT_MAX_ITEMS),
    };
}

// Keyed per process, so a fingerprint cannot be compared with one from another
// process or run offline against a guessed token.
const FINGERPRINT_KEY = randomBytes(32);

export interface FingerprintInput {
    mode: string;
    env: string;
    subdomain: string;
    email: string;
    token: string;
}

/** Identity of a NMBRS connection for the cache key. A changed token, tenant, mode or environment gives another value. */
export function credentialFingerprint(creds: FingerprintInput): string {
    return createHmac('sha256', FINGERPRINT_KEY)
        .update([creds.mode, creds.env, creds.subdomain, creds.email, creds.token].join('\u0000'))
        .digest('hex')
        .slice(0, 24);
}

/** Deterministic JSON: object keys sorted, so the order of args never splits an entry. */
function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

export function buildCacheKey(parts: PageCacheKeyParts): string {
    return stableStringify([parts.orgId ?? '', parts.userId, parts.credential, parts.tool, parts.companyId, parts.args]);
}

export class PageCache {
    private readonly config: PageCacheConfig;
    private readonly now: () => number;
    private readonly onOutcome: ((tool: string, outcome: CacheOutcome) => void) | undefined;
    // Map order is recency order: the first key is the least recently used.
    private readonly entries = new Map<string, Entry>();
    private readonly inflight = new Map<string, Inflight>();
    private readonly counts = new Map<string, Record<CacheCount, number>>();
    private items = 0;

    constructor(options: PageCacheOptions = {}) {
        const defaults = readPageCacheConfig({});
        this.config = {
            ttlMs: options.ttlMs ?? defaults.ttlMs,
            maxEntries: options.maxEntries ?? defaults.maxEntries,
            maxItems: options.maxItems ?? defaults.maxItems,
        };
        this.now = options.now ?? Date.now;
        this.onOutcome = options.onOutcome;
    }

    get enabled(): boolean {
        return this.config.ttlMs > 0;
    }

    /**
     * The full list for `parts`, from the cache or from `fetchRows`.
     * `fresh` is true for the first page of a read: it never reads the cache.
     */
    async load(
        parts: PageCacheKeyParts,
        fetchRows: () => Promise<unknown[]>,
        options: { fresh: boolean },
    ): Promise<{ rows: unknown[]; outcome: CacheOutcome }> {
        const { tool } = parts;
        if (!this.enabled) {
            const rows = await fetchRows();
            return { rows, outcome: this.record(tool, 'bypass') };
        }
        const key = buildCacheKey(parts);
        if (options.fresh) {
            // A new run replaces what an older one left; if the fetch fails nothing stale remains.
            this.drop(key);
        } else {
            const entry = this.entries.get(key);
            if (entry && entry.expiresAt > this.now()) {
                this.entries.delete(key);
                this.entries.set(key, entry);
                return { rows: entry.rows, outcome: this.record(tool, 'hit') };
            }
            if (entry) this.drop(key);
        }
        const running = this.inflight.get(key);
        if (running) {
            const rows = await running.promise;
            return { rows, outcome: this.record(tool, 'shared') };
        }
        const record: Inflight = { discarded: false, orgId: parts.orgId ?? '', userId: parts.userId, promise: Promise.resolve([]) };
        record.promise = fetchRows().then(
            (rows) => {
                if (this.inflight.get(key) === record) {
                    this.inflight.delete(key);
                    if (!record.discarded) this.store(key, parts, rows);
                }
                return rows;
            },
            (err: unknown) => {
                if (this.inflight.get(key) === record) this.inflight.delete(key);
                throw err;
            },
        );
        this.inflight.set(key, record);
        const rows = await record.promise;
        return { rows, outcome: this.record(tool, options.fresh ? 'refresh' : 'miss') };
    }

    /** Remove every list of one user, e.g. when that user's NMBRS connection changed or was removed. */
    invalidateUser(userId: string): void {
        this.invalidateWhere((meta) => meta.userId === userId);
    }

    /** Remove every list of one organisation. */
    invalidateOrg(orgId: string): void {
        this.invalidateWhere((meta) => meta.orgId === orgId);
    }

    clear(): void {
        this.invalidateWhere(() => true);
    }

    /** Hits, misses and so on per tool name. No row data, no ids. */
    stats(): Record<string, Record<CacheCount, number>> {
        const out: Record<string, Record<CacheCount, number>> = {};
        for (const [tool, counts] of this.counts) out[tool] = { ...counts };
        return out;
    }

    get size(): { entries: number; items: number } {
        return { entries: this.entries.size, items: this.items };
    }

    private invalidateWhere(match: (meta: { orgId: string; userId: string }) => boolean): void {
        for (const [key, entry] of [...this.entries]) if (match(entry)) this.drop(key);
        for (const [key, running] of [...this.inflight]) {
            // A fetch that started before the invalidation must not write its (old) result back.
            if (match(running)) {
                running.discarded = true;
                this.inflight.delete(key);
            }
        }
    }

    private drop(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        this.items -= entry.rows.length;
    }

    private store(key: string, parts: PageCacheKeyParts, rows: unknown[]): void {
        const { maxEntries, maxItems, ttlMs } = this.config;
        this.drop(key);
        if (maxItems > 0 && rows.length > maxItems) return; // one list bigger than the whole budget is not kept
        this.entries.set(key, { rows, expiresAt: this.now() + ttlMs, orgId: parts.orgId ?? '', userId: parts.userId, tool: parts.tool });
        this.items += rows.length;
        this.evict(maxEntries, maxItems);
    }

    private evict(maxEntries: number, maxItems: number): void {
        const now = this.now();
        for (const [key, entry] of [...this.entries]) if (entry.expiresAt <= now) this.drop(key);
        for (const [key, entry] of this.entries) {
            const over = (maxEntries > 0 && this.entries.size > maxEntries) || (maxItems > 0 && this.items > maxItems);
            if (!over) break;
            this.drop(key);
            this.bump(entry.tool, 'evicted');
        }
    }

    private bump(tool: string, what: CacheCount): void {
        let counts = this.counts.get(tool);
        if (!counts) {
            counts = { hit: 0, miss: 0, refresh: 0, shared: 0, bypass: 0, evicted: 0 };
            this.counts.set(tool, counts);
        }
        counts[what] += 1;
    }

    private record(tool: string, outcome: CacheOutcome): CacheOutcome {
        this.bump(tool, outcome);
        this.onOutcome?.(tool, outcome);
        return outcome;
    }
}

let shared: PageCache | null = null;

/** The process-wide cache, built from the environment on first use. */
export function getPageCache(onOutcome?: (tool: string, outcome: CacheOutcome) => void): PageCache {
    if (!shared) shared = new PageCache({ ...readPageCacheConfig(), onOutcome });
    return shared;
}

/** Drop the process-wide cache (tests, and config reloads): the next call re-reads the environment. */
export function resetPageCache(): void {
    shared = null;
}
