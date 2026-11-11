import type { TranslateFn } from '@/hooks/useTranslation';
import type { TableColumn } from '../inspector/aiFieldMatching';
import { groupedType, parseBinWidth, relatedFieldsOf } from './aggregateExtras';
import { DATE_BUCKETS, DATE_TYPES } from './aggregateVocabulary';
import type { AppTable } from './useAppTables';
import type { DatasetGroup } from './useDatasets';

interface GroupByExtrasProps {
    t: TranslateFn;
    group: DatasetGroup;
    update: (next: DatasetGroup) => void;
    fields: TableColumn[];
    tables: AppTable[];
    inputClass: string;
    disabled?: boolean;
}

/**
 * The parts of one breakdown that go beyond "this column": for a relation
 * field, which field of the linked record to group on (and its date grouping);
 * for a number, the step to group in. Renders nothing for any other column, so
 * a breakdown that needs neither looks and saves exactly as before.
 */
export default function GroupByExtras({ t, group, update, fields, tables, inputClass, disabled = false }: GroupByExtrasProps) {
    const related = relatedFieldsOf(tables, fields, group.field);
    const type = groupedType(tables, fields, group);
    const viaRelation = !!group.relatedField;
    return (
        <>
            {related ? (
                <>
                    <select
                        className={inputClass}
                        value={group.relatedField || ''}
                        disabled={disabled}
                        onChange={(e) => update({ field: group.field, ...(group.as ? { as: group.as } : {}), ...(e.target.value ? { relatedField: e.target.value } : {}) })}
                        aria-label={t('studio_apps_aggregates.related_field', 'Which field of the linked record')}
                    >
                        <option value="">{t('studio_apps_aggregates.related_itself', 'The linked record itself')}</option>
                        {related.map((f) => <option key={f.key} value={f.key}>{f.name || f.key}</option>)}
                    </select>
                    {viaRelation ? <p className="text-[11px] text-[var(--text-muted)]">{t('studio_apps_aggregates.related_hint', 'Records you may not see are grouped under an empty value.')}</p> : null}
                </>
            ) : null}
            {viaRelation && DATE_TYPES.has(type) ? (
                <select className={inputClass} value={group.bucket || ''} disabled={disabled} onChange={(e) => update({ ...group, bucket: e.target.value || undefined })} aria-label={t('studio_apps_bi.query.group_dates', 'Group dates')}>
                    {DATE_BUCKETS.map((b) => <option key={b.value} value={b.value}>{t(b.labelKey, b.label)}</option>)}
                </select>
            ) : null}
            {type === 'number' ? (
                <label className="flex flex-col gap-1">
                    <span className="text-xs text-[var(--text-secondary)]">{t('studio_apps_aggregates.bin_width', 'Group in steps of')}</span>
                    <input
                        type="number"
                        min={1}
                        step={1}
                        className={inputClass}
                        value={group.binWidth ?? ''}
                        disabled={disabled}
                        placeholder={t('studio_apps_aggregates.bin_placeholder', 'Exact values')}
                        onChange={(e) => {
                            const { binWidth: _old, ...rest } = group;
                            const width = parseBinWidth(e.target.value);
                            update(width === undefined ? rest : { ...rest, binWidth: width });
                        }}
                        title={t('studio_apps_aggregates.bin_hint', 'Groups the numbers in steps, e.g. 0–9, 10–19 for a step of 10.')}
                    />
                </label>
            ) : null}
        </>
    );
}
