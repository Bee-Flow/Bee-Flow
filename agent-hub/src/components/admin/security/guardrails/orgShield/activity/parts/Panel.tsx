/**
 * The card shell and small type the "What happened" pane is built from, so
 * every card has the same border, radius, shadow and header rhythm.
 */

import type { LucideIcon } from 'lucide-react';
import React from 'react';

export function Panel({ className = '', children, label }: { className?: string; children: React.ReactNode; label?: string }) {
    return (
        <section
            aria-label={label}
            className={`min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-sm)] ${className}`}
        >
            {children}
        </section>
    );
}

interface HeadProps {
    icon?: LucideIcon;
    title: React.ReactNode;
    hint?: React.ReactNode;
    right?: React.ReactNode;
    className?: string;
}

/** Icon, title, a dim hint, and whatever sits on the right. */
export function PanelHead({ icon: Icon, title, hint, right, className = 'px-[18px] pt-3.5 pb-2.5' }: HeadProps) {
    return (
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}>
            {Icon && <Icon className="h-[15px] w-[15px] shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />}
            <h3 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
            {hint && <span className="text-xs text-[var(--text-tertiary)]">{hint}</span>}
            {right && <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">{right}</span>}
        </div>
    );
}

/** The small uppercase label above a block ("In short", "Worth a look"). */
export function Eyebrow({ children }: { children: React.ReactNode }) {
    return (
        <span className="text-[11px] font-bold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">{children}</span>
    );
}
