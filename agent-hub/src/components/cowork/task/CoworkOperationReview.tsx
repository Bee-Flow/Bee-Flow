import type { CoworkItem } from '@/api/cowork.types';
import { useCoworkItemActions } from '@/api/coworkTask';
import type { TranslateFn } from '@/hooks/useTranslation';
import { heldWords, type HeldBy } from './CoworkTaskHeader';
import { BTN_PRIMARY, BTN_QUIET, Failure, ROW_ACTIONS } from './taskUi';

export type TaskOperation = 'run' | 'pause' | 'resume';

function operationLabel(operation: TaskOperation, t: TranslateFn) {
    switch (operation) {
        case 'run': return t('cowork_task.action.run_for_real', 'Run for real now');
        case 'pause': return t('cowork_task.action.pause', 'Pause');
        case 'resume': return t('cowork_task.action.resume', 'Resume');
    }
}

function unavailable(operation: TaskOperation, item: CoworkItem, heldBy: HeldBy, t: TranslateFn) {
    if (heldBy === 'live' || (operation === 'run' && heldBy)) return heldWords(heldBy, t);
    if (operation === 'run' && item.triggerKind === 'app_event') return t('cowork_task.held.by_mail', 'It starts when a new e-mail arrives, so it cannot be started by hand.');
    if (operation === 'pause' && item.isActive === false) return t('cowork_task.operation.already_paused', 'This task is already paused.');
    if (operation === 'resume' && item.isActive === true) return t('cowork_task.operation.already_active', 'This task is already active.');
    return null;
}

function question(operation: TaskOperation, title: string, t: TranslateFn) {
    switch (operation) {
        case 'run': return t('cowork_task.operation.run', 'Run “{title}” once now using its current settings?', {title});
        case 'pause': return t('cowork_task.operation.pause', 'Pause future runs of “{title}”?', {title});
        case 'resume': return t('cowork_task.operation.resume', 'Let “{title}” run again on its usual trigger?', {title});
    }
}

/** An operation suggested by Bee remains a request until the owner confirms it here. */
export default function CoworkOperationReview({operation, item, heldBy, onDone, t}: {
    operation: TaskOperation; item: CoworkItem; heldBy: HeldBy; onDone: () => void; t: TranslateFn;
}) {
    const {change, runNow} = useCoworkItemActions(item.id);
    const busy = change.isPending || runNow.isPending;
    const why = unavailable(operation, item, heldBy, t);
    if (why) return <div className="grid justify-items-start gap-3">
        <p role="status">{why}</p>
        <button className={BTN_QUIET} onClick={onDone}>{t('cowork_task.orb.back', 'Back to the orb')}</button>
    </div>;
    const confirm = () => {
        if (operation === 'run') runNow.mutate(undefined, {onSuccess: onDone});
        else change.mutate({isActive: operation === 'resume'}, {onSuccess: onDone});
    };
    return <div className="grid gap-3" role="group" aria-label={operationLabel(operation, t)}>
        <p>{question(operation, item.title, t)}</p>
        <div className={ROW_ACTIONS}>
            <button className={BTN_PRIMARY} disabled={busy} onClick={confirm}>{operationLabel(operation, t)}</button>
            <button className={BTN_QUIET} disabled={busy} onClick={onDone}>{t('cowork_task.edit.cancel', 'Cancel')}</button>
        </div>
        <Failure error={change.error || runNow.error} t={t}/>
    </div>;
}
