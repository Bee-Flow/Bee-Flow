/**
 * Is the Nextcloud uid stored on a Bee Flow user still a live account with
 * that user's e-mail address?
 *
 * Nextcloud lets two accounts carry one address, and Bee Flow finds its user
 * by address. The sign-in asks this question when the uid of the signed token
 * is not the uid stored on the user it found: a stored uid that is a live
 * account with the same address is another account, and the stored uid then
 * stays as it is.
 *
 * The answer is yes only on a definite reading, taken as the organisation's
 * stored Nextcloud admin (only an administrator is told whether an account is
 * enabled): the record is about the stored uid itself, it is enabled, and its
 * address is the one asked about. A read that fails or takes too long, a
 * missing account, a disabled one, an answer in another shape or without the
 * enabled flag, and an organisation without a stored admin are all "no".
 *
 * The read goes through the sync's signed proxy call, which is bound to the
 * one organisation passed in; nothing here reads or writes Bee Flow users.
 */

import { createRequire } from 'node:module';
import { readEnabled, type NcOrgRef, type NcProxyFetch } from './ncAccountState.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log.js') as { warn: (...a: unknown[]) => void };

function envNumber(name: string, fallback: number): number {
    const raw = Number.parseInt(String(process.env[name] ?? ''), 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** How long a "yes" is remembered (NEXTCLOUD_UID_CONFLICT_CACHE_SECONDS, default 60; 0 = ask every time). */
export function conflictCacheMs(): number {
    return envNumber('NEXTCLOUD_UID_CONFLICT_CACHE_SECONDS', 60) * 1000;
}

/** How long the sign-in waits for the read (NEXTCLOUD_UID_CONFLICT_WAIT_MS, default 5000; 0 = no limit). */
export function conflictWaitMs(): number {
    return envNumber('NEXTCLOUD_UID_CONFLICT_WAIT_MS', 5000);
}

const CACHE_MAX = 5000;
const liveUntil = new Map<string, number>();

/** Test hook: forget every remembered answer. */
export function resetStoredUidCache(): void { liveUntil.clear(); }

function sameAddress(a: unknown, b: unknown): boolean {
    const x = String(a ?? '').trim().toLowerCase();
    return x !== '' && x === String(b ?? '').trim().toLowerCase();
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readLive(org: NcOrgRef, storedUid: string, email: string, ncProxyFetch: NcProxyFetch): Promise<boolean> {
    const adminUid = String(org.nc_admin_uid || org.ncAdminUid || '');
    if (!adminUid) return false;
    const body = await ncProxyFetch(org, `/ocs/v2.php/cloud/users/${encodeURIComponent(storedUid)}?format=json`, adminUid);
    const data = body?.ocs?.data;
    if (!isRecord(data) || String(data.id ?? '') !== storedUid) return false;
    return readEnabled(data) === true && sameAddress(data.email, email);
}

/** The read, or false once the wait is over (the read itself is left to finish on its own). */
function withinWait(read: Promise<boolean>, waitMs: number): Promise<boolean> {
    if (waitMs <= 0) return read;
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), waitMs);
        read.then(
            (v) => { clearTimeout(timer); resolve(v); },
            () => { clearTimeout(timer); resolve(false); },
        );
    });
}

/**
 * True only when Nextcloud says, to the organisation's stored admin, that
 * `storedUid` is an enabled account with this e-mail address. Never throws.
 */
export async function storedUidIsLiveWithEmail(
    org: NcOrgRef | null | undefined,
    storedUid: string,
    email: string,
    ncProxyFetch?: NcProxyFetch,
): Promise<boolean> {
    if (!org?.id || !storedUid || !email) return false;
    const key = `${org.id}|${storedUid}|${String(email).trim().toLowerCase()}`;
    const now = Date.now();
    const until = liveUntil.get(key);
    if (until !== undefined) {
        if (until > now) return true;
        liveUntil.delete(key);
    }
    let live = false;
    try {
        // The sync's own signed call, loaded on first use.
        const fetchAs = ncProxyFetch || (nodeRequire('./ncUserGroupSync.js') as { ncProxyFetch: NcProxyFetch }).ncProxyFetch;
        const read = readLive(org, storedUid, email, fetchAs).catch((err: unknown) => {
            log.warn(`[ncSync] stored uid read failed for org ${org.id}: ${(err as Error)?.message}`);
            return false;
        });
        live = await withinWait(read, conflictWaitMs());
    } catch {
        live = false;
    }
    const keepMs = conflictCacheMs();
    if (live && keepMs > 0) {
        if (liveUntil.size >= CACHE_MAX) liveUntil.clear();
        liveUntil.set(key, now + keepMs);
    }
    return live;
}
