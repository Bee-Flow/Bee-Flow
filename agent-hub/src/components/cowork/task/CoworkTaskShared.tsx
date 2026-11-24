/**
 * A task someone else shared with the reader, opened (./CoworkTaskView.tsx): read only. Its status, name, when it
 * runs, "Shared by …" with what the reader may do, its latest result and its earlier runs (server
 * usecases/coworkShares.mts sharedView). No actions: only its owner changes it, and a reader who may answer does so
 * where its questions arrive.
 */
import CoworkTaskHeader from './CoworkTaskHeader';
import CoworkTaskResult from './CoworkTaskResult';
import CoworkTaskRuns from './CoworkTaskRuns';
import { latestRunOf } from './coworkTaskModel';
import { coworkStatus } from '../coworkStatus';
import { META } from './taskUi';
import { useSharedItem, useSharedWithMe, type SharedView } from '@/api/coworkShares';
import type { CoworkItem, CoworkRun } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The shared view as the parts of the sheet read an item and its runs. */
export function sharedAsItem(view: SharedView): { item: CoworkItem; runs: CoworkRun[] } {
    const runs: CoworkRun[] = view.runs.map((r) => ({ id: r.id, status: r.status ?? '', startedAt: r.startedAt ?? '', result: r.result, durationMs: r.durationMs }));
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

export default function CoworkTaskShared({ itemId, t }: { itemId: string; t: TranslateFn }) {
    const view = useSharedItem(itemId);
    const owner = (useSharedWithMe().data ?? []).find((s) => s.id === itemId)?.ownerName ?? t('cowork_task.shared.someone', 'a colleague');
    if (view.isPending) return <p className={META} role="status">{t('cowork_task.loading', 'Opening the task…')}</p>;
    if (!view.data) return <p className={META} role="status" data-testid="cowork-task-gone">{t('cowork_task.gone', 'This task is gone, or it is not shared with you.')}</p>;
    const { item, runs } = sharedAsItem(view.data);
    const role = view.data.role === 'approver' ? 'approver' : 'viewer';
    return (
        <div className="flex flex-col gap-5" data-testid="cowork-task-shared">
            <CoworkTaskHeader item={item} status={coworkStatus(item)} sends={t('cowork_task.head.sends_owner', "as {owner} set it up", { owner })} goal={null} sharedBy={{ owner, role }} t={t} />
            <CoworkTaskResult coworkId={item.id} item={item} latest={latestRunOf(runs)} withReceipt={false} t={t} />
            <CoworkTaskRuns coworkId={item.id} runs={runs} withReceipts={false} t={t} />
        </div>
    );
}
