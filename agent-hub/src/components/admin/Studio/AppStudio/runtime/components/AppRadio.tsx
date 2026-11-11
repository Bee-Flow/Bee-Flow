import useTranslation from '@/hooks/useTranslation';
import type { OptionPair } from '../../tables/rowValues';
import { useFormField } from '../formContext';
import type { BindingInput } from '../resolveBinding.types';
import { Field } from '../uiBits';
import useInputChange from '../useInputChange';
import useValueFrom from '../useValueFrom';
import type { NodeProps } from './appNode.types';

/**
 * App Studio runtime - 'radio' (schema 3). Spec: server/appStudio/componentSpecs/types/radio.js.
 *
 * A group of native radio buttons that submits the chosen option's value as a string, like
 * input_select. The group is a radiogroup named by its label; arrow keys move within it (the
 * browser's own behaviour for radios that share a name).
 */
interface RadioProps {
    name?: string;
    label?: string;
    options?: OptionPair[];
    required?: boolean;
    defaultValue?: string | null;
    valueFrom?: BindingInput;
}

export default function AppRadio({ node }: NodeProps<RadioProps>) {
    const { t } = useTranslation();
    const { name, label = t('studio_apps_lk21a.radio.default_label', 'Choice'), options = [], required = false, defaultValue = null } = node.props || {};
    const opts = (Array.isArray(options) ? options : []).filter((o) => o && o.value != null && o.value !== '');
    const seeded = defaultValue != null && opts.some((o) => String(o.value) === String(defaultValue)) ? String(defaultValue) : null;
    const { value, setValue, error } = useFormField<string>({ name, defaultValue: seeded, required, label });
    useValueFrom(node, (raw) => setValue(String(raw)));
    const fireChange = useInputChange(node, name);
    const id = `${node.id}-input`;
    const group = `${node.id}-${name || 'radio'}`;

    return (
        <Field part="radio" id={id} label={null} error={error}>
            <span id={`${id}-label`} className="text-sm font-medium text-[var(--text-primary)] bfa-radio__label">
                {label}
                {required ? <span aria-hidden="true" className="[color:var(--error)]"> *</span> : null}
            </span>
            <div
                id={id}
                role="radiogroup"
                aria-labelledby={`${id}-label`}
                aria-required={required || undefined}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                className="flex flex-col gap-1.5 bfa-radio__group"
            >
                {opts.length === 0 ? (
                    <span className="text-sm text-[var(--text-muted)]">{t('studio_apps_lk21a.radio.no_options', 'No options yet.')}</span>
                ) : opts.map((opt) => (
                    <label key={opt.value} className="inline-flex items-center gap-2 text-sm cursor-pointer bfa-radio__option">
                        <input
                            type="radio"
                            name={group}
                            value={opt.value}
                            checked={value != null && String(value) === String(opt.value)}
                            onChange={() => { setValue(String(opt.value)); fireChange(String(opt.value)); }}
                            className="h-4 w-4 [accent-color:var(--app-primary)] bfa-radio__control"
                        />
                        <span className="bfa-radio__text">{opt.label || opt.value}</span>
                    </label>
                ))}
            </div>
        </Field>
    );
}
