import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ChooseOrgNotice from '@/components/admin/dashboard/ChooseOrgNotice';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import UsageReports from '@/pages/settings/usage/UsageReports';
import { useTranslation } from '@/hooks/useTranslation';

interface UsageReportPageProps {
    /** Which report: 'adoption' or 'spend'. */
    report: 'adoption' | 'spend';
    range: string;
    customStart: string;
    customEnd: string;
    /** Changes when the page's Refresh button is pressed. */
    refreshKey: number;
    onNavigate?: (path: string) => void;
}

/** Where the dashboard says the reports read: the chosen organisation, or all of them (a platform admin without a choice). */
function useReportOrg() {
    const choice = useAdminOrgChoice();
    return {
        orgId: choice?.orgId ?? null,
        all: !!choice?.isPlatformAdmin && !choice.orgId,
        noOrgs: !!choice?.organizationsLoaded && choice.organizations.length === 0,
        pending: !!choice?.pending,
    };
}

/** Refresh re-reads the open report; a read of revealed names is left alone (each one is an audited click). */
function useRefreshOnKey(refreshKey: number) {
    const client = useQueryClient();
    const seen = useRef(refreshKey);
    useEffect(() => {
        if (seen.current === refreshKey) return;
        seen.current = refreshKey;
        void client.invalidateQueries({
            queryKey: ['settings', 'usage'],
            predicate: (q) => !q.queryKey.includes('revealed'),
        });
    }, [client, refreshKey]);
}

/**
 * Adoption and Spend inside the AI Monitor: the Settings usage reports
 * (pages/settings/usage), reading the organisation the dashboard has chosen.
 * Adoption belongs to one organisation, so "All organisations" asks for a
 * choice there; Spend then covers every organisation and leaves out the
 * subscription and the adoption-based change.
 */
export function UsageReportPage({ report, range, customStart, customEnd, refreshKey, onNavigate }: UsageReportPageProps) {
    const { t } = useTranslation();
    const org = useReportOrg();
    const period = useMemo(() => ({ preset: range, customStart, customEnd }), [range, customStart, customEnd]);
    useRefreshOnKey(refreshKey);
    if (org.pending) return null;
    if (report === 'adoption' && org.all) {
        return <ChooseOrgNotice noOrgs={org.noOrgs} text={t('admin_monitoring.choose_org_adoption', 'Choose an organisation above: the adoption report covers one organisation.')} />;
    }
    return (
        <UsageReports
            report={report} range={period} orgId={org.orgId} allOrganisations={org.all}
            onOpenTab={(tab) => onNavigate?.(`admin/monitoring/${tab}`)}
        />
    );
}
