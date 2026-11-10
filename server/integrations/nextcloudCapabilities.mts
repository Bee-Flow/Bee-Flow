/**
 * The capabilities a Nextcloud server publishes for one user
 * (`/ocs/v2.php/cloud/capabilities`), read once and shared: the Talk recording
 * probe (./nextcloudTalkTools.js) and the tool assembly for chat and agents
 * (core/integrations/integrationToolFeatures.js) ask here.
 *
 * Cached per user, not per server: the answer carries per-user values (the
 * Talk attachment folder), and an app can be enabled for some groups only.
 *
 * For a tool family the answer is one of three:
 *   present   the read succeeded and the app's capability is in it
 *   absent    the read succeeded, the app is one that publishes a capability,
 *             and it is not in the answer
 *   unknown   anything else: the read failed or took too long, the answer is
 *             not a capabilities document, or the app publishes no capability
 *             to look for (Mail, and the families that speak CalDAV, CardDAV
 *             or WebDAV)
 * Only `absent` is a reason to leave a family out.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type NcResponse = { ok: boolean; status: number; text: () => Promise<string> };
type NcAuthContext = {
    baseUrl: string;
    uid?: string | null;
    fetch: (url: string, options?: { headers?: Record<string, string> }) => Promise<NcResponse>;
};
// The module object is kept whole so a replaced `resolveAuth` is seen at call time.
const ncClient = nodeRequire('./nextcloudClient.js') as {
    resolveAuth: (session: unknown, userId: string) => Promise<NcAuthContext>;
};
const { readJsonSafe, COMMON_HEADERS } = nodeRequire('./nextcloudTalkHttp.js') as {
    readJsonSafe: (res: { text: () => Promise<string> }) => Promise<unknown>;
    COMMON_HEADERS: Record<string, string>;
};

export type AppPresence = 'present' | 'absent' | 'unknown';

/** One read of the capabilities document. */
export interface CapabilitiesRead {
    /** The server answered 2xx. */
    ok: boolean;
    /** `ocs.data.capabilities` when the answer carried one, else null. */
    capabilities: Record<string, unknown> | null;
}

/**
 * The capability key each tool family's app publishes. A family that is not
 * listed is never `absent`: Files, Calendar, Contacts and Tasks speak
 * WebDAV/CalDAV/CardDAV, which the server itself provides, and for Mail,
 * Notifications and User status no capability is relied on here.
 */
const FAMILY_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
    'nextcloud-deck': 'deck',
    'nextcloud-talk': 'spreed',
    'nextcloud-notes': 'notes',
    'nextcloud-activity': 'activity',
    'nextcloud-tables': 'tables',
    'nextcloud-forms': 'forms',
    'nextcloud-teams': 'circles',
});

const FAILED: CapabilitiesRead = Object.freeze({ ok: false, capabilities: null });

// A non-2xx answer is not a definite answer: a proxy 502/504, or a 503 from
// maintenance mode that outlasts the client's retries, is gone a minute later.
// It is held briefly, so a burst of callers during an outage shares one
// request and the next caller after that asks again.
const FAILURE_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 5000;

type CacheEntry = { ts: number; ttl: number; val: CapabilitiesRead };
const cache = new Map<string, CacheEntry>(); // `${baseUrl}|${uid}`
const inFlight = new Map<string, Promise<CapabilitiesRead>>();

function envNumber(name: string, fallback: number): number {
    const raw = Number.parseInt(String(process.env[name] ?? ''), 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** How long a successful read is kept. NEXTCLOUD_CAPABILITIES_CACHE_SECONDS, default 600; 0 = read every time. */
function cacheTtlMs(): number {
    return envNumber('NEXTCLOUD_CAPABILITIES_CACHE_SECONDS', 600) * 1000;
}

/** How long tool assembly waits for the read. NEXTCLOUD_CAPABILITIES_WAIT_MS, default 5000; 0 = no limit. */
function waitLimitMs(): number {
    return envNumber('NEXTCLOUD_CAPABILITIES_WAIT_MS', 5000);
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function remember(key: string, ttl: number, val: CapabilitiesRead): void {
    if (ttl <= 0) return;
    if (cache.size >= MAX_ENTRIES) {
        const now = Date.now();
        for (const [k, e] of cache) if (now - e.ts >= e.ttl) cache.delete(k);
        if (cache.size >= MAX_ENTRIES) cache.clear();
    }
    cache.set(key, { ts: Date.now(), ttl, val });
}

async function fetchCapabilities(ctx: NcAuthContext, key: string): Promise<CapabilitiesRead> {
    const res = await ctx.fetch(`${ctx.baseUrl}/ocs/v2.php/cloud/capabilities?format=json`, { headers: COMMON_HEADERS });
    const ttl = cacheTtlMs();
    if (!res.ok) {
        remember(key, Math.min(FAILURE_TTL_MS, ttl), FAILED);
        return FAILED;
    }
    const data = await readJsonSafe(res);
    const ocs = isRecord(data) && isRecord(data.ocs) && isRecord(data.ocs.data) ? data.ocs.data : null;
    const val: CapabilitiesRead = { ok: true, capabilities: ocs && isRecord(ocs.capabilities) ? ocs.capabilities : null };
    remember(key, ttl, val);
    return val;
}

/**
 * The capabilities document for this user, from the cache when it is fresh.
 * Never throws: no connection, a thrown request and a non-2xx answer all read
 * as `{ ok: false }`.
 */
export async function readNextcloudCapabilities(session: unknown, userId: string): Promise<CapabilitiesRead> {
    let ctx: NcAuthContext;
    try { ctx = await ncClient.resolveAuth(session, userId); }
    catch { return FAILED; }
    const key = `${ctx.baseUrl}|${ctx.uid || ''}`;
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.ts) < cached.ttl) return cached.val;
    const running = inFlight.get(key);
    if (running) return running;
    const read = fetchCapabilities(ctx, key).catch(() => FAILED).finally(() => { inFlight.delete(key); });
    inFlight.set(key, read);
    return read;
}

/** Present, absent or unknown for one tool family (`nextcloud-deck`, ...) given a read. */
export function familyPresence(read: CapabilitiesRead | null | undefined, familyId: string): AppPresence {
    const capability = FAMILY_CAPABILITY[familyId];
    if (!capability || !read || !read.ok || !read.capabilities) return 'unknown';
    // Every Nextcloud answer carries `core`; without it this is not a
    // capabilities document and says nothing about any app.
    if (!Object.hasOwn(read.capabilities, 'core')) return 'unknown';
    return Object.hasOwn(read.capabilities, capability) ? 'present' : 'absent';
}

/**
 * The presence of every tool family for this user, as a lookup. The read is
 * waited for at most the configured limit; past it every family is `unknown`
 * for this call and the read finishes into the cache for the next one.
 */
export async function nextcloudFamilyPresence(session: unknown, userId: string): Promise<(familyId: string) => AppPresence> {
    const limit = waitLimitMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reading = readNextcloudCapabilities(session, userId).catch(() => FAILED);
    const read = limit > 0
        ? await Promise.race([
            reading,
            new Promise<CapabilitiesRead>((resolve) => { timer = setTimeout(() => resolve(FAILED), limit); }),
        ])
        : await reading;
    if (timer) clearTimeout(timer);
    return (familyId) => familyPresence(read, familyId);
}

/** Tests only: forget every cached read. */
export function _resetCapabilitiesCache(): void {
    cache.clear();
    inFlight.clear();
}
