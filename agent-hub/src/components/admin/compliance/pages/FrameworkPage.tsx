import { useCallback, useMemo } from 'react';
import { frameworkOf, tabsOf, type Section } from '../sections';
import { PAGE_FRAME } from './audits/auditForms';
import { checksForRegulation, canFollow, type CheckRecord } from './framework/checkSort';
import ChecksTable from './framework/ChecksTable';
import EvidenceTab from './framework/EvidenceTab';
import TimelineTab, { type CalendarData, type CalendarMilestone, type CatalogueFramework, type FrameworksData } from './framework/TimelineTab';
import PerAutomationTab from './frameworks/PerAutomationTab';
import type { Remediation, RowCheck } from './framework/CheckRow';
import type { DecideFinding } from './framework/FindingDecision';

/**
 * FrameworkPage — artboard 1b, the page behind EVERY framework section
 * (gdpr, aia, iso, nis2, cra, data_act, pld, eaa, dora, machinery, custom).
 *
 * The hub (index.jsx, fe-1) renders it with the shared page props object:
 *   { section, tab, onTab, navigate(sectionId, subId?), onNavigate?(path), focusId,
 *     exportsEnabled, dl(url), data: { core, calendar, frameworks, … }, isMobile }
 * and `data.core` = useComplianceCore — { overview, checks, loading, rerunningId,
 * autoFixingId, rerun(checkId), autoFix(checkId), loadTrail(checkId, scopeId) }.
 *
 * The regulation is `sections.frameworkOf(section.id)`; the rows are the
 * checks whose home is that regulation OR that the registry tagged for it
 * (`check.frameworks[]`). The header (tabs, score pill, Run again) is the
 * hub's ComplianceHeader; this page renders the tab bodies only:
 *   checks   → toolbar + ChecksTable (+ expansion rows)
 *   timeline → TimelinePhases + the framework's calendar rows
 *   evidence → paged evidence ledger (GET /evidence?regulation=)
 *   systems  → the AI Act only: the ladder outcome per agent / automation
 *              (PerAutomationTab; its row action is `onOpenLadder(kind, id, title)`)
 * A section's own tab list (sections.js `tabs`) says which of these it has.
 */

/** `data.core`: the useComplianceCore hook's values the framework page reads. */
interface ComplianceCore {
    overview?: { last_run_at?: string | number | Date | null } | null;
    checks?: CheckRecord[] | null;
    loading?: boolean;
    rerunningId?: string | null;
    autoFixingId?: string | null;
    rerun?: ((checkId: string) => void) | undefined;
    autoFix?: ((checkId: string) => void) | undefined;
    decideFinding?: DecideFinding;
    loadTrail?: Parameters<typeof ChecksTable>[0]['loadTrail'];
    refresh?: () => Promise<unknown>;
}

interface FrameworkPageArgs {
    section: Section;
    tab?: string | null;
    onTab?: ((tab: string) => void) | undefined;
    navigate?: (sectionId: string, subId?: string) => void;
    onNavigate?: ((path: string) => void) | undefined;
    focusId?: string | null;
    exportsEnabled?: boolean | undefined;
    dl?: (url: string) => string | null;
    data?: {
        core?: ComplianceCore;
        calendar?: CalendarData | CalendarMilestone[] | null;
        frameworks?: FrameworksData | CatalogueFramework[] | null;
    };
    isMobile?: boolean | undefined;
    onOpenLadder?: (kind: string, id: string, title?: string | null) => void;
}

export default function FrameworkPage({
    section,
    tab = 'checks',
    onTab = undefined, // the header owns the tab strip; accepted for parity with the page props object
    navigate,
    onNavigate = undefined,
    focusId = null,
    exportsEnabled = true,
    dl = (url) => url,
    data = {},
    isMobile = false,
    onOpenLadder = undefined,
}: FrameworkPageArgs) {
    const sectionId = typeof section === 'string' ? section : section?.id;
    const regulation = frameworkOf(sectionId);
    const core: ComplianceCore = data?.core || {};
    const ownTabs = tabsOf(sectionId);
    const activeTab = ownTabs.includes(tab as string) ? tab as string : 'checks';

    const allChecks = core.checks;
    const checks = useMemo(() => checksForRegulation(allChecks, regulation) as RowCheck[], [allChecks, regulation]);
    const loading = !!core.loading;
    // asArray → null once the read failed; before the first read the hook
    // holds its initial value (undefined/[]) with `loading` true.
    const failed = allChecks === null && !loading;

    const openLink = useCallback((rem: Remediation | null) => {
        if (!rem) return;
        if (rem.kind === 'external') { onNavigate?.(rem.path); return; }
        navigate?.(rem.sectionId as string, rem.subId);
    }, [navigate, onNavigate]);
    const canOpenLink = useCallback((rem: { kind: string }) => canFollow(rem, { navigate, onNavigate }), [navigate, onNavigate]);

    void onTab;

    if (!regulation) return null;

    return (
        <div className={`h-full min-h-0 overflow-y-auto ${PAGE_FRAME}`} data-testid="framework-page" data-regulation={regulation} data-tab={activeTab}>
            {activeTab === 'checks' && (
                <ChecksTable
                    checks={checks}
                    regulation={regulation}
                    loading={loading}
                    failed={failed}
                    focusId={focusId}
                    rerunningId={core.rerunningId ?? null}
                    autoFixingId={core.autoFixingId ?? null}
                    onRerun={typeof core.rerun === 'function' ? core.rerun : undefined}
                    onAutoFix={typeof core.autoFix === 'function' ? core.autoFix : undefined}
                    onDecide={typeof core.decideFinding === 'function' ? core.decideFinding : undefined}
                    loadTrail={typeof core.loadTrail === 'function' ? core.loadTrail : undefined}
                    onOpenLink={openLink}
                    canOpenLink={canOpenLink}
                    exportsEnabled={exportsEnabled}
                    dl={dl}
                    lastRunAt={core.overview?.last_run_at ?? null}
                    isMobile={isMobile}
                />
            )}
            {activeTab === 'timeline' && (
                <TimelineTab regulation={regulation} calendar={data?.calendar} frameworks={data?.frameworks} checks={checks} />
            )}
            {activeTab === 'evidence' && (
                <EvidenceTab regulation={regulation} checks={checks} exportsEnabled={exportsEnabled} dl={dl} isMobile={isMobile} />
            )}
            {activeTab === 'systems' && (
                <PerAutomationTab onOpenLadder={onOpenLadder} isMobile={isMobile} />
            )}
        </div>
    );
}
