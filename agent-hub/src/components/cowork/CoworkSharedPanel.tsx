/**
 * A task a colleague shared with the owner, opened in the sheet (`kind: 'shared'` of ./coworkSheetPanels.ts), read
 * only: whose it is, its sentence and its last runs. Deciding one of its questions happens under Approvals.
 */
import CoworkSheetHeading from './CoworkSheetHeading';
import type { CoworkSheetPanelProps } from './coworkSheetPanels';
import { useSharedItem, useSharedWithMe } from '@/api/coworkShares';
import { useTranslation } from '@/hooks/useTranslation';

export default function CoworkSharedPanel({ panel }: CoworkSheetPanelProps) {
    const { t } = useTranslation();
    const id = panel.kind === 'shared' ? panel.id : null;
    const view = useSharedItem(id).data;
    const shared = useSharedWithMe().data?.find((s) => s.id === id);
    if (!view) return <p className="text-[14px] text-[var(--text-tertiary)]">{t('cowork_home.loading', 'Loading…')}</p>;
    const owner = shared?.ownerName ?? '';
    return (
        <div className="flex flex-col gap-4" data-testid="cowork-shared-panel">
            <CoworkSheetHeading sub={owner ? t('cowork_home.shared.from', 'From {owner}. You can see it, never change it.', { owner }) : null}>
                {view.item.title || t('cowork_home.untitled', 'Untitled task')}
            </CoworkSheetHeading>
            <p className="text-[15px] whitespace-pre-wrap text-[var(--text-secondary)]">{view.item.prompt}</p>
            <ul className="flex flex-col">
                {view.runs.map((r) => (
                    <li key={r.id} className="py-2 border-t first:border-t-0 border-[var(--border-subtle)] text-[14px] text-[var(--text-tertiary)]">
                        <span className="tabular-nums">{r.startedAt ? new Date(r.startedAt).toLocaleString() : ''}</span>
                        {r.result ? ` · ${r.result.slice(0, 160)}` : ''}
                    </li>
                ))}
            </ul>
        </div>
    );
}
