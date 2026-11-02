/**
 * Whether `url` falls under one of a module manifest's `server.publicRoutes`
 * prefixes (modules/packageActivation.js). A prefix covers itself and the
 * paths below it, on a segment boundary: `/hook` covers `/hook` and `/hook/x`,
 * not `/hookup`. A path with a `..` segment is never public.
 */
export function isPublicRoute(prefixes: readonly unknown[], url: string): boolean {
    const pathname = String(url || '/').split(/[?#]/)[0];
    if (/(^|\/)\.\.(\/|$)/.test(pathname)) return false;
    return prefixes.some((p) => {
        if (typeof p !== 'string' || !p) return false;
        if (p.endsWith('/')) return pathname.startsWith(p) || pathname === p.slice(0, -1);
        return pathname === p || pathname.startsWith(`${p}/`);
    });
}
