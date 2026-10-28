import { useTranslation } from '@/hooks/useTranslation';
import { ColumnChips } from '../TableColumnSelect';
import type { PseudonymiseOp } from '../tableOpModel';
import { Check, NumberInput, TextInput } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

export default function PseudonymiseForm({ op, onChange, ctx }: OpFormProps<PseudonymiseOp>) {
    const { t } = useTranslation();
    const h = ctx.help.pseudonymise;
    const set = (patch: Partial<PseudonymiseOp>) => onChange({ ...op, ...patch });
    const personal = ctx.columns?.filter(c => ctx.described.get(c.key)?.looksPersonal && !op.columns.includes(c.key)) || [];
    return (
        <div className="flex flex-col gap-3">
            <OpField ctx={ctx} name="columns" label={t('automation_tables.pseudonymise.columns', 'Columns that identify a person')} help={h.columns}>
                <ColumnChips value={op.columns} onChange={columns => set({ columns })} columns={ctx.columns} described={ctx.described} prefer="personal" max={10} ariaLabel={t('automation_tables.pseudonymise.columns', 'Columns that identify a person')} />
                {personal.length > 0 && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">
                        {t('automation_tables.pseudonymise.suggest', 'These columns look like personal data: {names}.', { names: personal.map(c => c.key).join(', ') })}
                        {' '}
                        <button type="button" className="text-[var(--accent)] hover:underline" onClick={() => set({ columns: [...op.columns, ...personal.map(c => c.key)].slice(0, 10) })}>
                            {t('automation_tables.pseudonymise.use_suggested', 'Use them')}
                        </button>
                    </p>
                )}
            </OpField>
            <OpField ctx={ctx} name="saltVar" label={t('automation_tables.pseudonymise.salt', 'Variable with the secret phrase')} help={h.saltVar}>
                {id => <TextInput id={id} value={op.saltVar} onChange={saltVar => set({ saltVar })} ariaLabel={t('automation_tables.pseudonymise.salt', 'Variable with the secret phrase')} placeholder={t('automation_tables.pseudonymise.salt_placeholder', 'pseudonym_secret')} />}
            </OpField>
            <OpField ctx={ctx} name="output" label={t('automation_tables.pseudonymise.output', 'Name of the code column')} help={h.output}>
                {id => <TextInput id={id} value={op.output} onChange={output => set({ output })} ariaLabel={t('automation_tables.pseudonymise.output', 'Name of the code column')} />}
            </OpField>
            <OpField ctx={ctx} name="length" label={t('automation_tables.pseudonymise.length', 'Length of the code')} help={h.length}>
                {id => <NumberInput id={id} value={op.length} min={8} max={64} onChange={n => set({ length: n ?? 16 })} ariaLabel={t('automation_tables.pseudonymise.length', 'Length of the code')} />}
            </OpField>
            <OpField ctx={ctx} name="keepColumns" help={h.keepColumns}>
                <Check checked={op.keepColumns} onChange={keepColumns => set({ keepColumns })} label={t('automation_tables.pseudonymise.keep', 'Keep the original columns')} />
            </OpField>
            <OpField ctx={ctx} name="dropColumns" label={t('automation_tables.pseudonymise.drop', 'Also remove these columns')} help={h.dropColumns}>
                <ColumnChips value={op.dropColumns} onChange={dropColumns => set({ dropColumns })} columns={ctx.columns} described={ctx.described} prefer="personal" ariaLabel={t('automation_tables.pseudonymise.drop', 'Also remove these columns')} />
            </OpField>
        </div>
    );
}
