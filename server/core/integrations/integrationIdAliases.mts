/**
 * One integration, two ids: the aliases the gates must treat as the same app.
 *
 * The catalogue id is canonical. It is what the capability registry
 * (core/entitlements/capabilityRegistry.js), the client catalogue
 * (agent-hub/src/config/integrationCatalog.ts), the Access and Global Defaults
 * screens and therefore every stored organisation allow-list and entitlement
 * grant use. An older id lives on in places written before the catalogue
 * existed: the per-user app toggles (agent-hub components/apps/appCatalog.tsx
 * stores `google-maps` in `enabled_apps_user_<id>`), and possibly in old
 * organisation lists.
 *
 * Google Maps was gated on `google-maps` at runtime while the catalogue, the
 * registry and every admin switch said `maps`. `google-maps` is not a registry
 * id, so the runtime gate fell back to the legacy allow-list check and dropped
 * the Maps tools for every organisation with an explicit list, even one that
 * had granted `maps`. Every gate now asks through this module: it turns the id
 * it is asked about into the canonical one, and looks a list up under every
 * alias.
 *
 * A new alias is one line in LEGACY_TO_CANONICAL; integrationIdAliases.test.js
 * checks that each canonical id is a registry integration.
 */

/** Legacy id → canonical (catalogue) id. */
const LEGACY_TO_CANONICAL: Readonly<Record<string, string>> = Object.freeze({
    'google-maps': 'maps',
});

/** Canonical id → every id that means it, canonical first. */
const ALIASES_OF_CANONICAL: ReadonlyMap<string, readonly string[]> = (() => {
    const out = new Map<string, string[]>();
    for (const [legacy, canonical] of Object.entries(LEGACY_TO_CANONICAL)) {
        const ids = out.get(canonical) ?? [canonical];
        ids.push(legacy);
        out.set(canonical, ids);
    }
    return out;
})();

/** The canonical (catalogue) id for an integration id; an id without an alias is returned as is. */
export function canonicalIntegrationId(appId: string): string {
    return Object.hasOwn(LEGACY_TO_CANONICAL, appId) ? LEGACY_TO_CANONICAL[appId] : appId;
}

/** Every id that names the same integration as `appId`, canonical first. */
export function integrationIdAliases(appId: string): readonly string[] {
    const canonical = canonicalIntegrationId(appId);
    return ALIASES_OF_CANONICAL.get(canonical) ?? [canonical];
}

/** Does `list` name this integration under any of its ids? */
export function listHasIntegration(list: Iterable<unknown> | null | undefined, appId: string): boolean {
    if (!list) return false;
    const ids = integrationIdAliases(appId);
    if (list instanceof Set) return ids.some((id) => list.has(id));
    const arr = Array.from(list);
    return ids.some((id) => arr.includes(id));
}

/** The legacy-to-canonical table, for tests and diagnostics. */
export function integrationIdAliasTable(): Readonly<Record<string, string>> {
    return LEGACY_TO_CANONICAL;
}
