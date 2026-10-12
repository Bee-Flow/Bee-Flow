import { AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react';
import React from 'react';

/**
 * The one notice look of the Solution screens: icon, text and an optional
 * action, on a card with a tone-coloured left bar. The tone is never the only
 * signal: the icon and the words carry the meaning too.
 */

export type NoticeTone = 'info' | 'warning' | 'error' | 'success';

const BAR: Record<NoticeTone, string> = {
    info: 'border-l-[var(--accent-primary)]',
    warning: 'border-l-[var(--warning)]',
    error: 'border-l-[var(--error)]',
    success: 'border-l-[var(--success)]',
};

const INK: Record<NoticeTone, string> = {
    info: 'text-[var(--accent-primary)]',
    warning: 'text-[var(--warning)]',
    error: 'text-[var(--error)]',
    success: 'text-[var(--success)]',
};

const ICON: Record<NoticeTone, LucideIcon> = {
    info: Info,
    warning: AlertTriangle,
    error: AlertTriangle,
    success: CheckCircle2,
};

export interface NoticeProps {
    tone?: NoticeTone;
    icon?: LucideIcon;
    /** Errors announce themselves (role=alert); the rest are plain status text. */
    children: React.ReactNode;
    action?: React.ReactNode;
    testId?: string;
    className?: string;
}

export default function Notice({ tone = 'info', icon, children, action, testId, className = '' }: NoticeProps) {
    const Icon = icon ?? ICON[tone];
    return (
        <div
            role={tone === 'error' ? 'alert' : 'status'}
            data-testid={testId}
            data-tone={tone}
            className={`flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] border-l-[3px] ${BAR[tone]} bg-[var(--bg-secondary)] text-[13px] text-[var(--text-primary)] ${className}`}
        >
            <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${INK[tone]}`} aria-hidden="true" />
            <div className="flex-1 min-w-[12rem] break-words">{children}</div>
            {action && <div className="flex-shrink-0">{action}</div>}
        </div>
    );
}
