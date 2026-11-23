/**
 * "Needs you": the one place on an item (./CoworkDetail.tsx) where everything that waits for its owner shows up, above
 * the brief. Today that is the runs that asked to be reviewed (./CoworkReviewQueue.tsx). The same strip is the slot for
 * what comes next, such as a plan to approve or a repair that is ready: each is one more entry, never a new box
 * somewhere else on the page.
 *
 * Renders nothing while nothing waits. The header's badge counts the same entries and brings the reader here.
 */
import { AlertCircle } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from '@/hooks/useTranslation';

export interface NeedsEntry {
    /** Stable name of the kind of thing that waits ('review', later 'plan', 'repair'). */
    key: string;
    /** How many things of this kind wait; the header badge adds these up. */
    count: number;
    /** What the owner reads and acts on. */
    content: ReactNode;
}

/** The sum the header badge shows. */
export function needsCount(entries: readonly NeedsEntry[]): number {
    return entries.reduce((sum, entry) => sum + Math.max(0, entry.count), 0);
}

interface CoworkNeedsStripProps {
    entries: readonly NeedsEntry[];
    /** The strip itself, so the header's badge can scroll to it and move focus there. */
    ref?: Ref<HTMLElement>;
}

export default function CoworkNeedsStrip({ entries, ref }: CoworkNeedsStripProps) {
    const { t } = useTranslation();
    const waiting = entries.filter((entry) => entry.count > 0);
    if (waiting.length === 0) return null;
    return (
        <section
            ref={ref}
            tabIndex={-1}
            data-testid="cowork-needs-strip"
            aria-label={t('cowork_detail.needs.heading', 'Needs you')}
            className="flex flex-col gap-2 scroll-mt-4 focus:outline-none"
        >
            <h3 className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)]">
                <AlertCircle aria-hidden="true" className="w-3.5 h-3.5 text-[var(--warning-ink)]" />
                {t('cowork_detail.needs.heading', 'Needs you')}
            </h3>
            {waiting.map((entry) => <div key={entry.key} data-testid={`cowork-needs-${entry.key}`}>{entry.content}</div>)}
        </section>
    );
}
