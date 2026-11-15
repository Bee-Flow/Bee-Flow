/**
 * One integration, two ids. The catalogue id (integrationCatalog.ts, the
 * server's capability registry, every organisation allow-list) is canonical;
 * the older id lives on in the per-user app toggles (components/apps/appCatalog.tsx)
 * and possibly in old organisation lists. Mirror of the server's
 * core/integrations/integrationIdAliases.mts: keep the two tables equal.
 */

const LEGACY_TO_CANONICAL: Readonly<Record<string, string>> = Object.freeze({
    'google-maps': 'maps',
});

/** The canonical (catalogue) id; an id without an alias is returned as is. */
export function canonicalIntegrationId(id: string): string {
    return Object.hasOwn(LEGACY_TO_CANONICAL, id) ? LEGACY_TO_CANONICAL[id] : id;
}

/** Does `list` name this integration under any of its ids? */
export function listHasIntegration(list: readonly string[] | null | undefined, id: string): boolean {
    if (!list) return false;
    const canonical = canonicalIntegrationId(id);
    return list.some((entry) => canonicalIntegrationId(entry) === canonical);
}
