import { useTranslation } from '@/hooks/useTranslation';
import { ColumnChips } from '../TableColumnSelect';
import type { DescribeOp } from '../tableOpModel';
import { NumberInput, Radios } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

export default function DescribeForm({ op, onChange, ctx }: OpFormProps<DescribeOp>) {
    const { t } = useTranslation();
    const h = ctx.help.describe;
    const set = (patch: Partial<DescribeOp>) => onChange({ ...op, ...patch });
    return (
        <div className="flex flex-col gap-3">
            <OpField ctx={ctx} name="columns" label={t('automation_tables.describe.columns', 'Which columns')} help={h.columns}>
                <Radios
                    ariaLabel={t('automation_tables.describe.columns', 'Which columns')} value={op.columns ? 'some' : 'all'} onChange={mode => set({ columns: mode === 'all' ? null : [] })}
                    options={[
                        { value: 'all', label: t('automation_tables.describe.all', 'All columns') },
                        { value: 'some', label: t('automation_tables.describe.some', 'Choose columns') },
                    ]}
                />
                {op.columns && <ColumnChips value={op.columns} onChange={columns => set({ columns })} columns={ctx.columns} described={ctx.described} ariaLabel={t('automation_tables.describe.columns', 'Which columns')} />}
            </OpField>
            <OpField ctx={ctx} name="maxOptions" label={t('automation_tables.describe.max', 'Most different values to list')} help={h.maxOptions}>
                {id => <NumberInput id={id} value={op.maxOptions} min={2} max={200} onChange={n => set({ maxOptions: n ?? 50 })} ariaLabel={t('automation_tables.describe.max', 'Most different values to list')} />}
            </OpField>
        </div>
    );
}
