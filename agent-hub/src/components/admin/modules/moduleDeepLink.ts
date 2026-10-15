// ?module=<id> deep link for the module detail drawer. Pure helpers, unit
// tested. Distinct from purchaseReturn.js: when a `purchase` param is present
// the URL is a Stripe Checkout return (which owns — and strips — `module`),
// NOT a drawer deep link.

/** Module id to open the drawer for, or null. */
/** The location fields the helpers read (window.location satisfies this). */
export interface DeepLinkLocation {
    pathname: string;
    search?: string;
    hash?: string;
}

export function parseModuleDeepLink(search: string | null | undefined): string | null {
    const params = new URLSearchParams(search || '');
    if (params.get('purchase')) return null; // Checkout return, not a deep link
    return params.get('module') || null;
}

/** Relative URL with ?module=<id> set (other params kept) — drawer opened. */
export function searchWithModule(moduleId: string, loc: DeepLinkLocation = window.location): string {
    const params = new URLSearchParams(loc.search || '');
    params.set('module', moduleId);
    return `${loc.pathname}?${params.toString()}${loc.hash || ''}`;
}

/** Relative URL with the module param removed — drawer closed. */
export function searchWithoutModule(loc: DeepLinkLocation = window.location): string {
    const params = new URLSearchParams(loc.search || '');
    params.delete('module');
    const qs = params.toString();
    return `${loc.pathname}${qs ? `?${qs}` : ''}${loc.hash || ''}`;
}
