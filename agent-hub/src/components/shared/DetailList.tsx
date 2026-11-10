// The left column of a list + detail section (AI providers, transcription
// engines, ...): grouped rows with an icon, a name, an optional count or label
// and a dot that says whether the entry is live. The caller owns the selection.

import type { ReactNode } from 'react';
import { DOT_LIVE, DOT_OFF, EYEBROW } from '@/components/mcpLibrary/ui';

interface DetailListRowProps {
    icon: ReactNode;
    iconClass?: string;
    name: string;
    live: boolean;
    /** Small text right of the name (a model count, "Active"). */
    meta?: ReactNode;
    active: boolean;
    onClick: () => void;
}

export function DetailListRow({ icon, iconClass = '', name, live, meta, active, onClick }: DetailListRowProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? 'true' : undefined}
            className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text-primary)] ${active ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-secondary)]'}`}
        >
            <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs ${iconClass}`}>{icon}</span>
            <span className="truncate">{name}</span>
            {meta ? <span className="ml-auto shrink-0 text-[11px] text-[var(--text-tertiary)]">{meta}</span> : null}
            <span className={`${live ? DOT_LIVE : DOT_OFF} ${meta ? '' : 'ml-auto'}`} aria-hidden="true" />
        </button>
    );
}

/** A titled run of rows, a region named by its title. */
export function DetailListGroup({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-0.5" aria-label={title}>
            <div className="flex items-center gap-1.5 px-1 pt-2">
                <h3 className={EYEBROW}>{title}</h3>
                {count != null ? <span className="ml-auto text-[10px] text-[var(--text-secondary)]">{count}</span> : null}
            </div>
            {children}
        </section>
    );
}

/** The column itself: a named navigation, beside the detail from md up and above it below. */
export function DetailListNav({ label, children }: { label: string; children: ReactNode }) {
    return (
        <nav aria-label={label} className="flex w-full shrink-0 flex-col gap-1 overflow-y-auto border-b border-[var(--border-default)] pb-3 md:w-60 md:border-b-0 md:border-r md:pb-0 md:pr-3">
            {children}
        </nav>
    );
}

/** List on the left, detail on the right. */
export function DetailLayout({ list, children }: { list: ReactNode; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-4 md:flex-row">
            {list}
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}
