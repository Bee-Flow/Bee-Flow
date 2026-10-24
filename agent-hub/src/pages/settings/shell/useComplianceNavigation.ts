import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { rewriteComplianceNav, rewriteAdminEscape } from '../complianceNavAdapter';

export interface OrgDeepSegs { seg1: string; seg2: string }

/** Keeps admin-dashboard and Compliance Center navigation on the settings surface where it can. */
export function useComplianceNavigation(
    canSeeOrg: boolean,
    onNavigate: ((path: string) => void) | undefined,
    setOrgDeepSegs: Dispatch<SetStateAction<OrgDeepSegs>>,
    setActiveTabState: (id: string) => void,
) {
    // Admin-dashboard destinations that have an organisation-settings
    // equivalent (Privacy for guardrails/DLP, Usage → Safety for monitoring)
    // stay on the settings surface — but only when this user can see the
    // target tab; otherwise the caller falls through to the app router,
    // which is today's admin-dashboard behavior.
    const applyAdminEscape = useCallback((path: string) => {
        const esc = rewriteAdminEscape(path);
        if (!esc) return false;
        if (!canSeeOrg) return false;
        setOrgDeepSegs({ seg1: esc.seg1 || '', seg2: '' });
        setActiveTabState(esc.tab);
        if (window.location.pathname !== esc.url) window.history.pushState({}, '', esc.url);
        return true;
    }, [canSeeOrg, setActiveTabState, setOrgDeepSegs]);

    // ComplianceHub always emits admin-dashboard paths. Keep compliance-internal
    // navigation on the settings surface (deep URL incl. section/check id and
    // the header tab in `?tab=`), land remediation links on their settings
    // equivalents where possible, and forward the rest to the app router.
    // `{ replace: true }` is the hub redirecting a legacy link: the old URL
    // must not stay in the history, or Back would land on it again.
    const handleComplianceNavigate = useCallback((path: string, opts?: { replace?: boolean }) => {
        const hit = rewriteComplianceNav(path);
        if (hit) {
            setOrgDeepSegs({ seg1: hit.section, seg2: hit.checkId });
            setActiveTabState('org_compliance');
            if (window.location.pathname + window.location.search !== hit.url) {
                if (opts?.replace) window.history.replaceState({}, '', hit.url);
                else window.history.pushState({}, '', hit.url);
            }
            return;
        }
        if (applyAdminEscape(path)) return;
        onNavigate?.(path);
    }, [applyAdminEscape, onNavigate, setOrgDeepSegs, setActiveTabState]);

    return { handleComplianceNavigate };
}
