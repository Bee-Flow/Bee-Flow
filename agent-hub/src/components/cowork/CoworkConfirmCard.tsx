/**
 * The ONE confirmation before a new task exists, under the home's composer (./CoworkHomeComposer.tsx): what Cowork
 * understood of the sentence, as the four questions every task answers, each of which can be changed here before
 * anything is made:
 *
 *   What      the task's name, editable in place;
 *   When      the day (or "Which day?" when the sentence did not say) and the time;
 *   Uses      the apps it may use, as chips (./CoworkConfirmRows.tsx);
 *   Sends to  "Me" and the addresses in the sentence, as chips, with "Show me each message first".
 *
 * "Set up and test" creates it with what the card shows; Cowork then sets up its steps and tests them once, which the
 * home shows. What the owner changed by hand lives with the composer (`choices`), so an edit of the sentence updates
 * the rows they did not touch and keeps the ones they did. What the card works out is ./coworkConfirmModel.ts.
 */
import { useState } from 'react';
import { SendsToRow, UsesRow } from './CoworkConfirmRows';
import { ENTER } from './coworkMotion';
import { ALERT, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, FIELD, FIELD_WIDE, LINK_INLINE, META } from './coworkUi';
import {
    dayChoiceOf, WEEK_DAYS, confirmView, dayWords, hasTimeOfDay, isClockPayload, needsDay, schedulePartOf, startPayload, timeOf, withDay, withTime,
    type ConfirmChoices, type ConfirmView, type DayChoice,
} from './coworkConfirmModel';
import CoworkTimeField from './CoworkTimeField';
import { repeatLabel } from './coworkSchedule';
import useCoworkApps from './useCoworkApps';
import type { UseCoworkComposerReturn } from './useCoworkComposer';
import { useEntitlements } from '../licensing/EntitlementsContext';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import type { CoworkPayload, CoworkTriggerPayload } from '@/api/cowork.types';

/** The weekday's own name, in the reader's language: Monday … Sunday (noon of a week that starts on a Monday). */
const weekdayName = (i: number, locale: string): string => new Date(2024, 0, 8 + i, 12).toLocaleDateString(locale, { weekday: 'long' });

/** The day to choose. `current`: what the card understood, kept selected while the owner changes it; '' when the sentence said no day. */
function DayPicker({ current, onPick, onLeave, t, locale }: { current: DayChoice | ''; onPick: (choice: DayChoice) => void; onLeave: () => void; t: TranslateFn; locale: string }) {
    return (
        <>
            <label htmlFor="cowork-confirm-day" className="sr-only">{t('cowork_home.confirm.which_day', 'Which day?')}</label>
            <select id="cowork-confirm-day" className={FIELD} value={current} onChange={(e) => { if (e.target.value) onPick(e.target.value as DayChoice); }} onBlur={onLeave}>
                {current === '' && <option value="">{t('cowork_home.confirm.which_day', 'Which day?')}</option>}
                <option value="once">{t('cowork_home.confirm.once', 'Just once, today')}</option>
                <option value="day">{repeatLabel('daily', t)}</option>
                <option value="weekdays">{repeatLabel('weekdays', t)}</option>
                {WEEK_DAYS.map((d, i) => <option key={d} value={d}>{t('cowork_home.confirm.every_day', 'Every {day}', { day: weekdayName(i, locale) })}</option>)}
            </select>
        </>
    );
}

interface WhenFieldProps {
    payload: CoworkPayload | CoworkTriggerPayload;
    asking: boolean;
    /** The sentence said no day: the picker starts empty. Else it starts at the day the card understood. */
    mustPick: boolean;
    setChanging: (changing: boolean) => void;
    onChoose: (change: Partial<ConfirmChoices>) => void;
}

