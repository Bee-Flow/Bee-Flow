import { Check, Lock } from 'lucide-react';
import React from 'react';

/**
 * Small building blocks shared by the list, the locked view and the wizard.
 * Tailwind on the theme variables only, so every colour follows the theme.
 */

export function Card({ children, className = '', tone }: { children: React.ReactNode; className?: string; tone?: 'warn' | 'info' | 'error' }) {
    const toneClass = tone === 'warn'
        ? 'bg-[color-mix(in_srgb,var(--warning)_9%,transparent)] border-[color-mix(in_srgb,var(--warning)_50%,transparent)]'
        : tone === 'error'
            ? 'bg-[color-mix(in_srgb,var(--error)_8%,transparent)] border-[var(--error)]'
            : tone === 'info'
                ? 'bg-[color-mix(in_srgb,var(--info)_8%,transparent)] border-[color-mix(in_srgb,var(--info)_30%,transparent)]'
                : 'bg-[var(--bg-card)] border-[var(--border-default)] shadow-[var(--shadow-sm)]';
    return <div className={`rounded-xl border ${toneClass} ${className}`}>{children}</div>;
}

/** A one-line note with an icon, in a tone. */
export function Note({
    Icon, tone = 'info', children, role,
}: {
    Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
    tone?: 'info' | 'warn' | 'error' | 'muted';
    children: React.ReactNode;
    role?: 'status' | 'alert';
}) {
    const ink = tone === 'warn'
        ? 'text-[var(--warning-ink)]'
        : tone === 'error' ? 'text-[var(--error-ink)]' : tone === 'muted' ? 'text-[var(--text-tertiary)]' : 'text-[var(--info-ink)]';
    return (
        <p role={role} className="flex items-start gap-1.5 text-[11px] leading-relaxed m-0 text-[var(--text-secondary)]">
            <Icon className={`w-3.5 h-3.5 shrink-0 mt-px ${ink}`} aria-hidden="true" />
            <span className="min-w-0">{children}</span>
        </p>
    );
}

/**
 * One switch cell of the list: a real checkbox, named by row AND column so a
 * screen reader hears "Project code names, Outside tools, checked".
 */
export function CheckCell({
    checked, disabled, locked, name, onChange,
}: { checked: boolean; disabled?: boolean; locked?: boolean; name: string; onChange: (on: boolean) => void }) {
    if (locked) {
        return (
            <span
                className="inline-grid place-items-center w-4 h-4 rounded border border-[var(--border-default)] bg-[var(--bg-tertiary)] opacity-50"
                title={name}
            >
                <Lock className="w-[9px] h-[9px] text-[var(--text-tertiary)]" aria-hidden="true" />
            </span>
        );
    }
    return (
        <label className={`relative inline-grid place-items-center ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
            <input
                type="checkbox"
                className="sr-only peer"
                checked={checked}
                disabled={disabled}
                onChange={e => onChange(e.target.checked)}
                aria-label={name}
            />
            <span
                aria-hidden="true"
                className={'w-4 h-4 rounded grid place-items-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-offset-1 border '
                    + (checked
                        ? 'bg-[var(--text-primary)] border-[var(--text-primary)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)]'
                        : 'bg-[var(--bg-card)] border-[var(--border-default)]')
                    + (disabled ? ' opacity-50' : '')}
            >
                {checked && <Check className="w-[11px] h-[11px]" aria-hidden="true" />}
            </span>
        </label>
    );
}

/**
 * The tab's main action: a dark button on the text colour, so it reads as
 * the one thing to do in every theme. Height and type size come from
 * `className`, because the landing and the list header differ.
 */
export function DarkButton({
    Icon, children, className = '', type = 'button', ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { Icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }> }) {
    return (
        <button
            type={type}
            className={'inline-flex items-center justify-center gap-1.5 shrink-0 font-semibold whitespace-nowrap cursor-pointer '
                + 'bg-[var(--text-primary)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed '
                + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[var(--info)] ' + className}
            {...rest}
        >
            {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
            {children}
        </button>
    );
}

/** A quiet text-style button, for row actions and inline links. */
export function LinkButton({
    children, onClick, disabled, danger, ariaLabel, className = '',
}: {
    children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; ariaLabel?: string; className?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel}
            className={'text-[11px] font-semibold whitespace-nowrap hover:underline disabled:opacity-40 disabled:no-underline '
                + (danger ? 'text-[var(--error-ink)] ' : 'text-[var(--info-ink)] ') + className}
        >
            {children}
        </button>
    );
}

/** The placeholder a type turns into, as the AI will read it. */
export function PlaceholderChip({ tokenKey }: { tokenKey: string }) {
    return (
        <code className="text-[10px] px-1.5 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-mono whitespace-nowrap">
            [{tokenKey || 'your_type'}_1]
        </code>
    );
}

export function Tag({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' }) {
    return (
        <span
            className={'text-[10px] px-1.5 py-px rounded-full whitespace-nowrap border '
                + (tone === 'warn'
                    ? 'text-[var(--warning-ink)] border-[var(--warning)]'
                    : 'text-[var(--text-tertiary)] border-[var(--border-default)]')}
        >
            {children}
        </span>
    );
}
