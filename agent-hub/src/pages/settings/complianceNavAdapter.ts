export interface ComplianceNav {
    section: string;
    checkId: string;
    tab: string;
    url: string;
}

/**
 * Rewrites ComplianceHub's admin-dashboard paths onto the Settings URL scheme.
 *
 * ComplianceHub always emits admin paths (`admin/compliance/<section>[/<checkId>][?query]`)
 * regardless of where it is mounted. When it lives inside Settings (a phone's
 * Compliance; the public demo) we keep the user on the settings surface by translating that one path family to
 * `/app/settings/organisation/compliance/...`.
 *
 * The query (the hub's header tab, `?tab=calendar`) is KEPT on `url` and
 * returned as `tab`: the hub re-reads `?tab=` whenever the pathname changes,
 * so a URL pushed without it would land on the section's first tab.
 *
 * Returns null for any non-compliance path: the caller forwards that one to the
 * app router (the admin dashboard, where the remediation pages live).
 */
export function rewriteComplianceNav(path?: string | null): ComplianceNav | null {
    const m = /^admin\/compliance(?:\/([^/?#]+))?(?:\/([^?#]+))?(?:\?([^#]*))?$/.exec(path || '');
    if (!m) return null;
    const section = m[1] || 'overview';
    const query = m[3] || '';
    let tab = '';
    try { tab = new URLSearchParams(query).get('tab') || ''; } catch { tab = ''; }
    let checkId = '';
    if (m[2]) { try { checkId = decodeURIComponent(m[2]); } catch { checkId = m[2]; } }
    return {
        section,
        checkId,
        tab,
        url: `/app/settings/organisation/compliance/${section}${m[2] ? `/${m[2]}` : ''}${query ? `?${query}` : ''}`,
    };
}
