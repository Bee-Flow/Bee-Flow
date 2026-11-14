/**
 * The pattern matcher of the route tables (`:name`, `:name?`, `*`). Its own
 * module so the public entry (AppRoutes.tsx) matches its few public paths
 * without loading the signed-in app's route table.
 */

const segmentsOf = (pathname: string) => pathname.split('/').filter(Boolean);

/** The named segments when `segments` fit `pattern`, else null. */
export function matchPattern(pattern: string, segments: readonly string[]): Record<string, string> | null {
    const parts = segmentsOf(pattern);
    const params: Record<string, string> = {};
    let at = 0;
    for (const part of parts) {
        if (part === '*') {
            params['*'] = segments.slice(at).join('/');
            return params;
        }
        if (part.startsWith(':')) {
            const optional = part.endsWith('?');
            const name = part.slice(1, optional ? -1 : undefined);
            if (at >= segments.length) {
                if (optional) continue;
                return null;
            }
            params[name] = segments[at++];
            continue;
        }
        if (segments[at++] !== part) return null;
    }
    return at === segments.length ? params : null;
}

/** The row of `routes` an address fits, with its params; null when none does. */
export function matchRoute<T extends { pattern: string }>(routes: readonly T[], pathname: string): { route: T; params: Record<string, string> } | null {
    const segments = segmentsOf(pathname);
    for (const route of routes) {
        const params = matchPattern(route.pattern, segments);
        if (params) return { route, params };
    }
    return null;
}
