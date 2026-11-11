import { Star } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { useFormField } from '../formContext';
import type { BindingInput } from '../resolveBinding.types';
import { Field } from '../uiBits';
import useInputChange from '../useInputChange';
import useValueFrom from '../useValueFrom';
import type { NodeProps } from './appNode.types';

/**
 * App Studio runtime - 'rating' (schema 3). Spec: server/appStudio/componentSpecs/types/rating.js.
 *
 * A row of stars that submits a whole number from 1 to `max`, and nothing until one is chosen.
 * It is a radiogroup of radio buttons with one tab stop: the arrow keys move and choose, Home
 * and End jump to the first and the last star.
 */
interface RatingProps {
    name?: string;
    label?: string;
    max?: number;
    required?: boolean;
    defaultValue?: number | null;
    valueFrom?: BindingInput;
}

const MAX_STARS = 10;

/** The star a pressed key moves to, or null when the key is not one of the group's. */
function targetStar(key: string, from: number, max: number): number | null {
    if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(max, from + 1);
    if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(1, from - 1);
    if (key === 'Home') return 1;
    if (key === 'End') return max;
    return null;
}

export default function AppRating({ node }: NodeProps<RatingProps>) {
    const { t } = useTranslation();
    const props = node.props || {};
    const { name, label = t('studio_apps_lk21a.rating.default_label', 'Rating'), required = false, defaultValue = null } = props;
    const max = Number.isInteger(props.max) ? Math.min(MAX_STARS, Math.max(2, props.max as number)) : 5;
    const whole = (raw: unknown): number | null => {
        const n = Math.round(Number(raw));
        return raw != null && raw !== '' && Number.isFinite(n) && n >= 1 ? Math.min(max, n) : null;
    };
    const { value, setValue, error } = useFormField<number>({ name, defaultValue: whole(defaultValue), required, label });
    useValueFrom(node, (raw) => { const n = whole(raw); if (n !== null) setValue(n); });
    const fireChange = useInputChange(node, name);
    const id = `${node.id}-input`;
    const current = whole(value);
    const choose = (n: number) => { setValue(n); fireChange(n); };
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        const next = targetStar(event.key, current ?? 0, max);
        if (next === null) return;
        event.preventDefault();
        choose(next);
        event.currentTarget.parentElement?.querySelectorAll('button')[next - 1]?.focus();
    };

    return (
        <Field part="rating" id={id} label={label} required={required} error={error}>
            <div
                id={id}
                role="radiogroup"
                aria-label={label}
                aria-required={required || undefined}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                className="inline-flex items-center gap-0.5 bfa-rating__control"
            >
                {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
                    const filled = current !== null && n <= current;
                    return (
                        <button
                            key={n}
                            type="button"
                            role="radio"
                            aria-checked={current === n}
                            aria-label={t('studio_apps_lk21a.rating.star', '{n} of {max}', { n, max })}
                            tabIndex={current === n || (current === null && n === 1) ? 0 : -1}
                            onClick={() => choose(n)}
                            onKeyDown={onKeyDown}
                            className={`p-0.5 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-secondary)] ${filled ? '[color:var(--app-primary)]' : '[color:var(--text-muted)]'} bfa-rating__star`}
                        >
                            <Star className="w-5 h-5" fill={filled ? 'currentColor' : 'none'} aria-hidden="true" />
                        </button>
                    );
                })}
            </div>
        </Field>
    );
}
