import { Loader2, type LucideIcon } from 'lucide-react';
import React from 'react';

/**
 * Small building blocks the Flow, Overview and Blueprint tabs share, so they
 * wear the same card recipe as the rest of the Solution screens.
 */

export const CARD = 'bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] p-4 lg:p-5';
export const ROW = 'bg-[var(--bg-secondary)] rounded-[var(--radius-md)]';

export function TabCard({ title, icon: Icon, children }: { title: string; icon?: LucideIcon; children: React.ReactNode }) {
    return (
        <section className={CARD}>
            <h3 className="flex items-center gap-2 text-[15px] font-semibold text-[var(--text-primary)] mb-3">
                {Icon && <Icon className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />}
                {title}
            </h3>
            {children}
        </section>
    );
}

/** A quiet line for a section that has nothing to list. */
export function TabNote({ children }: { children: React.ReactNode }) {
    return (
        <p className={`px-3 py-2.5 ${ROW} text-xs text-[var(--text-tertiary)]`}>{children}</p>
    );
}

export function TabSpinner() {
    return (
        <div className="flex items-center justify-center py-16 text-[var(--text-tertiary)]" aria-busy="true" role="status">
            <Loader2 className="w-5 h-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        </div>
    );
}
