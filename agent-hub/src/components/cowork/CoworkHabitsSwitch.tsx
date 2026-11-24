/**
 * "Notice what I ask again and again", at the foot of the Cowork home (./CoworkHome.tsx): off until the person switches
 * it on, and not shown where the organisation does not allow it. What it keeps is said next to the switch, in plain
 * words; switching it off forgets it (server/core/cowork/habits/habitSignals.mts).
 */
import { useCoworkHabits } from '../../api/coworkHabits';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';

export default function CoworkHabitsSwitch() {
    const { t } = useTranslation();
    const { query, set } = useCoworkHabits();
    const state = query.data;
    if (!state?.allowed) return null;
    return (
        <div className="mt-4 px-[18px] flex flex-col gap-1" data-testid="cowork-habits">
            <label className="inline-flex items-center gap-2 text-[12.5px] text-[var(--text-primary)]">
                <input type="checkbox" checked={state.on} disabled={set.isPending} onChange={(e) => set.mutate(e.target.checked)} />
                {t('cowork_habits.switch', 'Notice what I ask again and again')}
            </label>
            <span className="text-[12px] text-[var(--text-tertiary)]">
                {t('cowork_habits.switch_hint', 'Cowork keeps only which apps a chat used and on which weekday, never what you asked. After four weeks in a row it offers once to do it for you. Switching it off forgets it all.')}
            </span>
            {set.error && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(set.error)}</p>}
        </div>
    );
}
