import { Check, List } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { previewValue as previewValueJs, walkPath } from '../../../../utils/bindingHelpers';
import { AMBER_NOTE } from '../flow/settings/formStyles';
import { listPathLabel } from './usePickLabel';
import type { PickInfo } from './useValueSlot';

const previewValue = previewValueJs as (v: unknown, max?: number) => string;

/** A suggestion under a path field: a list (or text) found upstream. */
export interface QuickPick {
    path: string;
    key?: string;
    sample?: unknown;
}

/**
 * Below a value slot that holds a PATH (the list a collection step works
 * through, the text a guard scans): what the old path field said, in words.
 *
 *   amber   the field wants a list and the value is not one in the sample,
 *           or it takes one value from every row (a column), which merges
 *           every row's values into one list
 *   picks   the lists found in earlier steps, one click each
 */
export default function PathSlotExtras({ info, value, expectArray, quickPicks, quickPicksLabel, sample, stepLabelById, onPick }: {
    info: PickInfo | null;
    value: string;
    expectArray: boolean;
    quickPicks?: QuickPick[] | null;
    quickPicksLabel?: string | null;
    sample: object | null | undefined;
    stepLabelById?: ReadonlyMap<string, string> | null;
    onPick: (path: string) => void;
}) {
    const { t } = useTranslation();
    let warning: string | null = null;
    if (expectArray && info && !info.stale) {
        if (value.includes('[*]')) {
            warning = t('routines.builder.path_column_merges', 'This path takes one value from every row and merges them into one list.');
        } else if (info.shape !== 'list' && info.shape !== 'table' && info.shape !== 'unknown' && info.shape !== 'missing') {
            warning = t('routines.builder.path_not_list', "This isn't a list in the sample data — pick a field that holds multiple items.");
        }
    }
    const trimmed = value.trim();
    return (
        <>
            {warning && <div className={AMBER_NOTE} data-testid="path-slot-warning">{warning}</div>}
            {Array.isArray(quickPicks) && quickPicks.length > 0 && (
                <div className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/40 divide-y divide-[var(--border-default)]">
                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-tertiary)]">
                        {quickPicksLabel || t('routines.builder.lists_detected', 'Lists found in previous steps')}
                    </div>
                    {quickPicks.map(q => {
                        const selected = trimmed === q.path;
                        const resolved = sample ? walkPath(q.path, sample) : undefined;
                        const preview = Array.isArray(resolved)
                            ? t('mapping.slot.n_items', '{count} items', { count: resolved.length })
                            : previewValue(resolved !== undefined ? resolved : q.sample, 24);
                        return (
                            <button
                                key={q.path}
                                type="button"
                                onClick={() => onPick(q.path)}
                                className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-secondary)] ${selected ? 'bg-[var(--bg-secondary)]' : ''}`}
                            >
                                <List size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                                <span className="text-[var(--text-primary)] truncate">{listPathLabel(t, q.path, stepLabelById)}</span>
                                <span className="ml-auto text-[10px] text-[var(--text-tertiary)] truncate max-w-[120px]">{preview}</span>
                                {selected && <Check size={12} className="shrink-0 text-[var(--text-primary)]" />}
                            </button>
                        );
                    })}
                </div>
            )}
        </>
    );
}
