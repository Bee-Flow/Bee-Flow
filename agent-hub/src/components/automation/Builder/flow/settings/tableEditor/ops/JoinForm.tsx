import { useTranslation } from '../../../../../../../hooks/useTranslation';
import { ColumnChips, ColumnSelect } from '../TableColumnSelect';
import TableSourceField from '../TableSourceField';
import type { JoinKey, JoinOp } from '../tableOpModel';
import { AddButton, Check, Choice, ListInput, Radios, Row, TextInput } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

const MAX_KEYS = 3;

function JoinKeys({ op, set, ctx }: { op: JoinOp; set: (patch: Partial<JoinOp>) => void; ctx: OpFormProps<JoinOp>['ctx'] }) {
    const { t } = useTranslation();
    const h = ctx.help.join;
    const setKey = (i: number, patch: Partial<JoinKey>) => set({ on: op.on.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
    return (
        <OpField ctx={ctx} name="on" exact label={t('automation_tables.join.on', 'Rows belong together when')} help={h.on}>
            <div className="flex flex-col gap-1.5">
                {op.on.map((k, i) => (
                    <Row key={i} onRemove={op.on.length > 1 ? () => set({ on: op.on.filter((_, j) => j !== i) }) : undefined} removeLabel={t('automation_tables.join.remove_key', 'Remove this pair of columns')}>
                        <OpField ctx={ctx} name={`on[${i}].left`} label={t('automation_tables.join.left', 'Column in this table')}>
                            {id => <ColumnSelect id={id} value={k.left} onChange={left => setKey(i, { left })} columns={ctx.columns} described={ctx.described} ariaLabel={t('automation_tables.join.left', 'Column in this table')} />}
                        </OpField>
                        <OpField ctx={ctx} name={`on[${i}].right`} label={t('automation_tables.join.right', 'Column in the second table')}>
                            {id => <ColumnSelect id={id} value={k.right} onChange={right => setKey(i, { right })} columns={ctx.otherColumns} ariaLabel={t('automation_tables.join.right', 'Column in the second table')} />}
                        </OpField>
                        <OpField ctx={ctx} name={`on[${i}].alternatives`} label={t('automation_tables.join.alternatives', 'Or one of these names')} help={h.alternatives}>
                            {id => <ListInput id={id} value={k.alternatives || []} onChange={alternatives => setKey(i, { alternatives: alternatives.length ? alternatives : undefined })} ariaLabel={t('automation_tables.join.alternatives', 'Or one of these names')} placeholder={t('automation_tables.join.alternatives_placeholder', 'Separate with commas')} />}
                        </OpField>
                    </Row>
                ))}
                {op.on.length < MAX_KEYS && <AddButton onClick={() => set({ on: [...op.on, { left: '', right: '' }] })}>{t('automation_tables.join.add_key', 'Add another pair')}</AddButton>}
            </div>
        </OpField>
    );
}

export default function JoinForm({ op, onChange, ctx }: OpFormProps<JoinOp>) {
    const { t } = useTranslation();
    const h = ctx.help.join;
    const set = (patch: Partial<JoinOp>) => onChange({ ...op, ...patch });
    return (
        <div className="flex flex-col gap-3">
            <OpField ctx={ctx} name="with" label={t('automation_tables.join.with', 'Second table')} help={h.with}>
                {id => (
                    <TableSourceField
                        id={id} value={op.with} onChange={b => set({ with: b })} onFocusField={ctx.onFocusField} previewSample={ctx.previewSample}
                        ariaLabel={t('automation_tables.join.with', 'Second table')} invalid={ctx.issues.some(i => i.rest === 'with')}
                    />
                )}
            </OpField>
            <OpField ctx={ctx} name="how" label={t('automation_tables.join.how', 'Rows without a match')} help={h.how}>
                <Radios
                    ariaLabel={t('automation_tables.join.how', 'Rows without a match')} value={op.how} onChange={how => set({ how })}
                    options={[
                        { value: 'left', label: t('automation_tables.join.how_left', 'Keep all rows') },
                        { value: 'inner', label: t('automation_tables.join.how_inner', 'Only matching rows') },
                    ]}
                />
            </OpField>
            <JoinKeys op={op} set={set} ctx={ctx} />
            <OpField ctx={ctx} name="columns" label={t('automation_tables.join.columns', 'Columns to bring along')} help={h.columns}>
                <Radios
                    ariaLabel={t('automation_tables.join.columns', 'Columns to bring along')} value={op.columns ? 'some' : 'all'}
                    onChange={mode => set({ columns: mode === 'all' ? null : [] })}
                    options={[
                        { value: 'all', label: t('automation_tables.join.columns_all', 'All columns') },
                        { value: 'some', label: t('automation_tables.join.columns_some', 'Choose columns') },
                    ]}
                />
                {op.columns && <ColumnChips value={op.columns} onChange={columns => set({ columns })} columns={ctx.otherColumns} ariaLabel={t('automation_tables.join.columns', 'Columns to bring along')} />}
            </OpField>
            <details className="text-xs">
                <summary className="cursor-pointer text-[var(--accent)]">{t('automation_tables.join.more', 'More options')}</summary>
                <div className="mt-2 flex flex-col gap-3">
                    <OpField ctx={ctx} name="caseInsensitive" help={h.caseInsensitive}>
                        <Check checked={op.caseInsensitive} onChange={caseInsensitive => set({ caseInsensitive })} label={t('automation_tables.join.case', 'Ignore capitals')} />
                    </OpField>
                    <OpField ctx={ctx} name="trim" help={h.trim}>
                        <Check checked={op.trim} onChange={trim => set({ trim })} label={t('automation_tables.join.trim', 'Ignore spaces around the value')} />
                    </OpField>
                    <OpField ctx={ctx} name="prefix" label={t('automation_tables.join.prefix', 'Start the new column names with')} help={h.prefix}>
                        {id => <TextInput id={id} value={op.prefix} onChange={prefix => set({ prefix })} ariaLabel={t('automation_tables.join.prefix', 'Start the new column names with')} />}
                    </OpField>
                    <OpField ctx={ctx} name="onDuplicate" label={t('automation_tables.join.duplicate', 'Several matches')} help={h.onDuplicate}>
                        {id => (
                            <Choice
                                id={id} ariaLabel={t('automation_tables.join.duplicate', 'Several matches')} value={op.onDuplicate} onChange={onDuplicate => set({ onDuplicate })}
                                options={[
                                    { value: 'first', label: t('automation_tables.join.duplicate_first', 'Use the first match') },
                                    { value: 'all', label: t('automation_tables.join.duplicate_all', 'Make a row for each match') },
                                ]}
                            />
                        )}
                    </OpField>
                </div>
            </details>
        </div>
    );
}
