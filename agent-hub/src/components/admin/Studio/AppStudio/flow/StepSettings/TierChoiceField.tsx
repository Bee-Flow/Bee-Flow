import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import ExpressionInput from '../../inspector/logic/ExpressionInput';
import { INPUT_CLS } from '../../inspector/panels/kit';
import type { AppDefinition, AppNode } from '../../inspector/appDefinition';

type TierBinding = { kind: 'formula'; expr?: string } | { kind: 'static'; value?: unknown };

interface TierChoiceFieldProps {
    label: string;
    hint?: string;
    value: unknown;
    onChange: (next: unknown) => void;
    definition: AppDefinition;
    node?: AppNode | null;
    maxLen?: number;
    disabled?: boolean;
}

const isFormula = (v: unknown): v is TierBinding & { kind: 'formula' } =>
    !!v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'formula';

/**
 * modelTier on an AI step: a tier name ("fast", "thinking"), or a formula worked
 * out when the step runs, so one action can use the quick model for a short text
 * and the thinking one for a long document. A formula that gives no tier name
 * runs on the default tier, and the step result says so.
 */
export default function TierChoiceField({ label, hint, value, onChange, definition, node = null, maxLen, disabled = false }: TierChoiceFieldProps) {
    const { t } = useTranslation();
    const formula = isFormula(value);
    const staticValue = value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'static'
        ? String((value as { value?: unknown }).value ?? '') : '';
    const name = typeof value === 'string' ? value : staticValue;

    return (
        <FormField label={label} hint={hint}>
            <div className="flex flex-col gap-1.5" data-tier-choice={formula ? 'formula' : 'name'}>
                <SegmentedControl
                    value={formula ? 'formula' : 'name'}
                    onChange={(next) => onChange(next === 'formula' ? { kind: 'formula', expr: '' } : '')}
                    options={[
                        { value: 'name', label: t('studio_apps_edit.step_settings.tier_by_name', 'A tier') },
                        { value: 'formula', label: t('studio_apps_edit.step_settings.tier_by_formula', 'Work it out with a formula') },
                    ]}
                    size="sm"
                    ariaLabel={t('studio_apps_edit.step_settings.tier_source', 'How the model tier is chosen')}
                />
                {formula ? (
                    <ExpressionInput
                        variant="inline"
                        value={value.expr || ''}
                        onChange={(expr) => onChange({ kind: 'formula', expr })}
                        definition={definition}
                        node={node}
                        ariaLabel={t('studio_apps_edit.step_settings.tier_formula', 'Model tier formula')}
                        placeholder={t('studio_apps_edit.step_settings.tier_formula_example', "e.g. params.quick ? 'fast' : 'thinking'")}
                        disabled={disabled}
                    />
                ) : (
                    <input
                        type="text"
                        className={INPUT_CLS}
                        value={name}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={t('studio_apps_edit.step_settings.tier_name_example', 'e.g. fast')}
                        maxLength={maxLen}
                        disabled={disabled}
                        spellCheck={false}
                        aria-label={label}
                    />
                )}
                {formula ? (
                    <span className="text-[11px] text-[var(--text-secondary)]">
                        {t('studio_apps_edit.step_settings.tier_formula_help', 'If the formula does not give a tier name, the default tier is used and the step result says so.')}
                    </span>
                ) : null}
            </div>
        </FormField>
    );
}
