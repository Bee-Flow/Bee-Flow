import React from 'react';

export interface SettingsNavItem { id: string; label: string }

/**
 * In-page navigation of the Settings tab: a sticky vertical list from 1024px,
 * a horizontally scrolling pill row below. Both are the same buttons; they jump
 * to the section card and never change what is shown.
 */
export default function SettingsNav({ items, label }: { items: SettingsNavItem[]; label: string }) {
    const go = (id: string) => {
        const el = document.getElementById(`settings-${id}`);
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    };
    return (
        <nav aria-label={label} className="lg:sticky lg:top-24 lg:self-start" data-testid="settings-nav">
            <ul className="flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-visible pb-1 lg:pb-0">
                {items.map(item => (
                    <li key={item.id} className="shrink-0">
                        <button
                            type="button"
                            onClick={() => go(item.id)}
                            data-testid={`settings-nav-${item.id}`}
                            className="w-full min-h-10 px-3 rounded-full lg:rounded-[var(--radius-sm)] text-xs font-medium text-left whitespace-nowrap text-[var(--text-secondary)] bg-[var(--bg-tertiary)] lg:bg-transparent hover:text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                        >
                            {item.label}
                        </button>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
