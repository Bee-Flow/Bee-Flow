import { useTranslation } from '../../../../../../../hooks/useTranslation';
import { ColumnChips, ColumnSelect } from '../TableColumnSelect';
import type { SelectOp } from '../tableOpModel';
import { AddButton, Radios, Row, TextInput } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

type Mode = 'all' | 'keep' | 'drop';

export default function SelectForm({ op, onChange, ctx }: OpFormProps<SelectOp>) {
    const { t } = useTranslation();
    const h = ctx.help.select;
    const set = (patch: Partial<SelectOp>) => onChange({ ...op, ...patch });
    const mode: Mode = op.keep ? 'keep' : op.drop ? 'drop' : 'all';
    const setMode = (next: Mode) => set({ keep: next === 'keep' ? [] : null, drop: next === 'drop' ? [] : null });
    return (
        <div className="flex flex-col gap-3">
            <OpField ctx={ctx} name="keep" label={t('automation_tables.select.mode', 'Which columns')}>
                <Radios
                    ariaLabel={t('automation_tables.select.mode', 'Which columns')} value={mode} onChange={setMode}
                    options={[
                        { value: 'all', label: t('automation_tables.select.all', 'All columns') },
                        { value: 'keep', label: t('automation_tables.select.keep', 'Only the columns I choose') },
                        { value: 'drop', label: t('automation_tables.select.drop', 'All except the columns I choose') },
                    ]}
                />
                {mode === 'keep' && <ColumnChips value={op.keep || []} onChange={keep => set({ keep })} columns={ctx.columns} described={ctx.described} ariaLabel={t('automation_tables.select.keep_list', 'Columns to keep')} />}
                {mode === 'keep' && <p className="text-[11px] text-[var(--text-secondary)]">{h.keep}</p>}
                {mode === 'drop' && <ColumnChips value={op.drop || []} onChange={drop => set({ drop })} columns={ctx.columns} described={ctx.described} prefer="personal" ariaLabel={t('automation_tables.select.drop_list', 'Columns to remove')} />}
                {mode === 'drop' && <p className="text-[11px] text-[var(--text-secondary)]">{h.drop}</p>}
            </OpField>
            <OpField ctx={ctx} name="rename" exact label={t('automation_tables.select.rename', 'Rename columns')} help={h.rename}>
                <div className="flex flex-col gap-1.5">
                    {op.rename.map((r, i) => (
                        <Row key={i} onRemove={() => set({ rename: op.rename.filter((_, j) => j !== i) })} removeLabel={t('automation_tables.select.remove_rename', 'Remove this new name')}>
                            <OpField ctx={ctx} name={`rename[${i}].from`} label={t('automation_tables.select.from', 'Column')}>
                                {id => <ColumnSelect id={id} value={r.from} onChange={from => set({ rename: op.rename.map((x, j) => (j === i ? { ...x, from } : x)) })} columns={ctx.columns} described={ctx.described} ariaLabel={t('automation_tables.select.from', 'Column')} />}
                            </OpField>
                            <OpField ctx={ctx} name={`rename[${i}].to`} label={t('automation_tables.select.to', 'New name')}>
                                {id => <TextInput id={id} value={r.to} onChange={to => set({ rename: op.rename.map((x, j) => (j === i ? { ...x, to } : x)) })} ariaLabel={t('automation_tables.select.to', 'New name')} />}
                            </OpField>
                        </Row>
                    ))}
                    <AddButton onClick={() => set({ rename: [...op.rename, { from: '', to: '' }] })}>{t('automation_tables.select.add_rename', 'Rename a column')}</AddButton>
                </div>
            </OpField>
        </div>
    );
}
