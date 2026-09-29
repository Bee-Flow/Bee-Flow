/**
 * pages — which component renders each section, and how the hub's ONE props
 * object reaches it (redesign, Sep 2026).
 *
 * Every page receives the same shape:
 *
 *   { section, tab, onTab(tabId), navigate(sectionId, subId?), focusId,
 *     exportsEnabled, dl(url), isMobile,
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
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';

import OverviewPage from '../pages/OverviewPage';
import FrameworksPage from '../pages/FrameworksPage';
import CustomFrameworksPage from '../pages/CustomFrameworksPage';
import PortabilityPage from '../pages/PortabilityPage';
import MachineryPage from '../pages/MachineryPage';
import FrameworkPage from '../pages/FrameworkPage';
import DsrPage from '../pages/DsrPage';
import IncidentsPage from '../pages/IncidentsPage';
import RopaPage from '../pages/RopaPage';
import DpiaPage from '../pages/DpiaPage';
import SettingsPage from '../pages/SettingsPage';
import SoaPage from '../pages/SoaPage';
import PoliciesPage from '../pages/PoliciesPage';
import RisksPage from '../pages/RisksPage';
import AuditsPage from '../pages/AuditsPage';
import AccessAuditPage from '../pages/AccessAuditPage';
import TrainingPage from '../pages/TrainingPage';
import ConnectorsPage from '../pages/ConnectorsPage';

export function PendingPage({ section }) {
    const { t } = useTranslation();
    return (
        <div className="p-6 text-[13px]" style={{ color: 'var(--text-tertiary)' }} data-testid={`pending-page-${section?.id || ''}`}>
            {t('compliance.page_pending', 'This section arrives with the next release')}
        </div>
    );
}

/**
 * sectionId → component. A framework section without its own entry renders
 * the checks page for its regulation (the same page serves gdpr, aia, iso and
 * every growing-set framework).
 */
export const PAGES = Object.freeze({
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

export function pageFor(sectionId) {
    return PAGES[sectionId] || PendingPage;
}