/** When: the day (or "Which day?"), the time, and Change. */
function WhenField({ payload, asking, mustPick, setChanging, onChoose }: WhenFieldProps) {
    const { t, locale } = useTranslation();
    const clock = isClockPayload(payload) ? payload : null;
    const showTime = hasTimeOfDay(payload);
    const pick = (choice: DayChoice) => {
        if (!clock) return;
        onChoose({ schedule: schedulePartOf(withDay(clock, choice, timeOf(clock))) });
        setChanging(false);
    };
    return (
        <div className="min-w-0 flex flex-wrap items-center gap-2" data-testid="cowork-confirm-when">
            {asking ? <DayPicker current={clock && !mustPick ? dayChoiceOf(clock) : ''} onPick={pick} onLeave={() => setChanging(false)} t={t} locale={locale || 'en'} /> : <span>{dayWords(payload, t)}{showTime ? ` ${t('cowork_home.confirm.at', 'at')}` : ''}</span>}
            {clock && showTime && (
                <>
                    <label htmlFor="cowork-confirm-time" className="sr-only">{t('cowork_home.confirm.what_time', 'At what time?')}</label>
                    <CoworkTimeField id="cowork-confirm-time" value={timeOf(clock)} onChange={(time) => onChoose({ schedule: schedulePartOf(withTime(clock, time)) })} />
                </>
            )}
            {clock && !asking && <button type="button" className={LINK_INLINE} onClick={() => setChanging(true)}>{t('cowork_home.confirm.change', 'Change')}</button>}
        </div>
    );
}

const ROW_LABEL = 'text-[13px] leading-5 text-[var(--text-secondary)] sm:pt-2';
const ROW_VALUE = 'm-0 mb-3 sm:mb-0 min-w-0 text-[14px] font-medium text-[var(--text-primary)]';

/** What the card says under its rows: what is still asked, or what "Set up and test" does. */
function hintOf(asking: boolean, steps: boolean, t: TranslateFn): string {
    if (asking) return t('cowork_home.confirm.say_when', 'Your sentence does not say when. Pick a day and it is ready to start.');
    return steps
        ? t('cowork_home.confirm.after_set_up', 'Cowork sets up the steps and tests them once. Nothing is sent during the test, and it runs for real only after you approve the steps.')
        : t('cowork_home.confirm.after_start_ai', 'Your organisation has no fixed steps, so the AI works this task out on every run.');
}

/** Whether the organisation has automations: then a new task gets fixed steps, set up and tested before it runs. */
function useMayHaveSteps(): boolean {
    const ent = useEntitlements() as { loading: boolean; can?: (id: string) => boolean };
    return !ent.loading && typeof ent.can === 'function' && ent.can('automations');
}

export interface CoworkConfirmCardProps {
    cowork: UseCoworkComposerReturn;
    /** What the owner typed: the apps and the addresses it names are read from it. */
    sentence: string;
    /** What the owner changed by hand, and how they change more. */
    choices: ConfirmChoices;
    onChoose: (change: Partial<ConfirmChoices>) => void;
    /** The sentence was edited and is being read again. */
    rereading?: boolean;
    onStart: (payload: CoworkPayload | CoworkTriggerPayload) => void;
    onClarify: (detail: string) => void;
    onCancel: () => void;
}

interface RowsProps { view: ConfirmView; steps: boolean; asking: boolean; mustPick: boolean; setChanging: (changing: boolean) => void; onChoose: (change: Partial<ConfirmChoices>) => void; catalogue: ReadonlyArray<{ id: string; label: string }>; t: TranslateFn }

function ConfirmRows({ view, steps, asking, mustPick, setChanging, onChoose, catalogue, t }: RowsProps) {
    const clock = isClockPayload(view.payload);
    return (
        <dl className="grid grid-cols-1 sm:grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-1 sm:gap-y-3 items-start m-0">
            <dt className={ROW_LABEL}><label htmlFor="cowork-confirm-name">{t('cowork_home.confirm.what', 'What')}</label></dt>
            <dd className={ROW_VALUE}>
                <input id="cowork-confirm-name" type="text" maxLength={500} className={FIELD_WIDE} value={view.title} onChange={(e) => onChoose({ title: e.target.value })} data-testid="cowork-confirm-name" />
            </dd>
            <dt className={ROW_LABEL}>{t('cowork_home.confirm.when', 'When')}</dt>
            <dd className={ROW_VALUE}><WhenField payload={view.payload} asking={asking} mustPick={mustPick} setChanging={setChanging} onChoose={onChoose} /></dd>
            <dt className={ROW_LABEL}>{t('cowork_home.confirm.uses', 'Uses')}</dt>
            <dd className={ROW_VALUE}><UsesRow view={view} onChoose={onChoose} t={t} catalogue={catalogue} /></dd>
            <dt className={ROW_LABEL}>{t('cowork_home.confirm.sends_to', 'Sends to')}</dt>
            <dd className={`${ROW_VALUE} mb-0`}>
                {clock
                    ? <SendsToRow view={view} onChoose={onChoose} t={t} steps={steps} />
                    : <span data-testid="cowork-confirm-sends">{t('cowork_home.confirm.sends_sender', 'The sender of each mail, as a draft')}</span>}
            </dd>
        </dl>
    );
}

