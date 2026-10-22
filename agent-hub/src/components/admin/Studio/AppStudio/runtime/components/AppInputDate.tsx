import { todayIso } from './localDate';
import useTranslation from '../../../../../../hooks/useTranslation';
import { useFormField } from '../formContext';
import { Field, INPUT_CLASS, inputStyle } from '../uiBits';
import useInputChange from '../useInputChange';
import useValueFrom from '../useValueFrom';
import type { BindingInput } from '../resolveBinding.types';
import type { NodeProps } from './appNode.types';

/** App Studio runtime — 'input_date'. Spec: server/appStudio/componentSpecs.js. */

interface InputDateProps {
    name?: string;
    label?: string;
    required?: boolean;
    defaultValue?: string | null;
    valueFrom?: BindingInput;
}

export default function AppInputDate({ node }: NodeProps<InputDateProps>) {
    const { t } = useTranslation();
    const { name, label = t('studio_apps_runtime.inputs.date', 'Date'), required = false, defaultValue = null } = node.props || {};
    // defaultValue is null | 'today' | an ISO date (allowIsoDate in the spec).
    const seeded = defaultValue === 'today' ? todayIso() : defaultValue;
    const { value, setValue, error } = useFormField<string>({ name, defaultValue: seeded, required, label });
    useValueFrom(node, setValue);   // setValue, never fireChange — see AppInputSelect
    const fireChange = useInputChange(node, name);
    const id = `${node.id}-input`;
    return (
        <Field id={id} label={label} required={required} error={error}>
            <input
                id={id}
                name={name}
                type="date"
                value={value ?? ''}
                aria-required={required || undefined}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                onChange={(e) => { setValue(e.target.value); fireChange(e.target.value); }}
                className={INPUT_CLASS}
                style={inputStyle(error)}
            />
        </Field>
    );
}
