import useTranslation from '@/hooks/useTranslation';
import { NumberField, SelectField, TextField } from '../inspector/panels/kit';
import { DYNAMIC_DEFAULT_BY_TYPE, RULES_BY_TYPE, validationOf, withDynamicDefault, withRule } from './fieldRules';
import type { FieldValidation } from './fieldRules';
import type { ModelField } from './tablesManagerModel';

/**
 * The rules part of one field in the table editor: the checks every save of the
 * field must pass (field.validation) and the value a new record gets when it
 * is created without one (field.dynamicDefault). Only the controls that apply
 * to the field's type are shown; a type without any shows nothing.
 */

const CHECK_CLS = 'accent-[var(--accent-primary)]';

interface PartProps {
    field: ModelField;
    v: FieldValidation;
    update: (next: ModelField) => void;
    disabled: boolean;
}

function NumberRules({ field, v, update, disabled }: PartProps) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-2 gap-2">
            <NumberField label={t('studio_apps_validation.min', 'Minimum')} value={v.min ?? null} onChange={(n) => update(withRule(field, 'min', n))} disabled={disabled} />
            <NumberField label={t('studio_apps_validation.max', 'Maximum')} value={v.max ?? null} onChange={(n) => update(withRule(field, 'max', n))} disabled={disabled} />
        </div>
    );
}

function TextRules({ field, v, update, disabled }: PartProps) {
    const { t } = useTranslation();
    return (
        <>
            <div className="grid grid-cols-2 gap-2">
                <NumberField label={t('studio_apps_validation.min_length', 'Minimum length')} value={v.minLength ?? null} step={1} onChange={(n) => update(withRule(field, 'minLength', n))} disabled={disabled} />
                <NumberField label={t('studio_apps_validation.max_length', 'Maximum length')} value={v.maxLength ?? null} step={1} onChange={(n) => update(withRule(field, 'maxLength', n))} disabled={disabled} />
            </div>
            <TextField
                label={t('studio_apps_validation.pattern', 'Pattern')}
                value={v.pattern ?? ''}
                onChange={(s) => update(withRule(field, 'pattern', s))}
                hint={t('studio_apps_validation.pattern_hint', 'A regular expression the text must match, for example ^[0-9]{4}$')}
                disabled={disabled}
            />
        </>
    );
}

function OptionsRule({ field, v, update, disabled }: PartProps) {
    const { t } = useTranslation();
    return (
        <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs text-[var(--text-secondary)]">
            <input type="checkbox" className={CHECK_CLS} checked={v.enforceOptions === true} disabled={disabled}
                onChange={(e) => update(withRule(field, 'enforceOptions', e.target.checked))} />
            {t('studio_apps_validation.enforce_options', 'Only the listed choices')}
        </label>
    );
}

function DynamicDefault({ field, value, update, disabled }: { field: ModelField; value: string; update: (next: ModelField) => void; disabled: boolean }) {
    const { t } = useTranslation();
    const labels: Record<string, string> = {
        now: t('studio_apps_validation.dynamic_now', 'The current date and time'),
        today: t('studio_apps_validation.dynamic_today', 'Today\'s date'),
        'currentUser.id': t('studio_apps_validation.dynamic_user', 'The signed-in user'),
    };
    return (
        <SelectField
            label={t('studio_apps_validation.dynamic_default', 'Fill when a record is created')}
            value={typeof field.dynamicDefault === 'string' ? field.dynamicDefault : ''}
            onChange={(s) => update(withDynamicDefault(field, s || null))}
            options={[
                { value: '', label: t('studio_apps_validation.dynamic_none', 'Nothing') },
                { value, label: labels[value] || value },
            ]}
            disabled={disabled}
        />
    );
}

interface FieldRulesEditorProps {
    field: ModelField;
    update: (next: ModelField) => void;
    disabled: boolean;
}

export default function FieldRulesEditor({ field, update, disabled }: FieldRulesEditorProps) {
    const { t } = useTranslation();
    const type = field.type || 'text';
    const rules = RULES_BY_TYPE[type] || [];
    const dynamic = DYNAMIC_DEFAULT_BY_TYPE[type];
    if (!rules.length && !dynamic) return null;
    const v = validationOf(field);
    const part = { field, v, update, disabled };
    const hasRule = Object.keys(v).some((k) => k !== 'message');

    return (
        <fieldset className="flex flex-col gap-2 rounded-md border border-[var(--border-default)] p-2" data-field-rules="true">
            <legend className="px-1 text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_validation.heading', 'Rules')}</legend>
            <span className="text-[11px] text-[var(--text-tertiary)]">{t('studio_apps_validation.hint', 'Checked every time this field is saved. Rows already stored are not checked again.')}</span>
            {rules.includes('min') ? <NumberRules {...part} /> : null}
            {rules.includes('minLength') ? <TextRules {...part} /> : null}
            {rules.includes('enforceOptions') ? <OptionsRule {...part} /> : null}
            {hasRule ? (
                <TextField
                    label={t('studio_apps_validation.message', 'Error message')}
                    value={v.message ?? ''}
                    onChange={(s) => update(withRule(field, 'message', s))}
                    hint={t('studio_apps_validation.message_hint', 'Shown instead of the generated message when a rule is not met.')}
                    disabled={disabled}
                />
            ) : null}
            {dynamic ? <DynamicDefault field={field} value={dynamic} update={update} disabled={disabled} /> : null}
        </fieldset>
    );
}
