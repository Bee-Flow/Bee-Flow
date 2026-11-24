/**
 * Cowork's home, above the composer when no item is open (./CoworkPage.tsx): what waits for the owner
 * (./CoworkNeedsYou.tsx), the owner's day as one timeline, the desks the owner is on (./CoworkDesks.tsx), and what
 * Cowork cost in AI this month.
 */
import { CalendarDays } from 'lucide-react';
import CoworkDesks from './CoworkDesks';
import CoworkNeedsYou from './CoworkNeedsYou';
import CoworkSharedWithMe from './CoworkSharedWithMe';
import CoworkHabitsSwitch from './CoworkHabitsSwitch';
import { todayWords } from './coworkHomeModel';
import { useCoworkHome } from '../../api/coworkHome';
import { useTranslation } from '../../hooks/useTranslation';
import { formatCostCents } from '../../utils/formatCost';
import type { TodayEntry } from '../../api/coworkHome';

const timeOf = (iso: string | null, locale: string): string => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};

function Today({ entries, onOpen, locale }: { entries: TodayEntry[]; onOpen: (itemId: string) => void; locale: string }) {
    const { t } = useTranslation();
    if (entries.length === 0) return null;
    return (
        <section className="mb-4 px-[18px]" aria-labelledby="cowork-today-heading" data-testid="cowork-today">
            <h2 id="cowork-today-heading" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)] mb-1">
                <CalendarDays aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork.today.heading', 'Today')}
            </h2>
            <ol className="flex flex-col">
                {entries.map((entry) => (
                    <li key={`${entry.kind}-${entry.runId ?? entry.itemId}-${entry.at ?? ''}`} data-testid="cowork-today-entry" data-kind={entry.kind}>
                        <button type="button" className="w-full flex items-baseline gap-3 py-1 text-left text-[12px] hover:text-[var(--text-primary)]" onClick={() => onOpen(entry.itemId)}>
                            <span className="min-w-[4.75rem] flex-shrink-0 whitespace-nowrap tabular-nums text-[var(--text-tertiary)]" data-testid="cowork-today-time">{timeOf(entry.at, locale)}</span>
                            <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">{entry.title || t('cowork_needs.untitled', 'Untitled work')}</span>
                            <span className={entry.kind === 'next' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}>{todayWords(entry, t)}</span>
                        </button>
                    </li>
                ))}
            </ol>
        </section>
    );
}

export default function CoworkHome({ onOpen, reloadKey = 0 }: { onOpen: (itemId: string) => void; reloadKey?: number }) {
    const { t, locale } = useTranslation();
    const home = useCoworkHome(reloadKey).data;
    const lang = locale || 'en';
    return (
        <>
            <CoworkNeedsYou onOpen={onOpen} reloadKey={reloadKey} />
            {Array.isArray(home?.today) && <Today entries={home.today} onOpen={onOpen} locale={lang} />}
            <CoworkSharedWithMe />
            <CoworkDesks onOpen={onOpen} />
            {home?.cost && home.cost.calls > 0 && (
                <p className="mb-4 px-[18px] text-[12px] text-[var(--text-tertiary)]" data-testid="cowork-cost-month">
                    {t('cowork.home.cost_month', 'AI this month: {cost}', { cost: formatCostCents(home.cost.byCurrency, lang) })}
                </p>
            )}
            <CoworkHabitsSwitch />
        </>
    );
}
