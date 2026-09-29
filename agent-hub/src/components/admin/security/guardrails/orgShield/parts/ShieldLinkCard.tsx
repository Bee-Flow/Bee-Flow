import type { LucideIcon } from 'lucide-react';
import { ArrowRight } from 'lucide-react';
import React from 'react';

/**
 * A card that is one big button to another pane: icon, title, one line of
 * summary, arrow. The whole card is the target, so there is no second,
 * smaller button inside it competing for the same click.
 */
export default function ShieldLinkCard({
    Icon, title, summary, onOpen,
}: {
    Icon: LucideIcon;
    title: string;
    summary: string;
    onOpen: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onOpen}
            className="w-full min-w-0 flex items-center gap-3 px-4 py-3.5 text-left rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-sm)] hover:bg-[var(--bg-card-hover)] hover:border-[var(--text-tertiary)] transition-colors"
        >
            <Icon className="w-4 h-4 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
            <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-semibold text-[var(--text-primary)]">{title}</span>
                <span className="block text-xs text-[var(--text-secondary)]">{summary}</span>
            </span>
            <ArrowRight className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
        </button>
    );
}
