import React from 'react';
import { CircleCheck, CircleSlash, CircleX, Hourglass, Loader2 } from 'lucide-react';
import type { RunTone } from './runOutcome';

const ICONS = {
    success: { Icon: CircleCheck, cls: 'text-[var(--success)]' },
    error: { Icon: CircleX, cls: 'text-[var(--error)]' },
    waiting: { Icon: Hourglass, cls: 'text-[var(--warning)]' },
    running: { Icon: Loader2, cls: 'text-[var(--accent-primary)] animate-spin' },
    neutral: { Icon: CircleSlash, cls: 'text-[var(--text-tertiary)]' },
} as const;

/** The run's status as one icon: the list row and the detail header. */
export default function RunStatusIcon({ tone, size = 16 }: { tone: RunTone; size?: number }) {
    const { Icon, cls } = ICONS[tone] || ICONS.neutral;
    return <Icon size={size} aria-hidden data-tone={tone} className={`shrink-0 ${cls}`} />;
}

const BAR_CLS: Record<string, string> = {
    success: 'bg-[var(--success)]',
    pinned: 'bg-[var(--success)]',
    handled_error: 'bg-[var(--warning)]',
    skipped: 'bg-[var(--border-default)]',
    error: 'bg-[var(--error)]',
    failed: 'bg-[var(--error)]',
    waiting: 'bg-[var(--warning)]',
    awaiting_approval: 'bg-[var(--warning)]',
    awaiting_form: 'bg-[var(--warning)]',
    awaiting_confirm: 'bg-[var(--warning)]',
    running: 'bg-[var(--accent-primary)]',
};

/** One small bar per step, coloured by how that step went. */
export function StepBars({ statuses }: { statuses: string[] }) {
    if (!statuses.length) return null;
    return (
        <span className="inline-flex gap-0.5 shrink-0" aria-hidden>
            {statuses.map((s, i) => (
                // Bars have no identity beyond their position.
                <span key={i} data-bar={s} className={`w-3.5 h-1 rounded-sm ${BAR_CLS[s] || 'bg-[var(--bg-tertiary)]'}`} />
            ))}
        </span>
    );
}
