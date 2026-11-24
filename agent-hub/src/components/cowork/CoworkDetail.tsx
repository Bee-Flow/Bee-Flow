/**
 * The right-hand pane: one cowork item, as a regular user needs it, with the detail one click away.
 *
 * Calm by construction: one obvious place for each thing, and nothing on screen until it has something to say. Top to
 * bottom:
 *
 *   1. The header (./CoworkDetailHeader.tsx): title, status, a "Needs you" badge while something waits, Run now,
 *      Pause/Resume, and a small menu (Edit, Advanced, Delete).
 *   2. "Needs you" (./CoworkNeedsStrip.tsx), only while something waits: the one slot for whatever asks its owner to
 *      act.
 *   3. The Overview (./CoworkOverview.tsx): what it does and when in one sentence, the goal, the last runs in plain
 *      lines, and the offers that apply.
 *   4. Advanced (./CoworkAdvanced.tsx), one quiet button: the brief and the three tabs, Runs, Plan and Settings,
 *      unchanged. Closed by default and remembered per viewer; a link into a tab or a run opens it there
 *      (./coworkView.ts).
 *
 * A new feature finds its place in one of these; it does not get a box of its own at the bottom of the column.
 */
import { useRef, useState } from 'react';
import CoworkAdvanced from './CoworkAdvanced';
import CoworkAutoFixNote from './CoworkAutoFixNote';
import { CoworkDeskInvitation, PlannedStartLine } from './CoworkDeskPanel';
import DetailHeader from './CoworkDetailHeader';
import CoworkEditForm from './CoworkEditForm';
import CoworkNeedsStrip, { needsCount } from './CoworkNeedsStrip';
import type { NeedsEntry } from './CoworkNeedsStrip';
import CoworkOverview from './CoworkOverview';
import CoworkRepair from './CoworkRepair';
import CoworkReviewQueue from './CoworkReviewQueue';
import { coworkStatus } from './coworkStatus';
import { waitingRuns } from './coworkReview';
import { openRepair } from './coworkProposalModel';
import { useCoworkAdvanced } from './coworkView';
import { useItemDesk } from '@/api/coworkDesks';
import type { PlannedStart } from '@/api/coworkDesks';
import { useCoworkProposals } from '@/api/coworkProposals';
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
 * queue and the history (one request); a repair Cowork worked out is one more entry (./CoworkRepair.tsx), and so is an
 * invitation to a colleague's desk (./CoworkDeskPanel.tsx CoworkDeskInvitation).
 */
function useNeedsEntries(item: CoworkItem, reloadKey: number | undefined, onAccepted: (planned: PlannedStart | null) => void): NeedsEntry[] {
    const runs = useCoworkRunsQuery(item.id, reloadKey).data?.runs;
    const repair = openRepair(useCoworkProposals(item.id).data);
    const desk = useItemDesk(item.id).data;
    const reviews = waitingRuns(runs).length;
    const entries: NeedsEntry[] = [];
    // A colleague's invitation to a desk: accepted with one click, its planned start included.
    if (desk && !desk.accepted) entries.push({ key: 'invitation', count: 1, content: <CoworkDeskInvitation coworkId={item.id} title={item.title} desk={desk} onAccepted={onAccepted} /> });
    if (reviews > 0) entries.push({ key: 'review', count: reviews, content: <CoworkReviewQueue coworkId={item.id} reloadKey={reloadKey} runs={runs} /> });
    if (repair) entries.push({ key: 'repair', count: 1, content: <CoworkRepair coworkId={item.id} proposal={repair} /> });
    return entries;
}

/** The pane while it is not being edited. Split from the editor so its reads stop while the form is open. */
function DetailView({ item, agents, onRunNow, onToggle, onDelete, busy, reloadKey, onEdit, t }: ViewProps) {
    const status = coworkStatus(item);
    const [planned, setPlanned] = useState<PlannedStart | null>(null);
    const needs = useNeedsEntries(item, reloadKey, setPlanned);
    const advanced = useCoworkAdvanced(item.id);
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
                onAdvanced={() => advanced.show()}
                onToggle={onToggle}
                onDelete={onDelete}
                onRunNow={onRunNow}
            />
            <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden custom-scrollbar px-4 sm:px-[26px] py-[22px] flex flex-col gap-[18px]">
                <CoworkNeedsStrip entries={needs} ref={strip} />
                <CoworkAutoFixNote coworkId={item.id} />
                <CoworkOverview
                    item={item}
                    agents={agents}
                    reloadKey={reloadKey}
                    t={t}
                    onOpenRun={(runId) => advanced.show('runs', runId)}
                    onOpenPlan={() => advanced.show('plan')}
                    notes={planned && <PlannedStartLine planned={planned} />}
                />
                <CoworkAdvanced
                    item={item}
                    agents={agents}
                    busy={busy}
                    reloadKey={reloadKey}
                    onEdit={onEdit}
                    open={advanced.open}
                    onOpenChange={advanced.setShown}
                    request={advanced.request}
                    t={t}
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
            // One pane per item: what it remembers (Advanced, a link it took) starts again for another item.
            key={item.id}
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
