/**
 * Which apps a skill may be granted — the web's CanUseCard catalogue filter
 * (AgentDesigner/integrationAvailability.js), on the phone's catalogue.
 *
 * UNKNOWN NEVER WIDENS A GRANT: while the org's allow-list has not answered,
 * or the read failed, only the platform built-ins are offered. Offering more
 * apps than the org actually has would be a grant the runtime then refuses.
 * The per-provider "is a key configured" gates of the web filter are left to
 * the runtime, which re-checks every grant at dispatch time anyway.
 */

/** Tools the platform always provides, whatever the org allows. */
export const ALWAYS_AVAILABLE: ReadonlySet<string> = new Set(['agent-search']);

export function availableApps<T extends { id: string }>(
    catalog: readonly T[],
    orgEnabled: readonly string[] | null | undefined,
    known: boolean,
): T[] {
    if (!known) return catalog.filter((a) => ALWAYS_AVAILABLE.has(a.id));
    return catalog.filter((a) => ALWAYS_AVAILABLE.has(a.id) || !orgEnabled || orgEnabled.includes(a.id));
}

/** Add or drop one id; returns a new list. */
export function toggleId(list: readonly string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}
