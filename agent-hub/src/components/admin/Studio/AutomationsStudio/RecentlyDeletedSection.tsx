import { ChevronDown, ChevronRight, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useAutomationTrashQuery, useRestoreAutomationMutation } from '../../../../api/queries/automation/library';
import type { TrashedAutomation } from '../../../../api/queries/automation/library';

const DAY_MS = 86_400_000;

/** Whole days until the purge, never below zero; null when unknown. */
export function daysLeft(purgeAt: string | null, now: number = Date.now()): number | null {
    if (!purgeAt) return null;
    const at = new Date(purgeAt).getTime();
    if (!Number.isFinite(at)) return null;
    return Math.max(0, Math.ceil((at - now) / DAY_MS));
}

/**
 * "Recently deleted": the automations in the trash, at the foot of the library.
 *
 * Closed by default and read only while open, so the sidebar costs no extra
 * request until somebody goes looking. A restore brings the automation back
 * PAUSED with its runs, and `onRestored` refreshes the list above.
 */
export default function RecentlyDeletedSection({ onRestored }: { onRestored: (id: string) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const trash = useAutomationTrashQuery({ enabled: open });
    const restore = useRestoreAutomationMutation({ onRestored });
    const rows = trash.data?.automations || [];

    return (
        <div className="mt-2 border-t border-[var(--border-default)] pt-1" data-testid="automations-trash">
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                className="flex items-center gap-1 w-full text-left px-1.5 py-1 rounded-md text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
            >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Trash2 size={11} aria-hidden="true" />
                <span className="flex-1 truncate">{t('automations.library.recentlyDeleted', 'Recently deleted')}</span>
                {open && rows.length > 0 && <span className="text-[10px] shrink-0">{rows.length}</span>}
            </button>
            {open && (
                <div className="ml-3 border-l border-[var(--border-default)] pl-1">
                    {trash.isLoading && (
                        <div className="text-[10px] text-[var(--text-tertiary)] px-2 py-1">{t('automations.library.loading', 'Loading…')}</div>
                    )}
                    {trash.isError && (
                        <div role="alert" className="text-[10px] text-[var(--error)] px-2 py-1">
                            {t('automations.library.trashUnreadable', 'The trash could not be read.')}
                        </div>
                    )}
                    {trash.isSuccess && rows.length === 0 && (
                        <div className="text-[10px] text-[var(--text-tertiary)] italic px-2 py-1">
                            {t('automations.library.trashEmpty', 'Nothing deleted in the last {days} days.', { days: trash.data.retentionDays })}
                        </div>
                    )}
                    {rows.map(r => (
                        <TrashRow
                            key={r.id}
                            row={r}
                            busy={restore.isPending && restore.variables === r.id}
                            onRestore={() => restore.mutate(r.id)}
                        />
                    ))}
                    {restore.isError && (
                        <div role="alert" className="text-[10px] text-[var(--error)] px-2 py-1">{restore.error.message}</div>
                    )}
                </div>
            )}
        </div>
    );
}

function TrashRow({ row, busy, onRestore }: { row: TrashedAutomation; busy: boolean; onRestore: () => void }) {
    const { t } = useTranslation();
    const title = row.title || t('automations.library.untitled', 'Untitled automation');
    const left = daysLeft(row.purgeAt);
    let meta = '';
    if (left === 0) meta = t('automations.library.purgedToday', 'Removed for good today');
    else if (left === 1) meta = t('automations.library.oneDayLeft', '1 day left');
    else if (left !== null) meta = t('automations.library.daysLeft', '{count} days left', { count: left });
    return (
        <div className="group flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
            <div className="flex-1 min-w-0">
                <div className="truncate" title={title}>{title}</div>
                {meta && <div className="text-[10.5px] text-[var(--text-tertiary)] truncate">{meta}</div>}
            </div>
            <button
                type="button"
                onClick={onRestore}
                disabled={busy}
                aria-label={t('automations.library.restoreNamed', 'Restore {title}', { title })}
                className="shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 transition"
            >
                <RotateCcw size={11} aria-hidden="true" />
                {t('automations.library.restore', 'Restore')}
            </button>
        </div>
    );
}
