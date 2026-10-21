import { useTranslation } from '../../../../../../../hooks/useTranslation';
import { ColumnChips, ColumnSelect } from '../TableColumnSelect';
import { planOpColumns, type Aggregate, type GroupOp } from '../tableOpModel';
import { AGG_FNS } from '../tableOpModel';
import { AddButton, Choice, NumberInput, Row, TextInput } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

const MAX_AGGREGATES = 20;
/** Counting rows needs no column. */
const NEEDS_COLUMN = (fn: string) => fn !== 'count' && fn !== 'share';

export default function GroupForm({ op, onChange, ctx }: OpFormProps<GroupOp>) {
    const { t } = useTranslation();
    const h = ctx.help.group;
    const set = (patch: Partial<GroupOp>) => onChange({ ...op, ...patch });
    const edit = (i: number, patch: Partial<Aggregate>) => set({ aggregates: op.aggregates.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
    const result = ctx.columns ? planOpColumns(ctx.columns, op) : null;
    return (
        <div className="flex flex-col gap-3">
            <OpField ctx={ctx} name="by" label={t('automation_tables.group.by', 'Group by')} help={h.by}>
                <ColumnChips value={op.by} onChange={by => set({ by })} columns={ctx.columns} described={ctx.described} prefer="split" max={5} ariaLabel={t('automation_tables.group.by', 'Group by')} />
            </OpField>
            <OpField ctx={ctx} name="aggregates" exact label={t('automation_tables.group.aggregates', 'Work out')} help={h.aggregates}>
                <div className="flex flex-col gap-1.5">
                    {op.aggregates.map((a, i) => (
                        <Row key={i} onRemove={op.aggregates.length > 1 ? () => set({ aggregates: op.aggregates.filter((_, j) => j !== i) }) : undefined} removeLabel={t('automation_tables.group.remove_aggregate', 'Remove this line')}>
                            <OpField ctx={ctx} name={`aggregates[${i}].fn`} label={t('automation_tables.group.fn', 'What to work out')}>
                                {id => (
                                    <Choice
                                        id={id} ariaLabel={t('automation_tables.group.fn', 'What to work out')} value={a.fn}
                                        onChange={fn => edit(i, { fn, ...(NEEDS_COLUMN(fn) ? {} : { column: undefined }) })}
                                        options={AGG_FNS.map(fn => ({ value: fn, label: ctx.help.aggs[fn] }))}
                                    />
                                )}
                            </OpField>
                            {NEEDS_COLUMN(a.fn) && (
                                <OpField ctx={ctx} name={`aggregates[${i}].column`} label={t('automation_tables.group.column', 'Of the column')}>
                                    {id => <ColumnSelect id={id} value={a.column || ''} onChange={column => edit(i, { column })} columns={ctx.columns} described={ctx.described} prefer={a.fn === 'count_distinct' || a.fn === 'min' || a.fn === 'max' ? 'any' : 'numeric'} ariaLabel={t('automation_tables.group.column', 'Of the column')} />}
                                </OpField>
                            )}
                            <OpField ctx={ctx} name={`aggregates[${i}].as`} label={t('automation_tables.group.as', 'Name of the result column')}>
                                {id => <TextInput id={id} value={a.as} onChange={as => edit(i, { as })} ariaLabel={t('automation_tables.group.as', 'Name of the result column')} />}
                            </OpField>
                        </Row>
                    ))}
                    {op.aggregates.length < MAX_AGGREGATES && <AddButton onClick={() => set({ aggregates: [...op.aggregates, { fn: 'count', as: '' }] })}>{t('automation_tables.group.add_aggregate', 'Add another line')}</AddButton>}
                </div>
            </OpField>
            <OpField ctx={ctx} name="weight" label={t('automation_tables.group.weight', 'Weight')} help={h.weight}>
                {id => <ColumnSelect id={id} value={op.weight || ''} onChange={weight => set({ weight: weight || null })} columns={ctx.columns} described={ctx.described} prefer="numeric" ariaLabel={t('automation_tables.group.weight', 'Weight')} emptyLabel={t('automation_tables.group.no_weight', 'No weight: every row counts once')} />}
            </OpField>
            <OpField ctx={ctx} name="minN" label={t('automation_tables.group.min', 'Smallest group to show')} help={h.minN}>
                {id => <NumberInput id={id} value={op.minN} min={0} onChange={n => set({ minN: n ?? 0 })} ariaLabel={t('automation_tables.group.min', 'Smallest group to show')} />}
            </OpField>
            <OpField ctx={ctx} name="sort" exact label={t('automation_tables.group.sort', 'Order the result by')} help={h.sort}>
                <div className="flex flex-col gap-1.5">
                    {op.sort.map((s, i) => (
                        <Row key={i} onRemove={() => set({ sort: op.sort.filter((_, j) => j !== i) })} removeLabel={t('automation_tables.group.remove_sort', 'Remove this order')}>
                            <OpField ctx={ctx} name={`sort[${i}].column`}>
                                {id => <ColumnSelect id={id} value={s.column} onChange={column => set({ sort: op.sort.map((x, j) => (j === i ? { ...x, column } : x)) })} columns={result} ariaLabel={t('automation_tables.group.sort_column', 'Column to order by')} />}
                            </OpField>
                            <Choice
                                ariaLabel={t('automation_tables.group.sort_dir', 'Direction')} value={s.dir}
                                onChange={dir => set({ sort: op.sort.map((x, j) => (j === i ? { ...x, dir } : x)) })}
                                options={[{ value: 'asc', label: t('automation_tables.group.asc', 'Lowest first') }, { value: 'desc', label: t('automation_tables.group.desc', 'Highest first') }]}
                            />
                        </Row>
                    ))}
                    {op.sort.length < 3 && <AddButton onClick={() => set({ sort: [...op.sort, { column: '', dir: 'desc' }] })}>{t('automation_tables.group.add_sort', 'Add an order')}</AddButton>}
                </div>
            </OpField>
        </div>
    );
}
