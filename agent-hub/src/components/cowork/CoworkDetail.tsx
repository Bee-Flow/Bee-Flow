/**
 * The right-hand pane: one cowork item in full — what it does, when it runs
 * next, and how every run went.
 *
 * This used to be reachable only through Studio → Cowork while the thing that
 * created it lived under a different name in the sidebar. It is now the detail
 * half of the Cowork page itself.
 *
 * Calm by construction: one obvious place for each thing, and nothing on
 * screen until it has something to say. Top to bottom:
 *
 *   1. The header (./CoworkDetailHeader.tsx): title, status, a "Needs you"
 *      badge while something waits, Run now, Pause/Resume, and a small menu.
 *   2. "Needs you" (./CoworkNeedsStrip.tsx), only while something waits: the
 *      one slot for whatever asks its owner to act.
 *   3. The brief (./CoworkBrief.tsx), in the user's own words.
 *   4. Three tabs (./CoworkTabs.tsx): Runs (the figures and every run), Plan,
 *      and Settings (./CoworkSettings.tsx). Only the chosen tab renders, so
 *      its panels read their data when it is shown.
 *
 * A new feature finds its place in one of these; it does not get a box of its
 * own at the bottom of the column.
 */
import { useRef } from 'react';
import AssignmentCard from './CoworkBrief';
import DetailHeader from './CoworkDetailHeader';
import CoworkEditForm from './CoworkEditForm';
import CoworkNeedsStrip, { needsCount } from './CoworkNeedsStrip';
import type { NeedsEntry } from './CoworkNeedsStrip';
import CoworkPlanPanel from './CoworkPlanPanel';
import CoworkReviewQueue from './CoworkReviewQueue';
import CoworkRunHistory from './CoworkRunHistory';
import CoworkSettings from './CoworkSettings';
import CoworkStats from './CoworkStats';
import CoworkTabs from './CoworkTabs';
import { coworkStatus } from './coworkStatus';
import { waitingRuns } from './coworkReview';
import { useCoworkRunsQuery } from '@/api/queries/coworkReads';
import { useTranslation } from '@/hooks/useTranslation';
import type { CoworkAgent, CoworkItem, CoworkUpdate } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

interface CoworkDetailProps {
    item: CoworkItem;
    agents?: CoworkAgent[];
    onRunNow: (id: string) => void;
    onToggle: (id: string) => void;
    onDelete: (item: CoworkItem) => void;
    onSave: (update: CoworkUpdate) => void;
    busy?: boolean;
    reloadKey?: number;
    editing?: boolean;
    onEdit: () => void;
    onCancelEdit: () => void;
    saveError?: string | null;
}

type ViewProps = Omit<CoworkDetailProps, 'onSave' | 'editing' | 'onCancelEdit' | 'saveError'> & { t: TranslateFn };

/**
 * What waits for the owner, as entries of the "Needs you" strip. The runs come from the same query as the review
 * queue and the history (one request); a plan to approve or a repair that is ready becomes one more entry here.
 */
function useNeedsEntries(item: CoworkItem, reloadKey: number | undefined): NeedsEntry[] {
    const runs = useCoworkRunsQuery(item.id, reloadKey).data?.runs;
    const reviews = waitingRuns(runs).length;
    return reviews > 0
        ? [{ key: 'review', count: reviews, content: <CoworkReviewQueue coworkId={item.id} reloadKey={reloadKey} runs={runs} /> }]
        : [];
}

/** The pane while it is not being edited. Split from the editor so its reads stop while the form is open. */
function DetailView({ item, agents, onRunNow, onToggle, onDelete, busy, reloadKey, onEdit, t }: ViewProps) {
    const status = coworkStatus(item);
    const needs = useNeedsEntries(item, reloadKey);
    const strip = useRef<HTMLElement>(null);
    const showNeeds = () => {
        const el = strip.current;
        if (!el) return;
        el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        el.focus({ preventScroll: true });
    };

    return (
        <div className="h-full flex flex-col min-h-0" data-testid="cowork-detail">
            <DetailHeader
                item={item}
                status={status}
                t={t}
                busy={busy}
                needsCount={needsCount(needs)}
                onShowNeeds={showNeeds}
                onEdit={onEdit}
                onToggle={onToggle}
                onDelete={onDelete}
                onRunNow={onRunNow}
            />
            <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden custom-scrollbar px-4 sm:px-[26px] py-[22px] flex flex-col gap-[18px]">
                <CoworkNeedsStrip entries={needs} ref={strip} />
                <AssignmentCard item={item} agents={agents} t={t} />
                <CoworkTabs
                    scope={item.id}
                    label={t('cowork_detail.tabs.label', 'This work')}
                    tabs={[
                        {
                            id: 'runs',
                            label: t('cowork_detail.tabs.runs', 'Runs'),
                            render: () => (
                                <>
                                    <CoworkStats coworkId={item.id} reloadKey={reloadKey} />
                                    <CoworkRunHistory coworkId={item.id} reloadKey={reloadKey} agentId={item.agentId} title={item.title} />
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
            </div>
        </div>
    );
}

export default function CoworkDetail({
    item, agents, onRunNow, onToggle, onDelete, onSave, busy, reloadKey,
    editing, onEdit, onCancelEdit, saveError,
}: CoworkDetailProps) {
    const { t } = useTranslation();

    if (editing) {
        return (
            <div className="h-full overflow-y-auto custom-scrollbar p-5" data-testid="cowork-detail">
                <h2 className="text-[17px] font-semibold mb-4 text-[var(--text-primary)]">
                    {t('cowork.detail.edit_heading', 'Edit cowork')}
                </h2>
                <CoworkEditForm
                    item={item}
                    agents={agents}
                    onSave={onSave}
                    onCancel={onCancelEdit}
                    saving={busy}
                    error={saveError}
                />
            </div>
        );
    }

    return (
        <DetailView
            item={item}
            agents={agents}
            onRunNow={onRunNow}
            onToggle={onToggle}
            onDelete={onDelete}
            busy={busy}
            reloadKey={reloadKey}
            onEdit={onEdit}
            t={t}
        />
    );
}
