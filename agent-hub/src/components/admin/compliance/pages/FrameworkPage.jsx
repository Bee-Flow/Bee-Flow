import React, { useCallback, useMemo } from 'react';
import { frameworkOf } from '../sections';
import ChecksTable from './framework/ChecksTable';
import TimelineTab from './framework/TimelineTab';
import EvidenceTab from './framework/EvidenceTab';
import { checksForRegulation, canFollow } from './framework/checkSort';

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
 */

export const FRAMEWORK_TABS = Object.freeze(['checks', 'timeline', 'evidence']);

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
}) {
    const sectionId = typeof section === 'string' ? section : section?.id;
    const regulation = frameworkOf(sectionId);
    const core = data?.core || {};
    const activeTab = FRAMEWORK_TABS.includes(tab) ? tab : 'checks';

    const allChecks = core.checks;
    const checks = useMemo(() => checksForRegulation(allChecks, regulation), [allChecks, regulation]);
    const loading = !!core.loading;
    // asArray → null once the read failed; before the first read the hook
    // holds its initial value (undefined/[]) with `loading` true.
    const failed = allChecks === null && !loading;

    const openLink = useCallback((rem) => {
        if (!rem) return;
        if (rem.kind === 'external') { onNavigate?.(rem.path); return; }
        navigate?.(rem.sectionId, rem.subId);
    }, [navigate, onNavigate]);
    const canOpenLink = useCallback((rem) => canFollow(rem, { navigate, onNavigate }), [navigate, onNavigate]);

    void onTab;

    if (!regulation) return null;

    return (
        <div className="h-full min-h-0 overflow-y-auto p-4 flex flex-col gap-4" data-testid="framework-page" data-regulation={regulation} data-tab={activeTab}>
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
                <TimelineTab regulation={regulation} calendar={data?.calendar} frameworks={data?.frameworks} />
            )}
            {activeTab === 'evidence' && (
                <EvidenceTab regulation={regulation} checks={checks} exportsEnabled={exportsEnabled} dl={dl} isMobile={isMobile} />
            )}
        </div>
    );
}
