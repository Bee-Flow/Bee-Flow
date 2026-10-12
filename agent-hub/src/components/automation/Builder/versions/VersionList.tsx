import { Flag } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import type { VersionRow } from '../../../../api/queries/automation/versions';
import { groupVersions, milestonesOnly, shortWhen, versionMeta, versionTitle } from './versionText';

interface Props {
    rows: VersionRow[];
    selectedId: string | null;
    onSelect: (row: VersionRow) => void;
    milestones: boolean;
    onMilestonesChange: (on: boolean) => void;
}

/** The left column of the Versions tab: "History", grouped by live state. */
export default function VersionList({ rows, selectedId, onSelect, milestones, onMilestonesChange }: Props) {
    const { t } = useTranslation();
    const groups = groupVersions(milestones ? milestonesOnly(rows) : rows);
    const groupLabel = {
        pending: t('automations.versions.group.pending', 'Not live yet'),
        live: t('automations.versions.group.live', 'Live'),
        earlier: t('automations.versions.group.earlier', 'Earlier'),
    };

    return (
        <div className="flex flex-col min-h-0 bg-[var(--bg-card)] text-[12px]">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-default)]">
                <span className="font-semibold text-[13px] text-[var(--text-primary)]">
                    {t('automations.versions.history', 'History')}
                </span>
                <label className="ml-auto flex items-center gap-1.5 text-[var(--text-secondary)] cursor-pointer select-none">
                    {t('automations.versions.milestonesOnly', 'Milestones only')}
                    <input
                        type="checkbox"
                        role="switch"
                        checked={milestones}
                        onChange={(e) => onMilestonesChange(e.target.checked)}
                        className="peer sr-only"
                    />
                    <span
                        aria-hidden
                        className={`relative w-[26px] h-4 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--accent-primary)] ${
                            milestones ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)]'}`}
                    >
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-[left] ${milestones ? 'left-3' : 'left-0.5'}`} />
                    </span>
                </label>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                {groups.length === 0 && (
                    <div className="px-4 py-6 text-[var(--text-tertiary)]">
                        {milestones
                            ? t('automations.versions.noMilestones', 'No named milestones yet. Select a version and give it a name.')
                            : t('automations.versions.empty', 'No saved versions yet.')}
                    </div>
                )}
                {groups.map((g, gi) => (
                    <section key={g.key} aria-label={groupLabel[g.key]}>
                        <div className={`px-4 pt-2 pb-1 text-[10px] tracking-[.06em] uppercase font-semibold text-[var(--text-tertiary)] ${gi > 0 ? 'border-t border-[var(--border-default)]' : ''}`}>
                            {groupLabel[g.key]}
                        </div>
                        <ul>
                            {g.rows.map((v, i) => (
                                <li key={v.id} className={i > 0 ? 'border-t border-[var(--border-default)]' : ''}>
                                    <VersionListRow row={v} selected={v.id === selectedId} earlier={g.key === 'earlier'} onSelect={onSelect} />
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
        </div>
    );
}

function VersionListRow({ row, selected, earlier, onSelect }: {
    row: VersionRow; selected: boolean; earlier: boolean; onSelect: (row: VersionRow) => void;
}) {
    const { t } = useTranslation();
    const liveSince = shortWhen(row.liveSince, t);
    return (
        <button
            type="button"
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelect(row)}
            className={`w-full text-left grid grid-cols-[36px_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 px-4 py-2.5 transition-colors ${
                selected
                    ? 'bg-[color-mix(in_srgb,var(--type-ai)_7%,transparent)] shadow-[inset_3px_0_0_var(--accent-primary)]'
                    : 'hover:bg-[var(--bg-secondary)]'}`}
        >
            <span className={`font-bold ${selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>v{row.version}</span>
            <span className="flex items-center gap-1.5 min-w-0">
                <span className={`truncate ${earlier ? 'font-medium text-[var(--text-secondary)]' : 'font-semibold text-[var(--text-primary)]'}`}>
                    {versionTitle(row, t)}
                </span>
                {row.isEditing && (
                    <span className="shrink-0 px-1.5 rounded-full bg-[var(--bg-tertiary)] text-[10px] font-semibold text-[var(--text-primary)]">
                        {t('automations.versions.chip.editing', 'editing')}
                    </span>
                )}
                {row.isLive && (
                    <span className="shrink-0 px-1.5 rounded-full bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)] text-[10px] font-semibold">
                        {liveSince
                            ? t('automations.versions.chip.liveSince', 'live since {date}', { date: liveSince })
                            : t('automations.versions.chip.live', 'live')}
                    </span>
                )}
                {row.name && (
                    <Flag size={12} className="shrink-0 text-[var(--type-branch)]" aria-label={t('automations.versions.milestone', 'Milestone')} />
                )}
            </span>
            <span />
            <span className="text-[var(--text-tertiary)] truncate">{versionMeta(row, t)}</span>
        </button>
    );
}
