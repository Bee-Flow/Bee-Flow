import { useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { listPathLabel } from '@/components/automation/Builder/mapping/listPathLabel';
import PathField from '@/components/automation/Builder/mapping/PathField';
import { collectArrayPaths } from '@/components/automation/Builder/mapping/upstream';
import { useVariablePickerContext } from '@/components/automation/Builder/mapping/VariablePickerContext';
import { FormRow, inputClass } from '../formPrimitives';
import type { SourceSummaryRowProps, CollectionArrayRefFieldProps } from '../collectionEditors.types';
import { describeSourceList } from './collectionEditors.helpers';

export function SourceSummaryRow({ hint, warning = null, source, maxItems, onPatch, groups, onFocusField, previewSample }: SourceSummaryRowProps) {
    const pickerCtx = useVariablePickerContext();
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const summary = useMemo(
        () => describeSourceList(source, pickerCtx.groups, previewSample, t),
        [source, pickerCtx.groups, previewSample, t],
    );
    // R10: never a raw path — an unreadable list shows its name and why it has no fields yet.
    const unread = !summary && source ? listPathLabel(source, pickerCtx.stepLabelById, t, { stepTypeById: pickerCtx.stepTypeById }) : null;
    return (
        <FormRow label={t('automations.collection_editors.working_through', 'Working through')} hint={hint}>
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                {summary ? (
                    <span className="truncate">
                        <span className="text-[var(--text-primary)]">{summary.stepLabel}</span>
                        {summary.fieldLabel && <span className="text-[var(--text-tertiary)]"> · </span>}
                        {summary.fieldLabel && <span className="text-[var(--text-primary)]">{summary.fieldLabel}</span>}
                        {summary.count != null && (
                            <span className="text-[var(--text-tertiary)]"> — {summary.count} {t('automations.collection_editors.item', 'item')}{summary.count === 1 ? '' : 's'}</span>
                        )}
                    </span>
                ) : unread ? (
                    <span className="truncate" title={source}>
                        <span className="text-[var(--text-primary)]">{unread}</span>
                        <span className="text-[var(--text-tertiary)]"> · {t('condition_node.source.no_sample', 'no sample yet: run the step above to see its fields')}</span>
                    </span>
                ) : (
                    <span className="text-amber-600 dark:text-amber-400 truncate">{t('automations.collection_editors.no_list_picked_yet', 'No list picked yet')}</span>
                )}
                <button
                    type="button"
                    onClick={() => setOpen(o => !o)}
                    aria-label={open ? 'Done changing the source list' : 'Change the source list'}
                    className="ml-auto shrink-0 text-[10px] text-[var(--accent)] hover:underline"
                >
                    {open ? 'done' : 'change'}
                </button>
            </div>
            {/* Said in the open, not behind the hint icon: this is the reason
                the step produced nothing, next to the control that fixes it. */}
            {warning && (
                <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{warning}</div>
            )}
            {open && (
                <div className="mt-2">
                    <CollectionArrayRefField
                        draft={{ arrayRef: source || '', maxItems }}
                        set={(k, v) => onPatch(k === 'arrayRef' ? { source: v } : { maxItems: v })}
                        groups={groups}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                </div>
            )}
        </FormRow>
    );
}

export function CollectionArrayRefField({ draft, set, groups, onFocusField, previewSample }: CollectionArrayRefFieldProps) {
    const { t } = useTranslation();
    // Array-only picker over the SHARED PathField control: friendly quick-picks
    // (nested + real-run arrays via collectArrayPaths), {} variable picker,
    // drag-to-map, name chips, and a soft "isn't a list" warning.
    const quickPicks = useMemo(() => collectArrayPaths(groups, previewSample), [groups, previewSample]);
    return (
        <>
            <FormRow label={t('automations.collection_editors.source_list', 'Source list')} required hint={t('automations.collection_editors.pick_a_list_from_a_previous', 'Pick a list from a previous step — or type a path manually.')}>
                <PathField
                    value={draft.arrayRef || ''}
                    onChange={(v: string|number) => set('arrayRef', v)}
                    expectArray
                    quickPicks={quickPicks}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder={t('automations.collection_editors.no_list_picked_yet', 'No list picked yet')}
                />
            </FormRow>
            {/* Optional input cap (C19): read by the runner and validated by
                the server, but previously editable only via the raw JSON
                view — the router even pointed limit's maxItems errors at a
                control that didn't exist. Blank = platform default. */}
            <FormRow label={t('automations.collection_editors.max_input_items', 'Max input items')} hint={t('automations.collection_editors.optional_cap_on_input_size_the', 'Optional cap on input size — the run FAILS if the source list is larger (platform cap 10 000). Leave blank for the default.')}>
                <input
                    type="number" min={1} max={10000}
                    value={draft.maxItems === '' || draft.maxItems == null ? '' : draft.maxItems}
                    onChange={(e) => set('maxItems', e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="10000"
                    className={inputClass()}
                />
            </FormRow>
        </>
    );
}
