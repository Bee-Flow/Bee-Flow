/**
 * The task, opened in the sheet (`kind: 'task'` of ./coworkSheetPanels.ts). For now this is the existing item pane
 * (./CoworkDetail.tsx) with what it needs around it: the item from the home's list, Run now, Pause, Edit and Delete
 * (asked once), and the reads again after each. The opened task of the redesign replaces this file; the registry is
 * the only place that names it.
 */
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Modal from '../shared/Modal';
import CoworkDetail from './CoworkDetail';
import { PILL_PRIMARY, PILL_QUIET } from './coworkUi';
import type { CoworkSheetPanelProps } from './coworkSheetPanels';
import useCoworkList from './useCoworkList';
import { saveErrorMessage } from './mailTrigger';
import { deleteCowork, runCoworkNow, toggleCowork, updateCowork } from '@/api/coworkApi';
import { useCoworkAgents } from '@/api/queries/coworkReads';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import type { CoworkItem, CoworkUpdate } from '@/api/cowork.types';

function DeleteConfirm({ item, onCancel, onConfirm }: { item: CoworkItem; onCancel: () => void; onConfirm: () => void }) {
    const { t } = useTranslation();
    return (
        <Modal open onClose={onCancel} size="sm" label={t('cowork_home.delete.heading', 'Delete this task?')} title={t('cowork_home.delete.heading', 'Delete this task?')}>
            <p className="text-[14px] mb-4 text-[var(--text-secondary)]">
                {t('cowork_home.delete.consequence', '“{title}” stops running and its history is removed. This cannot be undone.', { title: item.title })}
            </p>
            <div className="flex justify-end gap-2">
                <button type="button" className={PILL_QUIET} onClick={onCancel}>{t('cowork_home.delete.cancel', 'Cancel')}</button>
                <button type="button" className={PILL_PRIMARY} data-testid="cowork-confirm-delete" onClick={onConfirm}>{t('cowork_home.delete.confirm', 'Delete')}</button>
            </div>
        </Modal>
    );
}

/** What the pane's buttons do: each one, then the reads again; a refusal is said above the pane. */
function useTaskActions(close: () => void) {
    const { t } = useTranslation();
    const client = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const run = useCallback(async (fn: () => Promise<unknown>, after?: () => void, words: (err: unknown) => string | null | undefined = errorMessage) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
            await client.invalidateQueries({ queryKey: ['cowork'] });
            setReloadKey((k) => k + 1);
            after?.();
        } catch (err) {
            setError(words(err) ?? null);
        } finally {
            setBusy(false);
        }
    }, [client]);
    return {
        busy, error, reloadKey, clearError: () => setError(null),
        runNow: (id: string) => run(() => runCoworkNow(id)),
        toggle: (id: string) => run(() => toggleCowork(id)),
        remove: (id: string) => run(() => deleteCowork(id), close),
        save: (id: string, patch: CoworkUpdate, done: () => void) => run(() => updateCowork(id, patch), done, (err) => saveErrorMessage(err, t)),
    };
}

export default function CoworkTaskPanel({ panel, close }: CoworkSheetPanelProps) {
    const { t } = useTranslation();
    const id = panel.kind === 'task' ? panel.id : '';
    const list = useCoworkList();
    const item = list.data?.items.find((i) => i.id === id) ?? null;
    const agents = useCoworkAgents();
    const actions = useTaskActions(close);
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState<CoworkItem | null>(null);
    if (!item) {
        return <p className="text-[14px] text-[var(--text-tertiary)]">{list.isPending ? t('cowork_home.loading', 'Loading…') : t('cowork_home.sheet.gone', 'This task is not there any more.')}</p>;
    }
    return (
        <div className="-mx-4 sm:-mx-6 flex-1 min-h-0 flex flex-col" data-testid="cowork-task-panel">
            {actions.error && !editing && <p className="mx-4 mb-2 text-[13px] text-[var(--error-ink)]" role="alert">{actions.error}</p>}
            <CoworkDetail
                item={item}
                agents={agents}
                onRunNow={(itemId) => { void actions.runNow(itemId); }}
                onToggle={(itemId) => { void actions.toggle(itemId); }}
                onDelete={setDeleting}
                onSave={(patch) => { void actions.save(item.id, patch, () => setEditing(false)); }}
                editing={editing}
                onEdit={() => { actions.clearError(); setEditing(true); }}
                onCancelEdit={() => { actions.clearError(); setEditing(false); }}
                saveError={actions.error}
                busy={actions.busy}
                reloadKey={actions.reloadKey}
            />
            {deleting && <DeleteConfirm item={deleting} onCancel={() => setDeleting(null)} onConfirm={() => { setDeleting(null); void actions.remove(deleting.id); }} />}
        </div>
    );
}
