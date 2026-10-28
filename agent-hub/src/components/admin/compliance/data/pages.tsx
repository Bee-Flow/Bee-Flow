/**
 * pages — which component renders each section, and how the hub's ONE props
 * object reaches it (redesign, Sep 2026).
 *
 * Every page receives the same shape:
 *
 *   { section, tab, onTab(tabId), navigate(sectionId, subId?, tab?), focusId,
 *     exportsEnabled, dl(url), isMobile, setLeaveGuard(fn | null),
 *     data: { core, counts, attention, deadlines, frameworks, calendar, orgUsers,
 *             dsr, ropa, dpia, incidents, vulnerabilities, soa, policies,
 *             connectors, risks, audit, training, accessAudit } }
 *
 * Every page takes that object as-is. The legacy adapters that mapped it onto
 * the pre-redesign prop names are gone with their pages (fe-6 was the last
 * wave): a section is now one entry pointing at `../pages/<Name>`.
 *
 * Sections a page stream has not delivered yet render `PendingPage` (one
 * sentence, no fake zeros) — a placeholder is a placeholder, never a claim.
 */
import { useTranslation } from '@/hooks/useTranslation';

import AccessAuditPage from '../pages/AccessAuditPage';
import AuditsPage from '../pages/AuditsPage';
import ConnectorsPage from '../pages/ConnectorsPage';
import CustomFrameworksPage from '../pages/CustomFrameworksPage';
import DpiaPage from '../pages/DpiaPage';
import DsrPage from '../pages/DsrPage';
import FrameworkPage from '../pages/FrameworkPage';
import FrameworksPage from '../pages/FrameworksPage';
import IncidentsPage from '../pages/IncidentsPage';
import MachineryPage from '../pages/MachineryPage';
import OverviewPage from '../pages/OverviewPage';
import PoliciesPage from '../pages/PoliciesPage';
import PortabilityPage from '../pages/PortabilityPage';
import RisksPage from '../pages/RisksPage';
import RopaPage from '../pages/RopaPage';
import SettingsPage from '../pages/SettingsPage';
import SoaPage from '../pages/SoaPage';
import TrainingPage from '../pages/TrainingPage';

function PendingPage({ section }: { section?: { id?: string } | null }) {
    const { t } = useTranslation();
    return (
        <div className="p-6 text-[13px] text-[var(--text-tertiary)]" data-testid={`pending-page-${section?.id || ''}`}>
            {t('compliance.page_pending', 'This section arrives with the next release')}
        </div>
    );
}

/**
 * sectionId → component. A framework section without its own entry renders
 * the checks page for its regulation (the same page serves gdpr, aia, iso and
 * every growing-set framework).
 */
const PAGES = Object.freeze({
    overview: OverviewPage,
    // Every framework section renders the one checks table (fe-3); the
    // regulation comes from sections.frameworkOf(section.id).
    gdpr: FrameworkPage,
    aia: FrameworkPage,
    iso: FrameworkPage,
    nis2: FrameworkPage, cra: FrameworkPage, data_act: FrameworkPage, pld: FrameworkPage, eaa: FrameworkPage,
    dora: FrameworkPage,
    // Two framework sections are not a checks table: Machinery is a detector +
    // per-subject assessment, and a custom framework is a register the org writes.
    machinery: MachineryPage,
    custom: CustomFrameworksPage,
    frameworks: FrameworksPage,
    dsr: DsrPage,
    incidents: IncidentsPage,
    // The page prefers `data.vulnerabilities` for this section itself (fe-5).
    vulnerabilities: IncidentsPage,
    ropa: RopaPage,
    dpia: DpiaPage,
    risks: RisksPage,
    soa: SoaPage,
    policies: PoliciesPage,
    // One page, four registers behind the header's tabs (audits|reviews|ncs|objectives).
    audits: AuditsPage,
    training: TrainingPage,
    access_log: AccessAuditPage,
    portability: PortabilityPage,
    settings: SettingsPage,
    connectors: ConnectorsPage,
});

export function pageFor(sectionId: string) {
    return PAGES[sectionId as keyof typeof PAGES] || PendingPage;
}
