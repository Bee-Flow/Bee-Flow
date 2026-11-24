/**
 * The ONE confirmation before a new task exists, under the home's composer (./CoworkHomeComposer.tsx): its title,
 * then When (with "Which day?" when the sentence did not say, and the time), Uses (the apps it may use), Sends to,
 * and Start / Cancel. Start creates it; Cowork then sets up its steps and tests them once, which the home shows.
 * What it works out of the draft is ./coworkConfirmModel.ts.
 */
import { useState } from 'react';
import { CARD, FIELD, LINK_BUTTON, PILL_PRIMARY, PILL_QUIET } from './coworkUi';
import { WEEK_DAYS, appsNamedIn, dayWords, hasTimeOfDay, isClockPayload, needsDay, sendsToWords, timeOf, withDay, withTime, type DayChoice } from './coworkConfirmModel';
import { repeatLabel } from './coworkSchedule';
import useCoworkApps from './useCoworkApps';
import type { UseCoworkComposerReturn } from './useCoworkComposer';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

/**
 * "Fireflies.ai": the apps the task was given, or (when it was given none of its own) only the apps the sentence names.
 * Never the whole workspace: which apps the steps really use is shown, and checked, once Cowork has set them up.
 */
function UsesLine({ enabledApps, brief, t }: { enabledApps: string[] | null; brief: string; t: TranslateFn }) {
    const { availableApps, isAppEnabled } = useCoworkApps({ value: enabledApps });
    const apps = availableApps.filter((a) => !a.isStep && isAppEnabled(a.id));
    let text: string;
    if (Array.isArray(enabledApps) && enabledApps.length === 0) text = t('cowork_home.confirm.no_apps', 'No apps. The AI only writes.');
    else if (Array.isArray(enabledApps) && apps.length > 0) text = apps.map((a) => a.label).join(', ');
    else {
        const named = appsNamedIn(brief, apps).map((a) => a.label);
        text = named.length > 0
            ? t('cowork_home.confirm.named_apps', '{apps}, and what else the steps turn out to need', { apps: named.join(', ') })
            : t('cowork_home.confirm.picks_apps', 'Cowork picks the apps it needs while it sets up the steps. You see them before anything runs.');
    }
    return <span data-testid="cowork-confirm-uses">{text}</span>;
}

/** The weekday's own name, in the reader's language: Monday … Sunday (noon of a week that starts on a Monday). */
const weekdayName = (i: number, locale: string): string => new Date(2024, 0, 8 + i, 12).toLocaleDateString(locale, { weekday: 'long' });

function DayPicker({ onPick, t, locale }: { onPick: (choice: DayChoice) => void; t: TranslateFn; locale: string }) {
    return (
        <>
            <label htmlFor="cowork-confirm-day" className="sr-only">{t('cowork_home.confirm.which_day', 'Which day?')}</label>
            <select id="cowork-confirm-day" className={FIELD} value="" onChange={(e) => { if (e.target.value) onPick(e.target.value as DayChoice); }}>
                <option value="">{t('cowork_home.confirm.which_day', 'Which day?')}</option>
                <option value="once">{t('cowork_home.confirm.once', 'Just once, today')}</option>
                <option value="day">{repeatLabel('daily', t)}</option>
                <option value="weekdays">{repeatLabel('weekdays', t)}</option>
                {WEEK_DAYS.map((d, i) => <option key={d} value={d}>{t('cowork_home.confirm.every_day', 'Every {day}', { day: weekdayName(i, locale) })}</option>)}
            </select>
        </>
    );
}

interface WhenFieldProps {
    cowork: UseCoworkComposerReturn;
    asking: boolean;
    setAsking: (asking: boolean) => void;
}

