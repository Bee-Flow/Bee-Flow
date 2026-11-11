import useTranslation from '@/hooks/useTranslation';
import { useFormField } from '../formContext';
import type { BindingInput } from '../resolveBinding.types';
import { Field } from '../uiBits';
import useInputChange from '../useInputChange';
import useValueFrom from '../useValueFrom';
import type { NodeProps } from './appNode.types';

/**
 * App Studio runtime - 'slider' (schema 3). Spec: server/appStudio/componentSpecs/types/slider.js.
 *
 * A native range input that submits a number between min and max (it always holds one: the
 * default, or min). The value is shown beside the track. Arrow keys, Home, End and the page
 * keys are the browser's own.
 */
interface SliderProps {
    name?: string;
    label?: string;
    min?: number;
    max?: number;
    step?: number;
    required?: boolean;
    defaultValue?: number | null;
    valueFrom?: BindingInput;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export default function AppSlider({ node }: NodeProps<SliderProps>) {
    const { t } = useTranslation();
    const props = node.props || {};
    const { name, label = t('studio_apps_lk21a.slider.default_label', 'Level'), required = false, defaultValue = null } = props;
    const min = finite(props.min) ? props.min : 0;
    const max = finite(props.max) && props.max > min ? props.max : min + 100;
    const step = finite(props.step) && props.step > 0 ? props.step : 1;
    const clamp = (n: number) => Math.min(max, Math.max(min, n));
    const { value, setValue, error } = useFormField<number>({
        name, defaultValue: clamp(finite(defaultValue) ? defaultValue : min), required, label,
    });
    useValueFrom(node, (raw) => { if (raw !== '' && Number.isFinite(Number(raw))) setValue(clamp(Number(raw))); });
    const fireChange = useInputChange(node, name);
    const id = `${node.id}-input`;
    const shown = finite(value) ? clamp(value) : min;

    return (
        <Field part="slider" id={id} label={label} required={required} error={error}>
            <div className="flex items-center gap-3">
                <input
                    id={id}
                    name={name}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={shown}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : undefined}
                    onChange={(e) => { const next = e.target.valueAsNumber; setValue(next); fireChange(next); }}
                    className="flex-1 min-w-0 [accent-color:var(--app-primary)] bfa-slider__control"
                />
                <output htmlFor={id} className="min-w-8 text-right text-sm tabular-nums text-[var(--text-secondary)] bfa-slider__value">{shown}</output>
            </div>
        </Field>
    );
}
