import React from 'react';

/**
 * Label + control + error frame of one form question: App Studio's `Field`
 * (runtime/uiBits) with the stable `bf-form__*` classes a form's custom CSS
 * targets, and the label INSIDE the box when the author chose that.
 *
 * Inside, the label sits small at the top of the control (which gets the room
 * for it from TEXT_CONTROL_CLASS), so it never covers a placeholder or a value.
 */

/*
 * A 1px border-colour change bound to :focus was the whole focus indicator in
 * uiBits once; this keeps its fix: a real ring on :focus-visible in a token
 * that contrasts by construction.
 */
const FOCUS_OUTLINE = 'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--text-secondary)]';

/**
 * The text-like controls (text, email, number, date, textarea, select). Every
 * look is a CSS variable the style sets on the form's root (formStyleVars:
 * outlined / filled / underlined), with the old look as the fallback.
 */
export function textControlClass(error: boolean, inside: boolean): string {
    return [
        'bf-form__input w-full px-2.5 text-sm text-[var(--text-primary)] [border-style:solid]',
        inside ? 'pt-5 pb-1.5' : 'py-1.5',
        '[border-width:var(--bf-input-border-width,1px)] [border-radius:var(--bf-input-radius,var(--app-radius))] [background:var(--bf-input-bg,var(--bg-primary))]',
        error ? '[border-color:var(--error)]' : '[border-color:var(--border-default)]',
        FOCUS_OUTLINE,
    ].join(' ');
}

const LABEL_ABOVE = 'bf-form__label text-sm font-medium text-[var(--bf-label,var(--text-primary))]';
const LABEL_INSIDE = 'bf-form__label pointer-events-none absolute left-2.5 top-1 text-[11px] leading-tight font-medium text-[var(--bf-label,var(--text-secondary))]';

interface FrameProps {
    id: string;
    label?: React.ReactNode;
    required?: boolean;
    error?: React.ReactNode;
    /** The label goes inside the control's box. */
    inside?: boolean;
    /** The control itself. */
    control: React.ReactNode;
    /** Help text and notes under the control. */
    children?: React.ReactNode;
}

export default function FormFieldFrame({ id, label, required, error, inside = false, control, children }: FrameProps) {
    const labelEl = label ? (
        <label htmlFor={id} className={inside ? LABEL_INSIDE : LABEL_ABOVE}>
            {label}
            {required ? <span aria-hidden="true" className="[color:var(--error)]"> *</span> : null}
        </label>
    ) : null;
    return (
        <div className="flex flex-col gap-1 text-left">
            {inside && labelEl ? <div className="relative">{control}{labelEl}</div> : <>{labelEl}{control}</>}
            {children}
            {error ? (
                <p id={`${id}-error`} className="bf-form__error text-xs [color:var(--error)]!" role="alert">{error}</p>
            ) : null}
        </div>
    );
}
