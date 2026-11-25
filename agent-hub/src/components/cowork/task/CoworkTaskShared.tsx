/**
 * A task someone else shared with the reader, opened as a page (`kind: 'shared'` of ../coworkSheetPanels.ts): read
 * only. Its status, name, when it runs, "Shared by …" with what the reader may do, its latest result and its earlier runs (server
 * usecases/coworkShares.mts sharedView). No actions: only its owner changes it, and a reader who may answer does so
 * where its questions arrive.
 */
import CoworkTaskHeader from './CoworkTaskHeader';
import CoworkTaskResult from './CoworkTaskResult';
import CoworkTaskRuns from './CoworkTaskRuns';
import { latestRunOf } from './coworkTaskModel';
import { whenLine } from '../coworkOverviewModel';
import { taskStatus } from '../coworkTaskStatus';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import { META } from './taskUi';
import { useSharedItem, useSharedWithMe, type SharedView } from '@/api/coworkShares';
import type { CoworkItem, CoworkRun } from '@/api/cowork.types';
import { useTranslation } from '@/hooks/useTranslation';

/** The shared view as the parts of the sheet read an item and its runs; an answer without its item reads as gone. */
function sharedAsItem(view: SharedView): { item: CoworkItem; runs: CoworkRun[] } | null {
    if (!view?.item) return null;
    const runs: CoworkRun[] = (view.runs ?? []).map((r) => ({ id: r.id, status: r.status ?? '', startedAt: r.startedAt ?? '', result: r.result, durationMs: r.durationMs }));
    const item: CoworkItem = {
        id: view.item.id,
        title: view.item.title,
        prompt: view.item.prompt,
        repeatInterval: view.item.repeatInterval,
        nextRunAt: view.item.nextRunAt,
        lastStatus: view.item.lastStatus,
        isActive: view.item.isActive,
        triggerKind: view.item.triggerKind === 'app_event' ? 'app_event' : 'schedule',
        runCount: runs.length,
        lastRunAt: runs[0]?.startedAt || null,
    };
    return { item, runs };
}

export default function CoworkTaskShared({ panel }: CoworkSheetPanelProps) {
    const { t } = useTranslation();
    const itemId = panel.kind === 'shared' || panel.kind === 'task' ? panel.id : '';
    const view = useSharedItem(itemId);
    const owner = (useSharedWithMe().data ?? []).find((s) => s.id === itemId)?.ownerName ?? t('cowork_task.shared.someone', 'a colleague');
    if (view.isPending) return <p className={META} role="status">{t('cowork_task.loading', 'Opening the task…')}</p>;
    const shared = view.data ? sharedAsItem(view.data) : null;
    if (!view.data || !shared) return <p className={META} role="status" data-testid="cowork-task-gone">{t('cowork_task.gone', 'This task is gone, or it is not shared with you.')}</p>;
    const { item, runs } = shared;
    const role = view.data.role === 'approver' ? 'approver' : 'viewer';
    return (
        <div className="flex flex-col gap-6" data-testid="cowork-task-shared">
            <CoworkTaskHeader item={item} status={taskStatus(item)} meta={`${whenLine(item, t)} · ${t('cowork_task.head.sends_owner', 'as {owner} set it up', { owner })}`} sharedBy={{ owner, role }} t={t} />
            <CoworkTaskResult item={item} latest={latestRunOf(runs)} t={t} />
            <CoworkTaskRuns coworkId={item.id} runs={runs} withReceipts={false} heading={t('cowork_task.runs.heading', 'Earlier runs')} t={t} />
        </div>
    );
}