/** When: the day (or "Which day?"), the time, and Change. */
function WhenField({ cowork, asking, setAsking }: WhenFieldProps) {
    const { t, locale } = useTranslation();
    const payload = cowork.draft?.payload;
    if (!payload) return null;
    const clock = isClockPayload(payload) ? payload : null;
    const showTime = hasTimeOfDay(payload);
    const pick = (choice: DayChoice) => {
        if (!clock) return;
        cowork.amend(withDay(clock, choice, timeOf(clock)));
        setAsking(false);
    };
    return (
        <dd className="m-0 mb-2.5 sm:mb-0 min-w-0 flex flex-wrap items-center gap-2 text-[15px] font-semibold text-[var(--text-primary)]" data-testid="cowork-confirm-when">
            {asking ? <DayPicker onPick={pick} t={t} locale={locale || 'en'} /> : <span>{dayWords(payload, t)}{showTime ? ` ${t('cowork_home.confirm.at', 'at')}` : ''}</span>}
            {clock && showTime && (
                <>
                    <label htmlFor="cowork-confirm-time" className="sr-only">{t('cowork_home.confirm.what_time', 'At what time?')}</label>
                    <input id="cowork-confirm-time" type="time" className={FIELD} value={timeOf(clock)} onChange={(e) => cowork.amend(withTime(clock, e.target.value || '09:00'))} />
                </>
            )}
            {clock && !asking && <button type="button" className={LINK_BUTTON} onClick={() => setAsking(true)}>{t('cowork_home.confirm.change', 'Change')}</button>}
        </dd>
    );
}

export default function CoworkConfirmCard({ cowork, onStart }: { cowork: UseCoworkComposerReturn; onStart: () => void }) {
    const { t } = useTranslation();
    const draft = cowork.draft;
    const [asking, setAsking] = useState(() => !!draft && needsDay(draft));
    if (!draft) return null;
    const { payload } = draft;
    return (
        <section className={`${CARD} p-5 flex flex-col gap-4`} aria-labelledby="cowork-confirm-heading" data-testid="cowork-confirm">
            <h2 id="cowork-confirm-heading" className="text-[20px] font-semibold text-[var(--text-primary)]">{payload.title || t('cowork_home.confirm.new_task', 'New task')}</h2>
            <dl className="grid grid-cols-1 sm:grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-1 sm:gap-y-3 items-center m-0">
                <dt className="text-[14px] text-[var(--text-tertiary)]">{t('cowork_home.confirm.when', 'When')}</dt>
                <WhenField cowork={cowork} asking={asking} setAsking={setAsking} />
                <dt className="text-[14px] text-[var(--text-tertiary)]">{t('cowork_home.confirm.uses', 'Uses')}</dt>
                <dd className="m-0 mb-2.5 sm:mb-0 min-w-0 text-[15px] font-semibold text-[var(--text-primary)]"><UsesLine enabledApps={payload.enabledApps ?? null} brief={payload.prompt ?? ''} t={t} /></dd>
                <dt className="text-[14px] text-[var(--text-tertiary)]">{t('cowork_home.confirm.sends_to', 'Sends to')}</dt>
                <dd className="m-0 min-w-0 text-[15px] font-semibold text-[var(--text-primary)] break-words" data-testid="cowork-confirm-sends">{sendsToWords(draft, t)}</dd>
            </dl>
            <p className="text-[14px] text-[var(--text-tertiary)]">
                {asking
                    ? t('cowork_home.confirm.say_when', 'Your sentence does not say when. Pick a day and it is ready to start.')
                    : t('cowork_home.confirm.after_start', 'After you start, Cowork sets up the steps and tests them once. Nothing is sent during the test.')}
            </p>
            {cowork.error && <p role="alert" className="text-[13px] text-[var(--error-ink)]">{cowork.error}</p>}
            <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={PILL_PRIMARY} data-testid="cowork-confirm-start" disabled={asking || cowork.submitting} onClick={onStart}>
                    {cowork.submitting ? t('cowork_home.confirm.starting', 'Starting…') : t('cowork_home.confirm.start', 'Start')}
                </button>
                <button type="button" className={PILL_QUIET} disabled={cowork.submitting} onClick={cowork.reset}>{t('cowork_home.confirm.cancel', 'Cancel')}</button>
            </div>
        </section>
    );
}