function targetQuestion(target: 'folder' | 'table' | 'recipient' | undefined, t: TranslateFn) {
    return target && {
        folder: t('cowork_home.confirm.target_folder', 'Which folder should receive the files?'),
        table: t('cowork_home.confirm.target_table', 'Which table should receive the rows?'),
        recipient: t('cowork_home.confirm.target_recipient', 'Who should receive the result?'),
    }[target];
}

export default function CoworkConfirmCard({ cowork, sentence, choices, onChoose, rereading = false, onStart, onClarify, onCancel }: CoworkConfirmCardProps) {
    const { t } = useTranslation();
    const steps = useMayHaveSteps();
    const { availableApps } = useCoworkApps();
    const [changing, setChanging] = useState(false);
    const [answer, setAnswer] = useState('');
    const draft = cowork.draft;
    if (!draft) return null;
    const catalogue = availableApps.filter((a) => !a.isStep);
    const view = confirmView(draft, choices, sentence, catalogue);
    // Only a sentence that said no day holds the start back; changing a day the card understood does not.
    const mustPick = needsDay(draft) && !choices.schedule;
    const target = draft.spec?.missingTarget;
    const question = targetQuestion(target, t);
    const asking = changing || mustPick;
    const busy = cowork.submitting || rereading;
    return (
        <section className={`${CARD} ${ENTER} p-4 flex flex-col gap-4`} aria-labelledby="cowork-confirm-heading" data-testid="cowork-confirm" data-tour="cowork-options">
            <h2 id="cowork-confirm-heading" className="m-0 text-[16px] leading-6 font-semibold text-[var(--text-primary)]">{t('cowork_home.confirm.heading', 'This is what I understood')}</h2>
            <ConfirmRows view={view} steps={steps} asking={asking} mustPick={mustPick} setChanging={setChanging} onChoose={onChoose} catalogue={catalogue} t={t} />
            {question && <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
                e.preventDefault();
                if (answer.trim() && !busy) { onClarify(question + ' ' + answer.trim()); setAnswer(''); }
            }}>
                <label>{question}<input className={FIELD_WIDE} value={answer} maxLength={300} onChange={(e) => setAnswer(e.target.value)} /></label>
                <button className={LINK_INLINE} disabled={busy || !answer.trim()}>{t('cowork_home.examples.next', 'Continue')}</button>
            </form>}
            <p className={META}>{hintOf(mustPick, steps, t)}</p>
            {rereading && <p role="status" className={META}>{t('cowork_home.confirm.rereading', 'Reading your sentence again…')}</p>}
            {cowork.error && <p role="alert" className={ALERT}>{cowork.error}</p>}
            <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={BUTTON_PRIMARY} data-testid="cowork-confirm-start" disabled={!!question || mustPick || busy} onClick={() => onStart(startPayload(view, steps))}>
                    {startLabel(cowork.submitting && !rereading, steps, t)}
                </button>
                <button type="button" className={BUTTON_SECONDARY} disabled={cowork.submitting && !rereading} onClick={onCancel}>{t('cowork_home.confirm.cancel', 'Cancel')}</button>
            </div>
        </section>
    );
}

function startLabel(starting: boolean, steps: boolean, t: TranslateFn): string {
    if (starting) return t('cowork_home.confirm.starting', 'Starting…');
    return steps ? t('cowork_home.confirm.set_up', 'Set up and test') : t('cowork_home.confirm.start_ai', 'Start');
}
