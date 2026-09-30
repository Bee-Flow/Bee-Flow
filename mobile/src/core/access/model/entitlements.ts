/**
 * The port of agent-hub/src/components/licensing/EntitlementsContext.jsx:
 * `can`, `inCeiling` and `lockReason` over the GET /auth/my-entitlements
 * snapshot — the same resolver the server's requireCapability enforces, so a
 * row can never be offered while its API answers 403.
 *
 * Both namespaces are accepted: a capability id, or a legacy licence-feature
 * name that the registry maps to its capability (`licenseFeature`). The first
 * capability to claim a licence feature keeps it, as on the web.
 */

import type { CapabilityKind, CompiledEntitlements, Entitlements, KindLists, LockReason } from './types';

const KINDS: readonly CapabilityKind[] = ['core', 'beta', 'integration'];

/** One set over every bucket; an id belongs to exactly one kind on the server. */
function unionOf(lists: KindLists): Set<string> {
    const out = new Set<string>();
    for (const kind of KINDS) for (const id of lists[kind]) out.add(id);
    return out;
}

/** Licence-feature name (and capability id) → capability id. */
function idMapOf(registry: Entitlements['registry']): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of registry) {
        if (!row.id) continue;
        map.set(row.id, row.id);
        if (row.licenseFeature && !map.has(row.licenseFeature)) map.set(row.licenseFeature, row.id);
    }
    return map;
}

/** Build the lookups once per answer; the query layer caches the result per payload. */
export function compileEntitlements(data: Entitlements): CompiledEntitlements {
    const effective = unionOf(data.effective);
    const ceiling = unionOf(data.ceiling);
    const ids = idMapOf(data.registry);
    const resolveId = (id: string) => ids.get(id) ?? id;
    return {
        data,
        resolveId,
        has: (id) => effective.has(resolveId(id)),
        inCeiling: (id) => ceiling.has(resolveId(id)),
    };
}

/**
 * Why `id` is not usable, or null when it is. The web's expression, verbatim
 * in meaning: effective → null; in the ceiling → 'not_granted'; otherwise the
 * server's own reason, else 'ceiling'.
 */
export function lockReasonOf(compiled: CompiledEntitlements, id: string): LockReason | null {
    if (compiled.has(id)) return null;
    if (compiled.inCeiling(id)) return 'not_granted';
    return compiled.data.reasons[compiled.resolveId(id)] || 'ceiling';
}
