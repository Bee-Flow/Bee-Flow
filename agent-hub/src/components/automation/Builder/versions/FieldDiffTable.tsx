import useTranslation from '../../../../hooks/useTranslation';
import type { FieldChange } from '../../../../api/queries/automation/versions';
import { formatValue, settingName } from './versionText';

interface Props {
    changes: FieldChange[];
    /** Version numbers for the column heads: Was (vX) · Becomes (vY). */
    from: number;
    to: number;
}

const DOT: Record<FieldChange['change'], string> = {
    changed: 'bg-[var(--warning)]',
    added: 'bg-[var(--success)]',
    removed: 'bg-[var(--error)]',
    moved: 'bg-[var(--text-tertiary)]',
};

// The table's own width decides: under 640px each change is two lines
// (Step · Setting, then Was · Becomes); from 640px the four columns share the
// width, the values the most. Values wrap instead of clipping, so nothing
// ever needs a sideways scroll.
const COLS = 'grid grid-cols-2 gap-x-2.5 gap-y-1.5 px-3.5 @[640px]/fielddiff:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,1.4fr)] @[640px]/fielddiff:gap-y-0';
const VALUE = 'w-fit max-w-full px-2 py-0.5 rounded-md line-clamp-4 wrap-anywhere whitespace-pre-line';

/** Step · Setting · Was (vX) · Becomes (vY), one row per changed setting. */
export default function FieldDiffTable({ changes, from, to }: Props) {
    const { t } = useTranslation();
    const nothing = <span className="inline-block py-0.5 text-[var(--text-tertiary)]">{t('automations.versions.diff.nothing', 'nothing')}</span>;
    return (
        <div role="table" className="@container/fielddiff rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px]">
            <div role="row" className={`${COLS} py-2 rounded-t-[10px] bg-[var(--bg-secondary)] font-semibold text-[var(--text-secondary)]`}>
                <span role="columnheader">{t('automations.versions.diff.step', 'Step')}</span>
                <span role="columnheader">{t('automations.versions.diff.setting', 'Setting')}</span>
                <span role="columnheader">{t('automations.versions.diff.was', 'Was (v{version})', { version: from })}</span>
                <span role="columnheader">{t('automations.versions.diff.becomes', 'Becomes (v{version})', { version: to })}</span>
            </div>
            {changes.map((c, i) => {
                // Automation-level rows (runPolicy, description, ...) have no step.
                const stepText = c.stepId ? c.stepLabel : t('automations.versions.automationRow', 'Automation');
                const before = formatValue(c.before);
                const after = formatValue(c.after);
                const setting = c.change === 'added' ? t('automations.versions.diff.newStep', 'New step')
                    : c.change === 'removed' ? t('automations.versions.diff.removedStep', 'Step removed')
                        : c.change === 'moved' ? t('automations.versions.diff.moved', 'Position in the flow')
                            : settingName(t, c.setting, c.settingLabel);
                return (
                    <div role="row" key={`${c.stepId}:${c.setting ?? c.change}:${i}`} className={`${COLS} py-2.5 border-t border-[var(--border-default)] items-start`}>
                        <span role="cell" className="flex items-center gap-1.5 min-w-0 py-0.5">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[c.change]}`} />
                            <span className="min-w-0 line-clamp-2 wrap-anywhere">{c.stepNumber != null ? `${c.stepNumber} · ${stepText}` : stepText}</span>
                        </span>
                        <span role="cell" className="min-w-0 py-0.5 text-[var(--text-secondary)] line-clamp-2 wrap-anywhere">{setting}</span>
                        <span role="cell" className="min-w-0">
                            {before
                                ? <span title={before} className={`${VALUE} bg-[color-mix(in_srgb,var(--error)_8%,transparent)] line-through text-[var(--text-secondary)]`}>{before}</span>
                                : nothing}
                        </span>
                        <span role="cell" className="min-w-0">
                            {after
                                ? <span title={after} className={`${VALUE} bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--text-primary)]`}>{after}</span>
                                : nothing}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
