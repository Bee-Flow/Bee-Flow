/**
 * The in-process cache in front of the `config` table (stores/configStore.js).
 *
 * Config values change rarely, so serving them from memory for 60 s saves several
 * queries per KB search. "This key does not exist" is cached too (value null), or
 * every read of an unset key would be a query.
 *
 * The cache is bounded. Its keys are open-ended (per organisation, per user, per
 * secret, and every unset key somebody asked for), and an expired entry is only
 * removed by a read of exactly that key, so without a bound the map grows with the
 * number of keys ever read. Above CONFIG_CACHE_MAX entries a write drops the expired
 * entries and then the oldest ones. A dropped entry costs one extra read of the table.
 */

import { envInt } from '../utils/envNumber.mts';

/** How long an entry is served. */
export const CACHE_TTL_MS = 60_000;

/** The most entries kept (CONFIG_CACHE_MAX, default 5000). */
export const CACHE_MAX = envInt('CONFIG_CACHE_MAX', 5000, { min: 100 });

interface Entry { value: unknown; ts: number }

const cache = new Map<string, Entry>();

/**
 * The cached value, or `undefined` on a miss (never cached, or expired).
 * `null` is a hit: the key is known to have no value.
 */
export function cacheGet(key: string): unknown {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        cache.delete(key);
        return undefined;
    }
    return entry.value;
}

export function cacheSet(key: string, value: unknown): void {
    // Delete first, so the key moves to the newest position: the map's insertion
    // order is then the order of the timestamps, which evict() relies on.
    cache.delete(key);
    cache.set(key, { value, ts: Date.now() });
    if (cache.size > CACHE_MAX) evict();
}

/** Drop the expired entries, then the oldest ones, until the cache fits again. */
function evict(): void {
    const now = Date.now();
    for (const [key, entry] of cache) {
        // Oldest first: once the cache fits and this entry is still fresh, so is every later one.
        if (cache.size <= CACHE_MAX && now - entry.ts <= CACHE_TTL_MS) break;
        cache.delete(key);
    }
}

export function cacheInvalidate(key: string): void {
    cache.delete(key);
}

export function cacheClear(): void {
    cache.clear();
}

/** The number of entries held, expired ones included (for tests and diagnostics). */
export function cacheSize(): number {
    return cache.size;
}
