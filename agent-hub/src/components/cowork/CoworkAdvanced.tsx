/**
 * "Advanced", under an item's Overview (./CoworkDetail.tsx): one quiet button that opens everything the Overview
 * leaves out, unchanged. The brief with its context pills (./CoworkBrief.tsx), then the three tabs (./CoworkTabs.tsx):
 * Runs (the figures and every run, with its steps and receipts), Plan, and Settings (./CoworkSettings.tsx). Only the
 * chosen tab renders, so its panels read their data when it is shown, and nothing here reads anything while closed.
 *
 * Open or closed is remembered per viewer; a link into a tab or a run opens it there (./coworkView.ts).
 */
import { useEffect, useId, useRef } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import AssignmentCard from './CoworkBrief';
import CoworkPlanPanel from './CoworkPlanPanel';
import CoworkRunHistory from './CoworkRunHistory';
import CoworkSettings from './CoworkSettings';
import CoworkStats from './CoworkStats';
import CoworkTabs from './CoworkTabs';
import type { CoworkFocus } from './coworkView';
import type { CoworkAgent, CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

interface CoworkAdvancedProps {
    item: CoworkItem;
    agents?: CoworkAgent[];
    busy?: boolean;
    reloadKey?: number;
    onEdit: () => void;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The link it was last opened by: its tab is chosen, its run opened. */
    request: CoworkFocus | null;
    t: TranslateFn;
}

function Tabs({ item, busy, reloadKey, onEdit, request, t }: Omit<CoworkAdvancedProps, 'open' | 'onOpenChange' | 'agents'>) {
    const openRunId = request?.tab === 'runs' ? request.runId ?? null : null;
    return (
        <CoworkTabs
            // A link chooses its tab: the tabs start again from the choice it stored.
            key={request?.seq ?? 0}
            scope={item.id}
            label={t('cowork_detail.tabs.label', 'This work')}
            tabs={[
                {
                    id: 'runs',
                    label: t('cowork_detail.tabs.runs', 'Runs'),
                    render: () => (
                        <>
                            <CoworkStats coworkId={item.id} reloadKey={reloadKey} />
                            <CoworkRunHistory coworkId={item.id} reloadKey={reloadKey} agentId={item.agentId} title={item.title} openRunId={openRunId} />
                        </>
                    ),
                },
                {
                    id: 'plan',
                    label: t('cowork_detail.tabs.plan', 'Plan'),
                    render: () => (
                        <CoworkPlanPanel
                            coworkId={item.id}
                            fallback={(
                                <p className="text-[12.5px] text-[var(--text-secondary)]" data-testid="cowork-plan-unavailable">
                                    {t('cowork_detail.plan.none', 'This work runs without a plan: the AI does it each time.')}
                                </p>
                            )}
                        />
                    ),
                },
                {
                    id: 'settings',
                    label: t('cowork_detail.tabs.settings', 'Settings'),
                    render: () => <CoworkSettings item={item} busy={busy} onEdit={onEdit} />,
                },
            ]}
        />
    );
}

export default function CoworkAdvanced({ item, agents, busy, reloadKey, onEdit, open, onOpenChange, request, t }: CoworkAdvancedProps) {
    const regionId = useId();
    const section = useRef<HTMLElement>(null);
    // A link brings the reader here.
    useEffect(() => {
        if (request) section.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }, [request]);
    return (
        <section ref={section} className="flex flex-col gap-[18px] scroll-mt-4" data-testid="cowork-advanced" aria-label={t('cowork_overview.advanced', 'Advanced')}>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={regionId}
                data-testid="cowork-advanced-toggle"
                onClick={() => onOpenChange(!open)}
                className="self-start inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
                <SlidersHorizontal aria-hidden="true" className="w-3.5 h-3.5" />
                {open ? t('cowork_overview.advanced_hide', 'Hide advanced') : t('cowork_overview.advanced', 'Advanced')}
                <ChevronDown aria-hidden="true" className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div id={regionId} className="flex flex-col gap-[18px] min-w-0" data-testid="cowork-advanced-body">
                    <AssignmentCard item={item} agents={agents} t={t} withGoal={false} />
                    <Tabs item={item} busy={busy} reloadKey={reloadKey} onEdit={onEdit} request={request} t={t} />
                </div>
            )}
        </section>
    );
}
