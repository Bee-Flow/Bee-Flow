import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { rewriteComplianceNav } from '../complianceNavAdapter';

export interface OrgDeepSegs { seg1: string; seg2: string }

/** Keeps the Compliance Center's own navigation on the settings surface (a phone's); the rest goes to the app router. */
export function useComplianceNavigation(
    onNavigate: ((path: string) => void) | undefined,
    setOrgDeepSegs: Dispatch<SetStateAction<OrgDeepSegs>>,
    setActiveTabState: (id: string) => void,
) {
    // ComplianceHub always emits admin-dashboard paths. Keep compliance-internal
    // navigation on the settings surface (deep URL incl. section/check id and
    // the header tab in `?tab=`), and forward the rest (remediation links) to
    // the app router.
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
        onNavigate?.(path);
    }, [onNavigate, setOrgDeepSegs, setActiveTabState]);

    return { handleComplianceNavigate };
}
