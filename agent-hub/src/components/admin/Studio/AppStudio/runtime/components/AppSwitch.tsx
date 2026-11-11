import useTranslation from '@/hooks/useTranslation';
import { useFormContext, useFormField } from '../formContext';
import type { BindingInput } from '../resolveBinding.types';
import { Field } from '../uiBits';
import useInputChange from '../useInputChange';
import useValueFrom from '../useValueFrom';
import type { NodeProps } from './appNode.types';

/**
 * App Studio runtime - 'switch' (schema 3). Spec: server/appStudio/componentSpecs/types/switch.js.
 *
 * An on/off input that submits a boolean through the same form path as input_checkbox. It is a
 * native button with role="switch": Space and Enter toggle it, and a screen reader says on/off.
 * A required switch must be on, like a required checkbox.
 */
interface SwitchProps {
    name?: string;
    label?: string;
    defaultChecked?: boolean;
    required?: boolean;
    valueFrom?: BindingInput;
}

/** What a binding may push into a switch: a boolean, 1 or the word true. */
function asBoolean(raw: unknown): boolean {
    return raw === true || raw === 1 || raw === 'true';
}

/** What the form holds under `name`, or `fallback` while it holds nothing. */
function heldValue(values: Record<string, unknown> | undefined, name: string | undefined, fallback: boolean): unknown {
    return values && name && Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
}

export default function AppSwitch({ node }: NodeProps<SwitchProps>) {
    const { t } = useTranslation();
    const { name, label = t('studio_apps_lk21a.switch.default_label', 'Enabled'), defaultChecked = false, required = false } = node.props || {};
    // The form's own `required` rule treats an off switch as filled in (it only rejects an empty value), so a
    // required switch says through `invalid` that it is not on yet: submit stops, with the form's usual text.
    const form = useFormContext();
    const held = heldValue(form?.values, name, defaultChecked);
    const { value, setValue, error } = useFormField<boolean>({
        name, defaultValue: !!defaultChecked, required, label,
        invalid: required && !held, invalidMessage: t('studio_apps_runtime.form.required', 'This field is required.'),
    });
    useValueFrom(node, (raw) => setValue(asBoolean(raw)));
    const fireChange = useInputChange(node, name);
    const id = `${node.id}-input`;
    const on = !!value;
    const toggle = () => { setValue(!on); fireChange(!on); };

    return (
        <Field part="switch" id={id} label={null} error={error}>
            <div className="inline-flex items-center gap-2 text-sm select-none">
                <button
                    id={id}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-required={required || undefined}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : undefined}
                    onClick={toggle}
                    data-app-switch={on ? 'on' : 'off'}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--text-secondary)] ${on ? '[background:var(--app-primary)] [border-color:var(--app-primary)]' : '[background:var(--bg-tertiary)] [border-color:var(--border-default)]'} bfa-switch__control`}
                >
                    <span
                        aria-hidden="true"
                        className={`pointer-events-none absolute left-0.5 h-3.5 w-3.5 rounded-full transition-transform ${on ? 'translate-x-4 [background:var(--app-primary-contrast)]' : 'translate-x-0 [background:var(--text-muted)]'} bfa-switch__thumb`}
                    />
                </button>
                <label htmlFor={id} className="cursor-pointer bfa-switch__label">
                    {label}
                    {required ? <span aria-hidden="true" className="[color:var(--error)]"> *</span> : null}
                </label>
            </div>
        </Field>
    );
}
