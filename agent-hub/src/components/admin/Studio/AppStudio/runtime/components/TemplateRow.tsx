import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react';

/**
 * A list row drawn from an item template (schema 3, ../itemTemplate.tsx).
 *
 * The template may hold controls of its own, and a control inside a <button> is invalid, so a
 * clickable template row is a focusable element with the button role instead. A click or key
 * that lands on a control inside the template belongs to that control: the row runs its action
 * only for a click on itself or on plain content, and for Enter or Space while it has the focus.
 */

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [tabindex]';

interface TemplateRowProps {
    className: string;
    style?: CSSProperties;
    selected: boolean;
    onActivate: (() => void) | null;
    children: ReactNode;
}

/** True when the event started on a control inside the row (not on the row itself). */
function fromInnerControl(row: HTMLElement, target: EventTarget | null): boolean {
    const hit = target instanceof Element ? target.closest(INTERACTIVE) : null;
    return !!hit && hit !== row && row.contains(hit);
}

export function TemplateRow({ className, style, selected, onActivate, children }: TemplateRowProps) {
    if (!onActivate) return <div className={className} style={style}>{children}</div>;
    const onClick = (e: MouseEvent<HTMLDivElement>) => {
        if (!fromInnerControl(e.currentTarget, e.target)) onActivate();
    };
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        onActivate();
    };
    return (
        <div
            role="button"
            tabIndex={0}
            aria-current={selected ? 'true' : undefined}
            className={`${className} cursor-pointer transition-colors hover:brightness-[1.06] app-focusable`}
            style={style}
            onClick={onClick}
            onKeyDown={onKeyDown}
        >
            {children}
        </div>
    );
}
