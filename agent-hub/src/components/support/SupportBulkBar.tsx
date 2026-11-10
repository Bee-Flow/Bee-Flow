import type React from 'react';
import { GHOST_BTN } from '../admin/Studio/SupportStudio/supportStyles';
import { useTranslation } from '../../hooks/useTranslation';
import { priorityBadges } from './supportInboxLabels';
import type { useSupportBulk } from './useSupportInboxActions';

/** The bar above the thread rows once something is ticked: resolve, set a priority or add a tag to all of them. */
export default function SupportBulkBar({ bulk }: { bulk: ReturnType<typeof useSupportBulk> }) {
    const { t } = useTranslation();
    const { selectedIds, setSelectedIds, bulkBusy, runBulk } = bulk;
    if (selectedIds.size === 0) return null;
    return (
        <div className="px-3 py-2 border-b flex items-center gap-2 flex-wrap text-xs border-[var(--border-default)] bg-[var(--bg-tertiary)]">
            <span className="text-[var(--text-secondary)]">{t('support.support_inbox_selected', '{count} selected', { count: selectedIds.size })}</span>
            <button disabled={bulkBusy} onClick={() => runBulk('resolve')} className={GHOST_BTN}>{t('support.support_inbox_resolve', 'Resolve')}</button>
            <select disabled={bulkBusy} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { if (e.target.value) { runBulk('priority', { priority: e.target.value }); e.target.value = ''; } }} className="rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-1 text-[var(--text-secondary)]" defaultValue="">
                <option value="">{t('support.support_inbox_set_priority', 'Set priority…')}</option>
                {Object.entries(priorityBadges(t)).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <input
                placeholder={t('support.support_inbox_add_tag_enter', 'Add tag + Enter')}
                disabled={bulkBusy}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) { runBulk('tag', { tag: (e.target as HTMLInputElement).value.trim() }); (e.target as HTMLInputElement).value = ''; } }}
                className="w-28 rounded-md border px-2 py-1 border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
            />
            <button onClick={() => setSelectedIds(new Set())} className="px-2 py-1 rounded text-[var(--text-tertiary)]">{t('support.support_inbox_clear', 'Clear')}</button>
        </div>
    );
}
