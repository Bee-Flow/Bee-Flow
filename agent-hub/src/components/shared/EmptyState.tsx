import React from 'react';
import Illustration, { type IllustrationName } from './illustrations';

/**
 * EmptyState — the one "nothing here yet" placard: optional glyph or
 * illustration, bold title, muted help text and a primary action, centred in
 * its container. The action is either a labelled callback, rendered as the
 * standard pill button, or a ready-made element for surfaces whose call to
 * action is more than one button (an inline form, two buttons side by side).
 */

export interface EmptyStateAction {
    label: string;
    onClick: () => void;
    /** Defaults to 'primary'. Use 'secondary' for a quieter call to action. */
    variant?: 'primary' | 'secondary';
    /** Optional leading icon/element inside the button. */
    icon?: React.ReactNode;
}

export interface EmptyStateProps {
    /** Large glyph or illustration shown above the title. */
    icon?: React.ReactNode;
    /**
     * One of the shared scenes (illustrations.tsx) instead of a glyph. Ignored
     * when `icon` is given — a caller that already chose its own art wins.
     */
    illustration?: IllustrationName;
    title: React.ReactNode;
    description?: React.ReactNode;
    action?: EmptyStateAction | React.ReactElement;
    className?: string;
}

export default function EmptyState({
    icon,
    illustration,
    title,
    description,
    action,
    className = '',
}: EmptyStateProps) {
    const art = icon || (illustration ? <Illustration name={illustration} /> : null);
    return (
        <div className={`h-full flex flex-col items-center justify-center px-6 py-12 ${className}`}>
            {art && (
                <div className="mb-4 text-[var(--text-tertiary)]" aria-hidden="true">
                    {art}
                </div>
            )}
            <div className="text-lg font-semibold text-[var(--text-primary)] mb-2 text-center">
                {title}
            </div>
            {description && (
                <div className="text-sm text-[var(--text-tertiary)] mb-6 max-w-md text-center leading-relaxed">
                    {description}
                </div>
            )}
            {action && (React.isValidElement(action) ? action : (
                <button
                    type="button"
                    onClick={action.onClick}
                    className={
                        'inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-semibold transition-opacity hover:opacity-90 ' +
                        (action.variant === 'secondary'
                            ? 'bg-white/10 text-[var(--text-primary)]'
                            : 'text-white')
                    }
                    style={
                        action.variant === 'secondary'
                            ? undefined
                            : { background: 'var(--accent-primary)' }
                    }
                >
                    {action.icon}
                    {action.label}
                </button>
            ))}
        </div>
    );
}
