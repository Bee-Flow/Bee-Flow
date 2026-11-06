import type { OrgUser } from './accessAuditLabels';
import type { DsrRequestRow } from '../data/aggregates';
import EntriesTab from './kbQueryLog/EntriesTab';
import OverviewTab from './kbQueryLog/OverviewTab';
import RequestsTab from './kbQueryLog/RequestsTab';

/**
 * KbQueryLogPage: the knowledge-base query log, for the people who answer for
 * it (GDPR Art. 5, 15, 17). Three tabs from the header:
 *   overview  per base: on or off, term, who decided, counts (no text)
 *   entries   the metadata of every logged search, with a metadata export
 *   requests  one person: counts, and text only against an open request
 */
interface KbQueryLogPageArgs {
    tab?: string | null;
    isMobile?: boolean;
    exportsEnabled?: boolean;
    navigate?: (section: string, id?: string | null) => void;
    data?: { orgUsers?: OrgUser[] | null; dsr?: { requests?: DsrRequestRow[] | null } | null };
}

export default function KbQueryLogPage({ tab = 'overview', isMobile = false, exportsEnabled = true, navigate, data = {} }: KbQueryLogPageArgs) {
    if (tab === 'entries') return <EntriesTab orgUsers={data.orgUsers ?? null} isMobile={isMobile} exportsEnabled={exportsEnabled} />;
    if (tab === 'requests') return <RequestsTab orgUsers={data.orgUsers ?? null} dsrRequests={data.dsr?.requests ?? null} exportsEnabled={exportsEnabled} />;
    return <OverviewTab isMobile={isMobile} {...(navigate ? { navigate } : {})} />;
}
