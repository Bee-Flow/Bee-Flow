// The small Studio recipes the workspace repeats: buttons, cards, notice
// strips, the member avatar. Tokens only (`var(--…)` classes), so every theme
// — light, paper, sepia, the glass pair — paints them without `dark:` rules.

import { Loader2 } from 'lucide-react';
import React from 'react';
import { initialsOf } from './projectVisuals';

export const INPUT_CLASS =
    'w-full px-3 py-2 rounded-lg text-sm border border-[var(--border-default)] bg-[var(--bg-primary)] '
    + 'text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus-visible:outline focus-visible:outline-2 '
    + 'focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-primary)] disabled:opacity-60';

export const SELECT_CLASS =
    'h-8 px-2 rounded-lg text-[13px] border border-[var(--border-default)] bg-[var(--bg-primary)] '
    + 'text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] disabled:opacity-60';

const PRIMARY_CLASS =
    'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold whitespace-nowrap '
    + 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:bg-[var(--accent-primary-hover)] transition-colors '
    + 'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]';

const SECONDARY_CLASS =
    'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-[13px] whitespace-nowrap border border-[var(--border-default)] '
    + 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] transition-colors '
    + 'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

const GHOST_CLASS =
    'inline-flex items-center gap-1.5 px-1.5 py-1 rounded-lg text-[12px] text-[var(--text-tertiary)] '
    + 'hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean };

function withBusy(busy: boolean | undefined, children: React.ReactNode) {
    return (
        <>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
            {children}
        </>
    );
}

/** The theme's filled accent button — never an ink fill (Studio rule). */
export function PrimaryButton({ busy, className = '', children, type = 'button', disabled, ...rest }: ButtonProps) {
    return (
        <button type={type} disabled={disabled || busy} className={`${PRIMARY_CLASS} ${className}`.trim()} {...rest}>
            {withBusy(busy, children)}
        </button>
    );
}

export function SecondaryButton({ busy, className = '', children, type = 'button', disabled, ...rest }: ButtonProps) {
    return (
        <button type={type} disabled={disabled || busy} className={`${SECONDARY_CLASS} ${className}`.trim()} {...rest}>
            {withBusy(busy, children)}
        </button>
    );
}

export function GhostButton({ className = '', children, type = 'button', ...rest }: ButtonProps) {
    return <button type={type} className={`${GHOST_CLASS} ${className}`.trim()} {...rest}>{children}</button>;
}

/** A panel card (the RecentWorkList recipe). */
export function Card({ title, action, children, className = '', testId }: {
    title?: React.ReactNode;
    action?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
    testId?: string;
}) {
    return (
        <section className={`rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3.5 py-3 ${className}`.trim()} data-testid={testId}>
            {(title || action) && (
                <div className="flex items-center justify-between gap-2 mb-2">
                    {title && <h2 className="text-[13px] font-semibold text-[var(--text-primary)] m-0">{title}</h2>}
                    {action}
                </div>
            )}
            {children}
        </section>
    );
}

/** The 11px uppercase heading of a section on a page. */
export function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
    return (
        <h2 id={id} className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)] m-0">
            {children}
        </h2>
    );
}

export type NoticeTone = 'info' | 'warning' | 'error' | 'success';

const TONE_TEXT: Record<NoticeTone, string> = {
    info: 'text-[var(--info)]',
    warning: 'text-[var(--warning)]',
    error: 'text-[var(--error)]',
    success: 'text-[var(--success)]',
};

/** A notice strip: the icon carries the tone, the text stays readable ink. */
export function Notice({ tone = 'info', icon: Icon, children, action, testId, role }: {
    tone?: NoticeTone;
    icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
    children: React.ReactNode;
    action?: React.ReactNode;
    testId?: string;
    role?: 'alert' | 'status';
}) {
    return (
        <div
            role={role}
            data-testid={testId}
            className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
        >
            {Icon && <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${TONE_TEXT[tone]}`} aria-hidden="true" />}
            <div className="flex-1 min-w-0">{children}</div>
            {action && <div className="flex-shrink-0">{action}</div>}
        </div>
    );
}

/** An inline error line under a form or a list. */
export function ErrorText({ children, testId }: { children: React.ReactNode; testId?: string }) {
    if (!children) return null;
    return (
        <p role="alert" data-testid={testId} className="text-xs text-[var(--error-ink)] m-0">
            {children}
        </p>
    );
}

/** The spinner row a section shows while it loads. */
export function LoadingRow({ label }: { label: string }) {
    return (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--text-tertiary)]" role="status">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            <span>{label}</span>
        </div>
    );
}

/** A round member avatar with initials, and an optional presence dot. */
export function Avatar({ name, size = 'md', online = false, onlineLabel, className = '' }: {
    name?: string | null;
    size?: 'sm' | 'md';
    online?: boolean;
    onlineLabel?: string;
    className?: string;
}) {
    const box = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-8 h-8 text-[11px]';
    return (
        <span
            className={`relative inline-grid place-items-center rounded-full flex-shrink-0 font-semibold bg-[var(--bg-tertiary)] text-[var(--text-secondary)] ring-2 ring-[var(--bg-secondary)] ${box} ${className}`.trim()}
            title={name || undefined}
        >
            <span aria-hidden="true">{initialsOf(name)}</span>
            {online && (
                <span
                    className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[var(--success)] ring-2 ring-[var(--bg-secondary)]"
                    role="img"
                    aria-label={onlineLabel}
                />
            )}
        </span>
    );
}

/** A character counter that turns to the warning tone near the cap. */
export function CharCount({ value, max, id }: { value: string; max: number; id?: string }) {
    const near = value.length > max * 0.9;
    return (
        <span id={id} className={`text-[11px] tabular-nums ${near ? 'text-[var(--warning-ink)]' : 'text-[var(--text-tertiary)]'}`}>
            {value.length}/{max}
        </span>
    );
}
