import { Braces } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import FormField from '../../../../shared/FormField';
import Toggle from '../../../../shared/Toggle';
import { INPUT_CLS } from '../inspector/panels/kit';
import type { DefaultFieldProps, JsonDefaultFieldProps } from './VariablesManager.types';

export function DefaultField({ variable, onChange, disabled }: DefaultFieldProps) {
    const { t } = useTranslation();
    const { name, type } = variable;
    const label = t('studio_apps_edit.variables.starts_as', 'Starts out as');
    const aria = t('studio_apps_edit.variables.start_aria', 'Starting value of {name}', { name });

    if (type === 'yesno') {
        return (
            <Toggle
                size="sm"
                label={label}
                checked={variable.default === true}
                onChange={(v) => onChange(v)}
                ariaLabel={aria}
                disabled={disabled}
            />
        );
    }
    if (type === 'number') {
        return (
            <FormField label={label}>
                <input
                    type="number"
                    className={INPUT_CLS}
                    value={(variable.default ?? 0) as number}
                    onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
                    disabled={disabled}
                    aria-label={aria}
                />
            </FormField>
        );
    }
    if (type === 'date') {
        return (
            <FormField label={label} hint={t('studio_apps_edit.variables.date_hint', 'Left empty means “no date yet”. Use the today function where you read it if you want today.')}>
                <input
                    type="date"
                    className={INPUT_CLS}
                    value={typeof variable.default === 'string' ? variable.default : ''}
                    onChange={(e) => onChange(e.target.value || null)}
                    disabled={disabled}
                    aria-label={aria}
                />
            </FormField>
        );
    }
    if (type === 'record' || type === 'list' || type === 'any') {
        return <JsonDefaultField variable={variable} onChange={onChange} disabled={disabled} label={label} aria={aria} />;
    }
    return (
        <FormField label={label}>
            <input
                type="text"
                className={INPUT_CLS}
                value={(variable.default ?? '') as string}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                aria-label={aria}
            />
        </FormField>
    );
}

function JsonDefaultField({ variable, onChange, disabled, label, aria }: JsonDefaultFieldProps) {
    const { t } = useTranslation();
    const [text, setText] = useState(() => {
        try { return JSON.stringify(variable.default ?? null); } catch { return 'null'; }
    });
    const [error, setError] = useState<string | null>(null);

    return (
        <FormField label={label} hint={t('studio_apps_edit.variables.json_hint', 'Written as JSON.')} error={error || undefined}>
            <div className="flex items-stretch gap-1.5">
                <input
                    type="text"
                    className={`${INPUT_CLS} font-mono text-xs`}
                    value={text}
                    onChange={(e) => {
                        setText(e.target.value);
                        try {
                            const parsed = JSON.parse(e.target.value);
                            setError(null);
                            onChange(parsed);
                        } catch {
                            setError(t('studio_apps_edit.variables.json_invalid', 'Not valid JSON yet.'));
                        }
                    }}
                    disabled={disabled}
                    spellCheck={false}
                    aria-label={aria}
                />
                <span className="shrink-0 px-2 flex items-center text-[var(--text-tertiary)]" aria-hidden="true">
                    <Braces size={13} />
                </span>
            </div>
        </FormField>
    );
}
