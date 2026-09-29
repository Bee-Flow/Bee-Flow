/**
 * Should the entry chunk pre-fetch the AuthedApp bundle (and the i18n
 * catalogue) for this pathname?
 *
 * Standalone the answer is "on /app*". Embedded inside Nextcloud the SPA IS
 * the authed product but the pathname is Nextcloud's, not ours:
 *
 *   /index.php/apps/app_api/proxy/<appId>/…   AppAPI proxy, index.php URLs
 *   /apps/app_api/proxy/<appId>/…             AppAPI proxy, pretty URLs
 *   /exapps/<appId>/…                         HaRP direct path
 *
 * The pretty-URL form happened to match startsWith('/app') by accident, the
 * other two never did — so whether the embed paid an extra serial round-trip
 * for the app chunk depended on the customer's rewrite config ("sometimes
 * slow"). Matching all three makes the warm-up deterministic.
 */
export function shouldWarmAuthedApp(pathname) {
    if (typeof pathname !== 'string') return false;
    if (pathname.startsWith('/app')) return true;
    return pathname.includes('/apps/app_api/proxy/') || pathname.startsWith('/exapps/');
}
