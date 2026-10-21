import { useTranslation } from '../../../../../../../hooks/useTranslation';
import { ColumnSelect } from '../TableColumnSelect';
import type { PivotOp } from '../tableOpModel';
import { Check, Choice, NumberInput, TextInput } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

export default function PivotForm({ op, onChange, ctx }: OpFormProps<PivotOp>) {
    const { t } = useTranslation();
    const h = ctx.help.pivot;
    const set = (patch: Partial<PivotOp>) => onChange({ ...op, ...patch });
    const needsColumn = op.value.fn !== 'count';
    return (
        <div className="flex flex-col gap-3">
            <OpField ctx={ctx} name="rows" label={t('automation_tables.pivot.rows', 'Down the side')} help={h.rows}>
                {id => <ColumnSelect id={id} value={op.rows} onChange={rows => set({ rows })} columns={ctx.columns} described={ctx.described} prefer="split" ariaLabel={t('automation_tables.pivot.rows', 'Down the side')} />}
            </OpField>
            <OpField ctx={ctx} name="columns" label={t('automation_tables.pivot.columns', 'Across the top')} help={h.columns}>
                {id => <ColumnSelect id={id} value={op.columns} onChange={columns => set({ columns })} columns={ctx.columns} described={ctx.described} prefer="split" ariaLabel={t('automation_tables.pivot.columns', 'Across the top')} />}
            </OpField>
            <OpField ctx={ctx} name="value" label={t('automation_tables.pivot.value', 'In each cell')} help={h.value}>
                <div className="flex flex-col gap-1.5">
                    <Choice
                        ariaLabel={t('automation_tables.pivot.value', 'In each cell')} value={op.value.fn}
                        onChange={fn => set({ value: fn === 'count' ? { fn } : { fn, column: op.value.column } })}
                        options={[
                            { value: 'count', label: t('automation_tables.pivot.fn_count', 'The number of rows') },
                            { value: 'sum', label: t('automation_tables.pivot.fn_sum', 'The total of a column') },
                            { value: 'mean', label: t('automation_tables.pivot.fn_mean', 'The average of a column') },
                        ]}
                    />
                    {needsColumn && (
                        <OpField ctx={ctx} name="value.column">
                            {id => <ColumnSelect id={id} value={op.value.column || ''} onChange={column => set({ value: { ...op.value, column } })} columns={ctx.columns} described={ctx.described} prefer="numeric" ariaLabel={t('automation_tables.pivot.value_column', 'Column to add up')} />}
                        </OpField>
                    )}
                </div>
            </OpField>
            <OpField ctx={ctx} name="weight" label={t('automation_tables.pivot.weight', 'Weight')} help={h.weight}>
                {id => <ColumnSelect id={id} value={op.weight || ''} onChange={weight => set({ weight: weight || null })} columns={ctx.columns} described={ctx.described} prefer="numeric" ariaLabel={t('automation_tables.pivot.weight', 'Weight')} emptyLabel={t('automation_tables.pivot.no_weight', 'No weight: every row counts once')} />}
            </OpField>
            <OpField ctx={ctx} name="percent" label={t('automation_tables.pivot.percent', 'Show as')} help={h.percent}>
                {id => (
                    <Choice
                        id={id} ariaLabel={t('automation_tables.pivot.percent', 'Show as')} value={op.percent} onChange={percent => set({ percent })}
                        options={[
                            { value: 'none', label: t('automation_tables.pivot.percent_none', 'The numbers themselves') },
                            { value: 'row', label: t('automation_tables.pivot.percent_row', 'Percent of the row') },
                            { value: 'column', label: t('automation_tables.pivot.percent_column', 'Percent of the column') },
                            { value: 'total', label: t('automation_tables.pivot.percent_total', 'Percent of everything') },
                        ]}
                    />
                )}
            </OpField>
            <OpField ctx={ctx} name="totals" help={h.totals}>
                <Check checked={op.totals} onChange={totals => set({ totals })} label={t('automation_tables.pivot.totals', 'Add totals')} />
            </OpField>
            <OpField ctx={ctx} name="minN" label={t('automation_tables.pivot.min', 'Smallest cell to show')} help={h.minN}>
                {id => <NumberInput id={id} value={op.minN} min={0} onChange={n => set({ minN: n ?? 0 })} ariaLabel={t('automation_tables.pivot.min', 'Smallest cell to show')} />}
            </OpField>
            <OpField ctx={ctx} name="decimals" label={t('automation_tables.pivot.decimals', 'Decimals')} help={h.decimals}>
                {id => <NumberInput id={id} value={op.decimals} min={0} max={6} onChange={n => set({ decimals: n ?? 1 })} ariaLabel={t('automation_tables.pivot.decimals', 'Decimals')} />}
            </OpField>
            <OpField ctx={ctx} name="missingLabel" label={t('automation_tables.pivot.missing', 'Name for rows without a value')} help={h.missingLabel}>
                {id => <TextInput id={id} value={op.missingLabel} onChange={missingLabel => set({ missingLabel })} ariaLabel={t('automation_tables.pivot.missing', 'Name for rows without a value')} />}
            </OpField>
        </div>
    );
}
