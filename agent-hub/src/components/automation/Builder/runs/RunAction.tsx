import React from 'react';
import type { LucideIcon } from 'lucide-react';

const ACTION_BTN = 'inline-flex items-center justify-center gap-1.5 h-[30px] min-w-[30px] px-2 @[1100px]/rundetail:px-2.5 rounded-lg border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] whitespace-nowrap disabled:opacity-50';

interface ActionProps {
    icon: LucideIcon;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    expanded?: boolean;
    /** Shown on hover instead of the label, e.g. why the action is disabled. */
    hint?: string;
}

/**
 * One next move on a run. A run pane under 1100px wide (a screen up to ~1536px)
 * shows the icon alone, named for screen readers and on hover, so the run's
 * sentence keeps the room; wider panes show the words too.
 */
export default function RunAction({ icon: Icon, label, onClick, disabled = false, expanded, hint }: ActionProps) {
    return (
        <button
            type="button"
            className={ACTION_BTN}
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            aria-expanded={expanded}
            title={hint || label}
        >
            <Icon size={14} aria-hidden className="shrink-0" />
            <span className="hidden @[1100px]/rundetail:inline">{label}</span>
        </button>
    );
}
