/**
 * An organisation's Cowork policy, set by its administrators (routes/coworkPolicyRoutes.js):
 *
 *   ceiling         the most independent level any of its coworks may run at (core/cowork/plan/planIndependence.mts);
 *                   a run above it runs at the ceiling, a level above it cannot be chosen;
 *   readOnly        every cowork of the organisation is read-only: nothing runs, nothing is created or changed;
 *   unattendedApps  the apps a plan may use while nobody watches (null: every app). A plan that uses another app is
 *                   not approved, and an approved one that does no longer runs.
 *
 * Stored under `org_cowork_policy_<orgId>` in configStore; nothing stored is the open policy. Reading fails CLOSED:
 * a policy that cannot be read is the strictest one (read-only), so an administrator's switch never stops counting
 * because the store had a bad moment. A person without an organisation has the open policy.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
type ConfigStore = { getConfig: (key: string) => Promise<unknown>; setConfig: (key: string, value: unknown) => Promise<unknown> };
const configStore = (): ConfigStore => nodeRequire('../../stores/configStore.js') as ConfigStore;

export type Level = 'asks_everything' | 'asks_before_sending' | 'on_its_own';
const ORDER: readonly Level[] = Object.freeze(['asks_everything', 'asks_before_sending', 'on_its_own']);

export interface CoworkPolicy {
    ceiling: Level;
    readOnly: boolean;
    unattendedApps: string[] | null;
    /** The policy could not be read: it is the strictest one, and says so. */
    unreadable?: boolean;
}

export const OPEN_POLICY: Readonly<CoworkPolicy> = Object.freeze({ ceiling: 'on_its_own', readOnly: false, unattendedApps: null });
const STRICTEST: Readonly<CoworkPolicy> = Object.freeze({ ceiling: 'asks_everything', readOnly: true, unattendedApps: [], unreadable: true });

const keyOf = (orgId: string): string => `org_cowork_policy_${orgId}`;
const isLevel = (v: unknown): v is Level => typeof v === 'string' && (ORDER as readonly string[]).includes(v);

/** A stored blob (or nothing) as a policy; what is not understood is the open value of that field. */
export function normalizePolicy(stored: unknown): CoworkPolicy {
    const s = stored && typeof stored === 'object' ? stored as Record<string, unknown> : {};
    const apps = Array.isArray(s.unattendedApps)
        ? [...new Set(s.unattendedApps.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim()))].sort()
        : null;
    return { ceiling: isLevel(s.ceiling) ? s.ceiling : 'on_its_own', readOnly: s.readOnly === true, unattendedApps: apps };
}

/** The level a run uses under a ceiling: the lower of the two. */
export function capLevel(level: Level, ceiling: Level): Level {
    return ORDER.indexOf(level) <= ORDER.indexOf(ceiling) ? level : ceiling;
}

/** Is `level` above the ceiling? */
export const aboveCeiling = (level: Level, ceiling: Level): boolean => ORDER.indexOf(level) > ORDER.indexOf(ceiling);

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; policy: CoworkPolicy }>();

/** The policy of an organisation; the open one without an organisation. Never throws. */
export async function resolveCoworkPolicy(orgId: string | null | undefined, store: ConfigStore = configStore()): Promise<CoworkPolicy> {
    if (!orgId) return { ...OPEN_POLICY };
    const hit = cache.get(orgId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.policy;
    let policy: CoworkPolicy;
    try {
        policy = normalizePolicy(await store.getConfig(keyOf(orgId)));
    } catch {
        return { ...STRICTEST };
    }
    cache.set(orgId, { at: Date.now(), policy });
    return policy;
}

/** Change some fields of an organisation's policy; answers the policy as stored. */
export async function setCoworkPolicy(orgId: string, patch: Partial<CoworkPolicy>, store: ConfigStore = configStore()): Promise<CoworkPolicy> {
    const current = normalizePolicy(await store.getConfig(keyOf(orgId)));
    const next = normalizePolicy({ ...current, ...patch });
    await store.setConfig(keyOf(orgId), next);
    cache.delete(orgId);
    return next;
}

/** The policy of the organisation an owner belongs to. A user that cannot be read has the strictest policy. */
export async function policyOfOwner(userId: string, deps: { getUser?: (id: string) => Promise<{ organizationId?: string | null } | null>; resolve?: typeof resolveCoworkPolicy } = {}): Promise<CoworkPolicy> {
    const getUser = deps.getUser ?? ((id: string) => (nodeRequire('../../stores/userStore.js') as { getUser: (id: string) => Promise<{ organizationId?: string | null } | null> }).getUser(id));
    let orgId: string | null;
    try {
        orgId = (await getUser(userId))?.organizationId ?? null;
    } catch {
        return { ...STRICTEST };
    }
    return (deps.resolve ?? resolveCoworkPolicy)(orgId);
}

/** Why the policy stops a run of this owner, or null. */
export function runRefusalOf(policy: CoworkPolicy): string | null {
    if (policy.unreadable) return 'The organisation\'s Cowork policy could not be read, so this run did not start.';
    if (policy.readOnly) return 'Your organisation has made Cowork read-only: nothing runs or changes until an administrator switches that off.';
    return null;
}

/** The apps of a plan that may not run unattended under this policy. */
export function appsNotAllowed(apps: readonly string[], policy: CoworkPolicy): string[] {
    if (policy.unattendedApps === null) return [];
    const allowed = new Set(policy.unattendedApps);
    return [...new Set(apps)].filter((a) => !allowed.has(a));
}

/** Tests: forget what was read. */
export function _clearCoworkPolicyCache(): void {
    cache.clear();
}
