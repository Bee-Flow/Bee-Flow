import { useTranslation } from '../../../../../../../hooks/useTranslation';
import { ColumnSelect } from '../TableColumnSelect';
import { GROUPS_MIN_N, type GroupsOp, type Split } from '../tableOpModel';
import { AddButton, Check, ListInput, NumberInput, Row, TextInput } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

const MAX_SPLITS = 10;

export default function GroupsForm({ op, onChange, ctx }: OpFormProps<GroupsOp>) {
    const { t } = useTranslation();
    const h = ctx.help.groups;
    const set = (patch: Partial<GroupsOp>) => onChange({ ...op, ...patch });
    const edit = (i: number, patch: Partial<Split>) => set({ splits: op.splits.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
    return (
        <div className="flex flex-col gap-3">
            <OpField ctx={ctx} name="splits" exact label={t('automation_tables.groups.splits', 'Split by')} help={h.splits}>
                <div className="flex flex-col gap-1.5">
                    {op.splits.map((s, i) => (
                        <Row key={i} onRemove={op.splits.length > 1 ? () => set({ splits: op.splits.filter((_, j) => j !== i) }) : undefined} removeLabel={t('automation_tables.groups.remove_split', 'Remove this split')}>
                            <OpField ctx={ctx} name={`splits[${i}].column`} label={t('automation_tables.groups.column', 'Column')}>
                                {id => <ColumnSelect id={id} value={s.column} onChange={column => edit(i, { column })} columns={ctx.columns} described={ctx.described} prefer="split" ariaLabel={t('automation_tables.groups.column', 'Column')} />}
                            </OpField>
                            <OpField ctx={ctx} name={`splits[${i}].values`} label={t('automation_tables.groups.values', 'Only these values')} help={i === 0 ? h.values : undefined}>
                                {id => <ListInput id={id} value={s.values || []} onChange={values => edit(i, { values: values.length ? values : null })} ariaLabel={t('automation_tables.groups.values', 'Only these values')} placeholder={t('automation_tables.groups.values_placeholder', 'All values')} />}
                            </OpField>
                            <OpField ctx={ctx} name={`splits[${i}].separator`} label={t('automation_tables.groups.separator', 'A cell holds several values, separated by')} help={i === 0 ? h.separator : undefined}>
                                {id => <TextInput id={id} value={s.separator ?? ''} onChange={separator => edit(i, { separator: separator || null })} ariaLabel={t('automation_tables.groups.separator', 'A cell holds several values, separated by')} placeholder={t('automation_tables.groups.separator_placeholder', 'One value per cell')} />}
                            </OpField>
                            <OpField ctx={ctx} name={`splits[${i}].label`} label={t('automation_tables.groups.label', 'Name of this split')}>
                                {id => <TextInput id={id} value={s.label ?? ''} onChange={label => edit(i, { label: label || null })} ariaLabel={t('automation_tables.groups.label', 'Name of this split')} />}
                            </OpField>
                        </Row>
                    ))}
                    {op.splits.length < MAX_SPLITS && <AddButton onClick={() => set({ splits: [...op.splits, { column: '', values: null, separator: null, label: null }] })}>{t('automation_tables.groups.add_split', 'Add another split')}</AddButton>}
                </div>
            </OpField>
            <OpField ctx={ctx} name="includeTotal" help={h.includeTotal}>
                <Check checked={op.includeTotal} onChange={includeTotal => set({ includeTotal })} label={t('automation_tables.groups.total', 'Add a segment with everyone')} />
            </OpField>
            {op.includeTotal && (
                <OpField ctx={ctx} name="totalLabel" label={t('automation_tables.groups.total_label', 'Name of that segment')}>
                    {id => <TextInput id={id} value={op.totalLabel} onChange={totalLabel => set({ totalLabel })} ariaLabel={t('automation_tables.groups.total_label', 'Name of that segment')} />}
                </OpField>
            )}
            <OpField ctx={ctx} name="minN" label={t('automation_tables.groups.min', 'Smallest group to show')} help={h.minN}>
                {id => (
                    <>
                        <NumberInput id={id} value={op.minN} min={0} onChange={n => set({ minN: n ?? GROUPS_MIN_N })} ariaLabel={t('automation_tables.groups.min', 'Smallest group to show')} />
                        {op.minN < GROUPS_MIN_N && (
                            <p className="text-[11px] text-amber-600 dark:text-amber-400">
                                {t('automation_tables.groups.min_low', 'Groups of fewer than {n} people are easier to trace back to a person.', { n: GROUPS_MIN_N })}
                            </p>
                        )}
                    </>
                )}
            </OpField>
        </div>
    );
}
