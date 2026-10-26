import { AlertTriangle, Loader2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import type { DestructiveConfirmProps } from '../ColumnDesigner.types';
import { nameList } from './ColumnDesigner.helpers';

export const BTN = 'px-3 py-1.5 rounded-[10px] text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

export function DestructiveConfirm({ t, changes, rowCount, usage, busy, onCancel, onConfirm }: DestructiveConfirmProps) {
    if (!changes) return null;
    const touched = new Set<string | null | undefined>([...changes.removed, ...changes.retyped.map(r => r.key)]);
    const affected = usage.filter(u => (u.columns || []).some(c => touched.has(c)));
    return (
        <Modal
            open
            onClose={onCancel}
            // A destructive confirmation must not be dismissible by a stray
            // click on the backdrop; ESC still works, because ESC is a
            // deliberate cancel.
            disableBackdropClose
            size="md"
            title={
                <span className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 [color:var(--error)]" aria-hidden="true" />
                    {t('datatables.destructive_title', 'This throws away data')}
                </span>
            }
        >
            <div className="space-y-3">
                {changes.removed.length > 0 && (
                    <p className="text-sm text-[var(--text-secondary)]">
                        {rowCount === 1
                            ? t('datatables.destructive_removed_one', 'Removing {keys} deletes its value in the 1 row.', { keys: changes.removed.join(', ') })
                            : t('datatables.destructive_removed', 'Removing {keys} deletes its values in all {n} rows.', { keys: changes.removed.join(', '), n: rowCount })}
                    </p>
                )}
                {changes.retyped.length > 0 && (
                    <p className="text-sm text-[var(--text-secondary)]">
                        {t('datatables.destructive_retyped', 'Changing the type of {keys} rewrites every existing value, and anything that does not fit the new type is lost.', { keys: changes.retyped.map(r => r.key).join(', ') })}
                    </p>
                )}
                {affected.length > 0 && (
                    <p className="text-xs px-3 py-2 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)]">
                        {affected.length === 1
                            ? t('datatables.destructive_readers_one', '1 automation reads one of these columns and will stop working: {names}.', { names: nameList(affected) })
                            : t('datatables.destructive_readers', '{n} automations read one of these columns and will stop working: {names}.', { n: affected.length, names: nameList(affected) })}
                    </p>
                )}
                <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={onCancel} className={`${BTN} border [border-color:var(--border-default)] [color:var(--text-secondary)] [outline-color:var(--accent-primary)]`}>
                        {t('datatables.destructive_keep', 'Keep them')}
                    </button>
                    <button type="button" onClick={onConfirm} disabled={busy}
                        className={`${BTN} font-medium text-white disabled:opacity-50 inline-flex items-center gap-1.5 [background:var(--error)] [outline-color:var(--error)]`}>
                        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                        {t('datatables.destructive_confirm', 'Save anyway')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
