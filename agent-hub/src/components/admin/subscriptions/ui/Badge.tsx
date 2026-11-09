import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

// The console's status chip, on the theme's status tokens. The tone names
// stay as the callers know them; `sky` and `teal` were extra hues for "info"
// and now read as info.
const TONES = {
    neutral: 'border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
    info:    'border-transparent bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-[var(--info-ink)]',
    sky:     'border-transparent bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-[var(--info-ink)]',
    success: 'border-transparent bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]',
    warning: 'border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]',
    danger:  'border-transparent bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)]',
    teal:    'border-transparent bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-[var(--info-ink)]',
};

export type BadgeTone = keyof typeof TONES;

interface BadgeProps {
    tone?: BadgeTone;
    icon?: LucideIcon;
    children?: ReactNode;
    className?: string;
    size?: 'sm' | 'md';
}

export function Badge({ tone = 'neutral', icon: Icon, children, className = '', size = 'md' }: BadgeProps) {
    const dim = size === 'sm' ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-1 px-2 py-[3px] text-[11px]';
    return (
        <span className={`inline-flex items-center whitespace-nowrap rounded-full border font-medium ${dim} ${TONES[tone]} ${className}`}>
            {Icon && <Icon className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} aria-hidden="true" />}
            {children}
        </span>
    );
}

const DOTS: Record<BadgeTone, string> = {
    neutral: 'bg-[var(--text-tertiary)]',
    info: 'bg-[var(--info)]',
    sky: 'bg-[var(--info)]',
    success: 'bg-[var(--success)]',
    warning: 'bg-[var(--warning)]',
    danger: 'bg-[var(--error)]',
    teal: 'bg-[var(--info)]',
};

export function Dot({ tone = 'neutral', className = '' }: { tone?: BadgeTone; className?: string }) {
    return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOTS[tone]} ${className}`} />;
}
