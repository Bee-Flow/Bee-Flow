/**
 * ComplianceHub — the Compliance Center shell (redesign, Sep 2026;
 * artboards Compliance.dc.html 1a–1h + 'Compliance Rail.dc.html').
 *
 * One rail, one header, one page. The rail (ComplianceRail) lists frameworks,
 * registers and admin as grouped rows with live counts; the header
 * (ComplianceHeader) is the shared StudioSectionHeader with a per-section
 * spec; the page comes from data/pages.jsx, which hands every page ONE props
 * object — `{ section, tab, onTab, navigate, focusId, exportsEnabled, dl,
 * isMobile, data }` — and adapts the legacy pages that have not been rewritten
 * yet onto their old prop names.
 *
 * Navigation contract (pinned by ComplianceHub.nav.test.jsx and consumed by
 * pages/settings/complianceNavAdapter.js): the hub EMITS
 * `admin/compliance/<canonical section>[/<encoded id>]` through `onNavigate`,
 * whatever host it sits in. Old ids (`iso_soa`, `iso_audit`, …) are accepted
 * as `activeSection` and resolve to their canonical row (sections.js), so a
 * bookmark from before the redesign still opens the right page. Header tabs
 * live in `?tab=` (data/actions.js) — no history entries, ignored by hosts
 * without a real URL (the demo).
 *
 * Setup has ONE path: the Overview page renders the inline setup card from
 * `core.setupOpen` — no banner, no hero, no modal.
 *
 * Phone widths render <ComplianceMobile/> (a lazy chunk another stream
 * delivers); while it is absent the desktop layout renders, so the hub is
 * never blank.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { useViewport } from '../../../hooks/useViewport';
import StudioShell from '../../shared/StudioShell';
import { resolveSection, sectionById, SECTIONS_WITH_PICKERS } from './sections';
import { API, downloadUrl } from './data/api';
import { compliancePath, useUrlQueryParam } from './data/actions';
import useComplianceCore from './data/useComplianceCore';
import useComplianceCounts from './data/useComplianceCounts';
import {
    useComplianceAttention, useComplianceDeadlines, useFrameworks, useCalendar,
} from './data/aggregates';
import {
    useDsr, useRopa, useDpia, useIncidents, useSoa, usePolicies, useConnectors, useRisks, useAudit, useTraining, useAccessAudit, useOrgUsers,
} from './data/registers';
import { pageFor } from './data/pages';
import ComplianceRail from './ComplianceRail';
import ComplianceHeader from './ComplianceHeader';
import AiActLadderModal from './ladder/AiActLadderModal';
import { ladderTarget } from './ladder/ladderTarget';
import './compliance.css';

export default function ComplianceHub({ activeSection = 'overview', focusCheckId = null, onNavigate, exportsEnabled = true, onBack = null }) {
    const { t } = useTranslation();
    const { isMobile } = useViewport();
    const active = resolveSection(activeSection);
    const section = sectionById(active);
    const [tab, setTab] = useUrlQueryParam('tab', section.tabs[0] || null);
    const currentTab = section.tabs.includes(tab) ? tab : (section.tabs[0] || null);

    const dl = useCallback((url) => downloadUrl(exportsEnabled, url), [exportsEnabled]);
    // Pages own their modals; the header's primary just needs a handle. A page
    // calls setHeaderActions({ onCaptureRequest }) once mounted (see pages.jsx).
    const [headerActions, setHeaderActions] = useState({});
    const [ladder, setLadder] = useState(null);
    const navigate = useCallback((sectionId, subId) => { onNavigate?.(compliancePath(sectionId, subId)); }, [onNavigate]);

    // ── Data ──
    const counts = useComplianceCounts({ enabled: true });
    const bump = counts.bump;
    const core = useComplianceCore({ onChanged: bump });
    const refreshCore = core.refresh;
    const showSetup = core.setupOpen;

    const attention = useComplianceAttention({ enabled: active === 'overview' });
    const frameworks = useFrameworks({ enabled: true, onChanged: () => { bump(); refreshCore(); } });
    const calendar = useCalendar({ enabled: active === 'overview' || active === 'frameworks' || !!section.regulation });

    const dsr = useDsr({ enabled: active === 'dsr' || active === 'overview', onChanged: bump, refreshCore });
    const incidents = useIncidents({ enabled: active === 'incidents' || active === 'overview', onChanged: bump, refreshCore });
    const vulnerabilities = useIncidents({ enabled: active === 'vulnerabilities', onChanged: bump, refreshCore, kind: 'vulnerability' });
    const deadlines = useComplianceDeadlines({ enabled: active === 'overview', requests: dsr.requests, incidents: incidents.incidents });
    const ropa = useRopa({ enabled: active === 'ropa', onChanged: bump, refreshCore });
    const dpia = useDpia({ enabled: active === 'dpia', onChanged: bump, refreshCore });
    const soa = useSoa({ enabled: active === 'soa', onChanged: bump });
    const policies = usePolicies({ enabled: active === 'policies', onChanged: bump });
    const connectors = useConnectors({ enabled: active === 'connectors', onChanged: bump });
    const risks = useRisks({ enabled: active === 'risks', onChanged: bump });
    const audit = useAudit({ enabled: active === 'audits', onChanged: bump });
    const training = useTraining({ enabled: active === 'training', onChanged: bump });
    const accessAudit = useAccessAudit({ enabled: active === 'access_log' });
    const { orgUsers } = useOrgUsers({ enabled: showSetup || SECTIONS_WITH_PICKERS.includes(active) });

    const data = useMemo(() => ({
        core, counts: counts.counts, countsFailed: counts.failed, bump,
        attention, deadlines, frameworks, calendar, orgUsers,
        dsr, ropa, dpia, incidents, vulnerabilities, soa, policies, connectors, risks, audit, training, accessAudit,
    }), [core, counts.counts, counts.failed, bump, attention, deadlines, frameworks, calendar, orgUsers,
        dsr, ropa, dpia, incidents, vulnerabilities, soa, policies, connectors, risks, audit, training, accessAudit]);

    const pageProps = {
        section, tab: currentTab, onTab: setTab, navigate, onNavigate, focusId: focusCheckId,
        exportsEnabled, dl, api: API, isMobile, data, setHeaderActions,
        // The AI Act ladder is a modal the Frameworks page opens per automation
        // or agent; the hub owns the handle so one implementation serves the
        // page, the automation builder and the agent drawer.
        onOpenLadder: (kind, target, title) => setLadder({ kind, target: ladderTarget(target, title) }),
    };
    const Page = pageFor(active);
    const page = <Page {...pageProps} />;

    const headerCtx = {
        counts: counts.counts, core, frameworks, calendar, dl, api: API,
        dsr, soa, incidents, vulnerabilities, risks, audit, policies, dpia,
        ...headerActions,
        onAddFramework: headerActions.onAddFramework || (active === 'frameworks' ? () => setTab('all') : null),
    };

    const orgName = core.overview?.settings?.org_name || core.overview?.organization_name || null;



    if (isMobile) {
        return (
            <div className="h-full flex flex-col" data-testid="compliance-hub" data-layout="mobile">
                <ComplianceMobileGate
                    fallback={<DesktopLayout {...{ active, section, currentTab, setTab, navigate, onBack, counts, frameworks, core, orgName, exportsEnabled, page, headerCtx, t }} />}
                    props={{ active, navigate, onBack, data, tab: currentTab, onTab: setTab, exportsEnabled, dl, page, section, headerCtx }} />
                {/* The ladder (artboard 1f) is opened from Frameworks › Per automation,
                    which a phone reaches too — without this the button was a dead control. */}
                {ladder && (
                    <AiActLadderModal open kind={ladder.kind} target={ladder.target} onClose={() => setLadder(null)} />
                )}
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col" data-testid="compliance-hub" data-layout="desktop">
            <DesktopLayout {...{ active, section, currentTab, setTab, navigate, onBack, counts, frameworks, core, orgName, exportsEnabled, page, headerCtx, t }} />
            {ladder && (
                <AiActLadderModal open kind={ladder.kind} target={ladder.target} onClose={() => setLadder(null)} />
            )}
        </div>
    );
}

