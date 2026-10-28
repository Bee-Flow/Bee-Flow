import { useMemo, type ComponentType, type ReactNode } from 'react';
import type { TableColumn } from '@/api/queries/automation/runTables';
import { useTranslation } from '@/hooks/useTranslation';
import ValueBuilderJs from '@/components/automation/Builder/mapping/ValueBuilder';
import { sampleToFields } from '@/components/automation/Builder/mapping/upstream/sampleFields';
import { useVariablePickerContext, VariablePickerProvider } from '@/components/automation/Builder/mapping/VariablePickerContext';
import type { DeriveOp } from '../tableOpModel';
import { AddButton, Row, TextInput } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

// Untyped JS component; its props are checked there.
const ValueBuilder = ValueBuilderJs as unknown as ComponentType<Record<string, unknown>>;

const MAX_COLUMNS = 20;

const PLACEHOLDER: Record<TableColumn['type'], unknown> = {
    text: 'text', number: 0, boolean: true, date: '2026-01-31', datetime: '2026-01-31T09:00:00Z', mixed: 'value', empty: null,
};

/**
 * The value picker of one new column offers the columns of the row as
 * `row.<column>` besides the data of the earlier steps, so the value is built
 * by pointing at things, on the same expression language the rest of the
 * automation uses.
 */
function RowScope({ columns, sampleRow, children }: { columns: TableColumn[]; sampleRow: Record<string, unknown> | null; children: ReactNode }) {
    const { t } = useTranslation();
    const outer = useVariablePickerContext();
    const label = t('automation_tables.derive.row', 'This row');
    const group = useMemo(() => {
        const sample = Object.fromEntries(columns.map(c => [c.key, sampleRow?.[c.key] ?? PLACEHOLDER[c.type] ?? 'value']));
        return { id: 'row', label, kind: 'row', basePath: 'row', sample, fields: sampleToFields(sample, 'row'), hasRealData: !!sampleRow };
    }, [columns, sampleRow, label]);
    const labels = useMemo(() => new Map(outer.stepLabelById).set('row', label), [outer.stepLabelById, label]);
    const groups = useMemo(() => [group, ...outer.groups], [group, outer.groups]);
    const sample = useMemo(() => ({ ...(outer.previewSample as object | null), row: group.sample }), [outer.previewSample, group]);
    return (
        <VariablePickerProvider groups={groups as never} previewSample={sample} stepLabelById={labels} stepTypeById={outer.stepTypeById} definition={outer.definition}>
            {children}
        </VariablePickerProvider>
    );
}

export default function DeriveForm({ op, onChange, ctx }: OpFormProps<DeriveOp>) {
    const { t } = useTranslation();
    const h = ctx.help.derive;
    const set = (columns: DeriveOp['columns']) => onChange({ ...op, columns });
    const edit = (i: number, patch: Partial<DeriveOp['columns'][number]>) => set(op.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    return (
        <RowScope columns={ctx.columns || []} sampleRow={ctx.sampleRow}>
            <div className="flex flex-col gap-2">
                {op.columns.map((c, i) => (
                    <Row key={i} onRemove={op.columns.length > 1 ? () => set(op.columns.filter((_, j) => j !== i)) : undefined} removeLabel={t('automation_tables.derive.remove', 'Remove this column')}>
                        <OpField ctx={ctx} name={`columns[${i}].name`} label={t('automation_tables.derive.name', 'Name of the new column')} help={i === 0 ? h.name : undefined}>
                            {id => <TextInput id={id} value={c.name} onChange={name => edit(i, { name })} ariaLabel={t('automation_tables.derive.name', 'Name of the new column')} />}
                        </OpField>
                        <OpField ctx={ctx} name={`columns[${i}].value`} help={i === 0 ? h.value : undefined}>
                            <ValueBuilder
                                value={c.value ?? undefined}
                                onChange={(value: DeriveOp['columns'][number]['value']) => edit(i, { value })}
                                label={t('automation_tables.derive.value', 'Value')}
                                showChrome
                                placeholder={t('automation_tables.derive.value_placeholder', 'Pick a column, type text, or use a formula')}
                                onFocusField={ctx.onFocusField}
                            />
                        </OpField>
                    </Row>
                ))}
                {op.columns.length < MAX_COLUMNS && <AddButton onClick={() => set([...op.columns, { name: '', value: null }])}>{t('automation_tables.derive.add', 'Add another column')}</AddButton>}
            </div>
        </RowScope>
    );
}
