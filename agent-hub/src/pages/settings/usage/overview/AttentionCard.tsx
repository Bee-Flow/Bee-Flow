import { useTranslation } from '@/hooks/useTranslation';
import { MoreLink } from '../shell';
import type { AttentionRow } from './attention';

interface AttentionCardProps {
    rows: AttentionRow[];
    onOpenTab: (tab: string, subTab?: string) => void;
}

/** Renders nothing without rows: an empty "needs attention" card would say the opposite of what it means. */
export function AttentionCard({ rows, onOpenTab }: AttentionCardProps) {
    const { t } = useTranslation();
    if (rows.length === 0) return null;
    return (
        <section aria-label={t('usage.ov_attention', 'Needs attention')} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-5 py-1.5">
            <ul className="m-0 list-none p-0">
                {rows.map(r => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-[var(--border-subtle)] py-1 last:border-b-0">
                        <span className="flex min-w-0 flex-[1_1_420px] items-center gap-2.5 text-[13px] text-[var(--text-primary)]">
                            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${r.tone === 'warn' ? 'bg-[var(--warning)]' : 'bg-[var(--text-tertiary)]'}`} />
                            {r.text}
                        </span>
                        <MoreLink label={r.moreLabel} onClick={() => onOpenTab(r.tab, r.subTab)} />
                    </li>
                ))}
            </ul>
        </section>
    );
}