function DesktopLayout({ active, section, currentTab, setTab, navigate, onBack, counts, frameworks, core, orgName, exportsEnabled, page, headerCtx, t }) {
    return (
        <StudioShell
            sidebarWidthClass="w-[300px]"
            className="flex-1 min-h-0"
            sidebar={(
                <ComplianceRail
                    active={active}
                    onSelect={(id, sub) => navigate(id, sub)}
                    onOpenReports={() => { navigate('overview'); setTab('reports'); }}
                    counts={counts.counts}
                    frameworks={frameworks}
                    checks={core.checks}
                    orgName={orgName}
                    exportsEnabled={exportsEnabled}
                />
            )}
        >
            <div className="h-full flex flex-col min-h-0">
                <ComplianceHeader section={section} tab={currentTab} onTab={setTab} ctx={headerCtx}
                    onBack={onBack || undefined} backLabel={onBack ? t('compliance.back_to_settings', 'Back to settings') : undefined} />
                <div className="@container/cpage flex-1 min-h-0 overflow-y-auto">{page}</div>
            </div>
        </StudioShell>
    );
}

/**
 * The phone frame is its own chunk (FE-9). A build without it must still
 * render the desktop layout, so the import failure is caught, not fatal:
 * undefined = loading, null = no chunk → fallback, else the component.
 */
function ComplianceMobileGate({ props, fallback }) {
    const [resolved, setResolved] = useState(undefined);
    React.useEffect(() => {
        let alive = true;
        import('./ComplianceMobile')
            .then((m) => { if (alive) setResolved(m?.default || null); })
            .catch(() => { if (alive) setResolved(null); });
        return () => { alive = false; };
    }, []);
    if (resolved === undefined) return null;
    if (resolved === null) return fallback;
    const Mobile = resolved;
    return <Mobile {...props} />;
}
