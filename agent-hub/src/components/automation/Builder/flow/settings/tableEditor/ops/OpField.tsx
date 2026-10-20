import { useId, type ReactNode } from 'react';
import { claims } from '../tableOpModel';
import { fieldLabelClass, hintTextClass } from '../../formStyles';
import type { OpContext } from './opFormTypes';

interface OpFieldProps {
    ctx: Pick<OpContext, 'issues'>;
    /** The field's path inside the operation (`by`, `aggregates[1].column`): where findings land. */
    name: string;
    label?: string;
    help?: string;
    /** Only a finding for exactly this path, not for what is inside it (the title of a list of rows). */
    exact?: boolean;
    children: ReactNode | ((id: string) => ReactNode);
}

/**
 * One labelled setting of an operation: the label, the control, a plain
 * sentence on what it does, and every problem the preview found with exactly
 * this field, in red next to it.
 */
export default function OpField({ ctx, name, label, help, exact = false, children }: OpFieldProps) {
    const id = useId();
    const mine = ctx.issues.filter(i => claims(i.rest, name, exact));
    const errors = mine.filter(i => i.severity === 'error');
    return (
        <div
            data-field={name}
            data-invalid={errors.length ? 'true' : undefined}
            className={`flex flex-col gap-1 rounded ${errors.length ? 'border border-[var(--error)] p-1.5' : ''}`}
        >
            {label && <label htmlFor={id} className={fieldLabelClass()}>{label}</label>}
            {typeof children === 'function' ? children(id) : children}
            {help && <p className={hintTextClass()}>{help}</p>}
            {mine.map((i, n) => (
                <p key={`${i.code}-${n}`} role={i.severity === 'error' ? 'alert' : undefined} className={`text-[11px] ${i.severity === 'error' ? 'text-[var(--error)]' : 'text-amber-600 dark:text-amber-400'}`}>
                    {i.message}{i.hint ? ` ${i.hint}` : ''}
                </p>
            ))}
        </div>
    );
}
