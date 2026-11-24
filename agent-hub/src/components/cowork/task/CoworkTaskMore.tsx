/**
 * "More", at the bottom of an opened task (./CoworkTaskView.tsx): everything a task holds besides what it does,
 * folded until asked for, one row open at a time. Goal, Check each result first, Memory, Budget, Share, Pass the result
 * to a colleague's task, Hand over, Template and package file, Receipts, Change history and Delete. A row reads its
 * data only once More is opened, and its body only while it is open.
 *
 * Delete asks in the page itself; once it is gone the sheet closes. The server keeps no deleted task, so there is no
 * Undo for it.
 */
import { useState } from 'react';
import TaskMoreGoal from './TaskMoreGoal';
import { HandOverRow, PassRow, ShareRow } from './TaskMorePeople';
import { HistoryRow, ReceiptsRow, TemplateRow } from './TaskMoreRecords';
import { BudgetRow, CheckFirstRow, MemoryRow } from './TaskMoreSettings';
import { BTN_DANGER, BTN_QUIET, Failure, Fold, FoldRow, ROW_ACTIONS } from './taskUi';
import { useCoworkItemActions } from '@/api/coworkTask';
import type { CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

function DeleteRow({ item, open, onToggle, onGone, t }: { item: Pick<CoworkItem, 'id' | 'title'>; open: boolean; onToggle: (id: string | null) => void; onGone: () => void; t: TranslateFn }) {
    const { remove } = useCoworkItemActions(item.id);
    return (
        <FoldRow id="delete" label={t('cowork_task.more.delete', 'Delete this task')} danger open={open} onToggle={onToggle}>
            <p className="text-[15px]" data-testid="cowork-task-delete-confirm">
                {t('cowork_task.delete.confirm', "Delete '{title}'? It stops for good, with its runs. This cannot be undone.", { title: item.title })}
            </p>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_DANGER} disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onGone })}>{t('cowork_task.delete.go', 'Delete task')}</button>
                <button type="button" className={BTN_QUIET} onClick={() => onToggle(null)}>{t('cowork_task.keep_it', 'Keep it')}</button>
            </div>
            <Failure error={remove.error} t={t} />
        </FoldRow>
    );
}

interface CoworkTaskMoreProps {
    item: CoworkItem;
    /** The task has approved fixed steps (Check each result first is theirs). */
    hasApprovedSteps: boolean;
    /** The task is gone (deleted, handed over): the sheet closes. */
    onGone: () => void;
    locale: string;
    t: TranslateFn;
}

function MoreRows({ item, hasApprovedSteps, onGone, locale, t }: CoworkTaskMoreProps) {
    const [row, setRow] = useState<string | null>(null);
    const at = (id: string) => ({ coworkId: item.id, open: row === id, onToggle: setRow, t });
    const limit = typeof item.monthlyBudget === 'number' ? item.monthlyBudget : null;
    return (
        <>
            <TaskMoreGoal {...at('goal')} />
            <CheckFirstRow {...at('review')} hasApprovedSteps={hasApprovedSteps} />
            <MemoryRow {...at('memory')} />
            <BudgetRow {...at('budget')} limit={limit} locale={locale} />
            <ShareRow {...at('share')} />
            <PassRow {...at('pass')} />
            <HandOverRow {...at('handover')} title={item.title} onGone={onGone} />
            <TemplateRow {...at('template')} title={item.title} />
            <ReceiptsRow {...at('receipts')} />
            <HistoryRow {...at('history')} />
            <DeleteRow item={item} open={row === 'delete'} onToggle={setRow} onGone={onGone} t={t} />
        </>
    );
}

export default function CoworkTaskMore(props: CoworkTaskMoreProps) {
    return (
        <Fold label={props.t('cowork_task.more.heading', 'More')}>
            <MoreRows {...props} />
        </Fold>
    );
}
