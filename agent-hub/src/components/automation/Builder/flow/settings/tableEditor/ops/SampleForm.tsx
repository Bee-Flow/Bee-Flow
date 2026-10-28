import { useTranslation } from '@/hooks/useTranslation';
import type { SampleOp } from '../tableOpModel';
import { NumberInput, Radios, TextInput } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

const DEFAULT_ROWS = 100;
const DEFAULT_PERCENT = 10;

export default function SampleForm({ op, onChange, ctx }: OpFormProps<SampleOp>) {
    const { t } = useTranslation();
    const h = ctx.help.sample;
    const set = (patch: Partial<SampleOp>) => onChange({ ...op, ...patch });
    const by = op.percent !== null && op.n === null ? 'percent' : 'n';
    return (
        <div className="flex flex-col gap-3">
            <OpField ctx={ctx} name="mode" label={t('automation_tables.sample.mode', 'Which rows')} help={h.mode}>
                <Radios
                    ariaLabel={t('automation_tables.sample.mode', 'Which rows')} value={op.mode} onChange={mode => set({ mode })}
                    options={[
                        { value: 'first', label: t('automation_tables.sample.first', 'The first rows') },
                        { value: 'random', label: t('automation_tables.sample.random', 'A random selection') },
                    ]}
                />
            </OpField>
            <OpField ctx={ctx} name="n" help={h.size}>
                <Radios
                    ariaLabel={t('automation_tables.sample.size', 'How many')} value={by}
                    onChange={next => set(next === 'n' ? { n: DEFAULT_ROWS, percent: null } : { n: null, percent: DEFAULT_PERCENT })}
                    options={[
                        { value: 'n', label: t('automation_tables.sample.by_rows', 'A number of rows') },
                        { value: 'percent', label: t('automation_tables.sample.by_percent', 'A percentage of the rows') },
                    ]}
                />
                {by === 'n'
                    ? <NumberInput value={op.n} min={1} onChange={n => set({ n, percent: null })} ariaLabel={t('automation_tables.sample.rows', 'Number of rows')} />
                    : <NumberInput value={op.percent} min={0} max={100} step={1} onChange={percent => set({ percent, n: null })} ariaLabel={t('automation_tables.sample.percent', 'Percentage of the rows')} />}
            </OpField>
            {op.mode === 'random' && (
                <OpField ctx={ctx} name="seed" label={t('automation_tables.sample.seed', 'Seed')} help={h.seed}>
                    {id => <TextInput id={id} value={op.seed} onChange={seed => set({ seed })} ariaLabel={t('automation_tables.sample.seed', 'Seed')} />}
                </OpField>
            )}
        </div>
    );
}
