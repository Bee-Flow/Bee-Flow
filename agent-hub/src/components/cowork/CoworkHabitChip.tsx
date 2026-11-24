/**
 * "You ask this every Monday. Let Cowork do it?": the one offer "it notices what you repeat" makes
 * (server/core/cowork/habits/habitSignals.mts), mounted once next to the app's other global surfaces (AuthedApp.tsx)
 * and woken by the chat stream (hooks/useChatEngine/sse/handlers/cowork.ts). "Make it a cowork" opens Cowork with the
 * message as its brief, handed over in this tab's storage and never in the address (./coworkHandedBrief.ts);
 * nothing is created until the person confirms there. It never shows twice for one turn. It sits top right, under the
 * header, where it never covers the chat's composer at the bottom.
 */
import { useEffect, useState } from 'react';
import { navigate } from '../../router/history';
import { Repeat } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import { handBrief } from './coworkHandedBrief';

const DAYS: Array<[string, string]> = [
    ['cowork_habits.day.0', 'Sunday'], ['cowork_habits.day.1', 'Monday'], ['cowork_habits.day.2', 'Tuesday'], ['cowork_habits.day.3', 'Wednesday'],
    ['cowork_habits.day.4', 'Thursday'], ['cowork_habits.day.5', 'Friday'], ['cowork_habits.day.6', 'Saturday'],
];

interface Offer { weekday: number; brief: string }

/** Open the Cowork page with this brief in its box, set to run every week on that day (CoworkPage.tsx takes it once). */
function openCoworkWithBrief(brief: string, weekday: number): void {
    handBrief(brief, weekday);
    navigate('/app/cowork');
}

export default function CoworkHabitChip() {
    const { t } = useTranslation();
    const [offer, setOffer] = useState<Offer | null>(null);
    useEffect(() => {
        const hear = (e: Event) => {
            const detail = (e as CustomEvent<Offer>).detail;
            if (detail && typeof detail.brief === 'string' && typeof detail.weekday === 'number') setOffer(detail);
        };
        window.addEventListener('beeflow:cowork_suggestion', hear);
        return () => window.removeEventListener('beeflow:cowork_suggestion', hear);
    }, []);
    if (!offer) return null;
    const [key, en] = DAYS[offer.weekday] ?? DAYS[1];
    return (
        <div role="status" className="fixed top-16 right-4 left-4 sm:left-auto sm:max-w-sm z-40 rounded-xl border px-4 py-3 shadow-lg bg-[var(--bg-primary)] [border-color:var(--border-default)] flex flex-col gap-2" data-testid="cowork-habit-chip">
            <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--text-primary)]">
                <Repeat aria-hidden="true" className="w-4 h-4" />
                {t('cowork_habits.offer', 'You ask this every {day}. Let Cowork do it for you?', { day: t(key, en) })}
            </span>
            <div className="flex gap-2">
                <button type="button" className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)]" onClick={() => { setOffer(null); openCoworkWithBrief(offer.brief, offer.weekday); }}>
                    {t('cowork_habits.make', 'Make it a cowork')}
                </button>
                <button type="button" className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-[var(--text-secondary)]" onClick={() => setOffer(null)}>
                    {t('cowork_habits.not_now', 'Not now')}
                </button>
            </div>
        </div>
    );
}
