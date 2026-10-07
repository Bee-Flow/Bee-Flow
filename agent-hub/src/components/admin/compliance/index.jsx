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
 * `admin/compliance/<canonical section>[/<encoded id>][?tab=<tab>]` through
 * `onNavigate(path, { replace? })`, whatever host it sits in. Old ids
 * (`iso_soa`, `iso_audit`, …) are accepted as `activeSection` and resolve to
 * their canonical row (sections.js), so a bookmark from before the redesign
 * still opens the right page; a `?tab=` that moved to another section
 * (`legacyTabs`) is redirected there once. Header tabs live in `?tab=`
 * (data/actions.js) — no history entries. `navigate(section, id, tab)` sets
 * the tab state itself (the demo host has no URL) AND carries it in the path
 * (the Settings host pushes a new URL, which the tab state re-reads).
 *
 * A page with unsaved edits calls `setLeaveGuard(fn)`; `navigate` (and so the
 * rail) first awaits `fn()` and stays put when it resolves false. The guard is
 * dropped whenever the section changes.
 *
 * Setup has ONE path: the Overview page renders the inline setup card from
 * `core.setupOpen` — no banner, no hero, no modal.
 *
 * Phone widths render <ComplianceMobile/> (a lazy chunk another stream
 * delivers); while it is absent the desktop layout renders, so the hub is
 * never blank.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { useViewport } from '../../../hooks/useViewport';
import StudioShell from '../../shared/StudioShell';
import { movedTab, resolveSection, sectionById, SECTIONS_WITH_PICKERS } from './sections';
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
    const { currentTab, setTab, navigate, setLeaveGuard } = useHubNavigation({ active, section, focusCheckId, onNavigate });

    const dl = useCallback((url) => downloadUrl(exportsEnabled, url), [exportsEnabled]);
    // Pages own their modals; the header's primary just needs a handle. A page
    // calls setHeaderActions({ onCaptureRequest }) once mounted (see pages.jsx).
    const [headerActions, setHeaderActions] = useState({});
    const [ladder, setLadder] = useState(null);

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
        exportsEnabled, dl, api: API, isMobile, data, setHeaderActions, setLeaveGuard,
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
        // Until the page hands its own handler up: More frameworks has no tabs any
        // more, so "Add framework" opens the own-frameworks page, as the page does.
        onAddFramework: headerActions.onAddFramework || (active === 'frameworks' ? () => navigate('custom') : null),
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
                    onOpenReports={() => navigate('overview', undefined, 'reports')}
                    counts={counts.counts}
                    frameworks={frameworks}
                    // null while the first read is out: the attention filter
                    // then falls back to the score instead of "no open checks".
                    checks={core.overview ? core.checks : null}
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
 * The hub's navigation state: the current header tab, `navigate` behind the
 * page's leave guard, and the one-time redirect of a legacy `?tab=`.
 */
function useHubNavigation({ active, section, focusCheckId, onNavigate }) {
    const [tab, setTab, setTabLocal] = useUrlQueryParam('tab', section.tabs[0] || null);
    const go = useNavigateTo({ active, focusCheckId, onNavigate, setTab, setTabLocal });

    const guardRef = useRef(null);
    const setLeaveGuard = useCallback((fn) => { guardRef.current = typeof fn === 'function' ? fn : null; }, []);
    // A guard belongs to the page that set it; a new section starts unguarded.
    useEffect(() => () => { guardRef.current = null; }, [active]);
    const navigate = useCallback((sectionId, subId, nextTab) => {
        const guard = guardRef.current;
        if (!guard) { go(sectionId, subId, nextTab); return; }
        Promise.resolve().then(guard).then(
            (ok) => { if (ok !== false) go(sectionId, subId, nextTab); },
            () => { /* a guard that throws keeps the page — never lose an edit silently */ },
        );
    }, [go]);

    // A `?tab=` that moved to another section (sections.js legacyTabs) — an
    // old bookmark, an e-mailed link, a stored attention target — redirects
    // there, once per arrival, replacing the old URL in the history.
    const moved = movedTab(active, tab);
    const redirected = useRef(null);
    useEffect(() => {
        if (!moved) return;
        const key = `${active}/${focusCheckId ?? ''}?${tab}`;
        if (redirected.current === key) return;
        redirected.current = key;
        go(moved.section, undefined, moved.tab, { replace: true });
    }, [moved, active, focusCheckId, tab, go]);
    const currentTab = !moved && section.tabs.includes(tab) ? tab : (section.tabs[0] || null);
    return { currentTab, setTab, navigate, setLeaveGuard };
}

/**
 * The one way the hub moves: `go(section, id, tab, { replace })`.
 *
 * Same page (section and id unchanged): `setTab` writes the tab onto the
 * current URL, so the host's compare finds nothing to push. Another page: the
 * tab is set in state only and travels in the emitted path, so the host's new
 * URL carries it and the old history entry keeps its own tab. A tab equal to
 * the section's first tab is left out of the path — that is the canonical URL.
 */
function useNavigateTo({ active, focusCheckId, onNavigate, setTab, setTabLocal }) {
    return useCallback((sectionId, subId, nextTab, opts) => {
        const target = resolveSection(sectionId);
        const tabs = sectionById(target).tabs;
        const tabArg = nextTab && nextTab !== tabs[0] ? nextTab : null;
        const samePage = target === active && String(subId ?? '') === String(focusCheckId ?? '');
        if (samePage) setTab(tabArg); else setTabLocal(tabArg || tabs[0] || null);
        const path = compliancePath(target, subId, tabArg);
        if (opts) onNavigate?.(path, opts); else onNavigate?.(path);
    }, [active, focusCheckId, onNavigate, setTab, setTabLocal]);
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
            // Wrapped in an updater: the module's default export IS a function,
            // and setState(fn) would call it as an updater — ComplianceMobile(prev)
            // with no props, which threw on every phone.
            .then((m) => { if (alive) setResolved(() => m?.default || null); })
            .catch(() => { if (alive) setResolved(null); });
        return () => { alive = false; };
    }, []);
    if (resolved === undefined) return null;
    if (resolved === null) return fallback;
    const Mobile = resolved;
    return <Mobile {...props} />;
}
