/** The orb asks for missing details. The editable task review belongs to Advanced. */
import { useId, useState } from 'react';
import { useReadableTables } from '@/api/coworkStart';
import { SendsToRow, UsesRow } from './CoworkConfirmRows';
import { ENTER } from './coworkMotion';
import { ALERT, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, FIELD, FIELD_WIDE, LINK_INLINE, META } from './coworkUi';
import {
    canTestDraft, dayChoiceOf, WEEK_DAYS, confirmView, dayWords, hasTimeOfDay, isAddress, isClockPayload, scheduleInputs, missingDestination, needsScheduleAnswer, schedulePartOf, startPayload, timeOf, withDay, withTime,
    type ConfirmChoices, type ConfirmView, type DayChoice,
} from './coworkConfirmModel';
import CoworkActivity from './CoworkActivity';
import CoworkBriefQuestion from './CoworkBriefQuestion';
import CoworkScheduleQuestion from './CoworkScheduleQuestion';
import CoworkTimeField from './CoworkTimeField';
import { repeatLabel } from './coworkSchedule';
import useCoworkApps from './useCoworkApps';
import type { CoworkDraft, UseCoworkComposerReturn } from './useCoworkComposer';
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
    setChanging: (changing: boolean) => void;
    onChoose: (change: Partial<ConfirmChoices>) => void;
}

/** When: the day (or "Which day?"), the time, and Change. */
function WhenField({ payload, asking, setChanging, onChoose }: WhenFieldProps) {
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
            {asking ? <DayPicker current={clock ? dayChoiceOf(clock) : ''} onPick={pick} onLeave={() => setChanging(false)} t={t} locale={locale || 'en'} /> : <span>{dayWords(payload, t)}{showTime ? ` ${t('cowork_home.confirm.at', 'at')}` : ''}</span>}
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
function hintOf(steps: boolean, t: TranslateFn): string {
    return steps
        ? t('cowork_home.confirm.after_set_up', 'Cowork sets up the steps and tests them once. Nothing is sent during the test, and it runs for real only after you approve the steps.')
        : t('cowork_home.confirm.after_start_ai', 'Your organisation has no fixed steps, so the AI works this task out on every run.');
}

/** Whether the organisation has automations: then a new task gets fixed steps, set up and tested before it runs. */
export function useMayHaveSteps(): boolean {
    const ent = useEntitlements() as { loading: boolean; can?: (id: string) => boolean };
    return !ent.loading && typeof ent.can === 'function' && ent.can('automations');
}

export interface CoworkConfirmCardProps {
    advanced: boolean;
    onAdvanced: () => void;
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

interface RowsProps { view: ConfirmView; steps: boolean; asking: boolean; setChanging: (changing: boolean) => void; onChoose: (change: Partial<ConfirmChoices>) => void; catalogue: ReadonlyArray<{ id: string; label: string }>; t: TranslateFn }

function ConfirmRows({ view, steps, asking, setChanging, onChoose, catalogue, t }: RowsProps) {
    const clock = isClockPayload(view.payload);
    return (
        <dl className="grid grid-cols-1 sm:grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-1 sm:gap-y-3 items-start m-0">
            <dt className={ROW_LABEL}><label htmlFor="cowork-confirm-name">{t('cowork_home.confirm.what', 'Task name')}</label></dt>
            <dd className={ROW_VALUE}>
                <input id="cowork-confirm-name" type="text" maxLength={500} className={FIELD_WIDE} value={view.title} onChange={(e) => onChoose({ title: e.target.value })} data-testid="cowork-confirm-name" />
            </dd>
            <dt className={ROW_LABEL}>{t('cowork_home.confirm.when', 'When')}</dt>
            <dd className={ROW_VALUE}><WhenField payload={view.payload} asking={asking} setChanging={setChanging} onChoose={onChoose} /></dd>
            <dt className={ROW_LABEL}>{t('cowork_home.confirm.uses', 'Uses')}</dt>
            <dd className={ROW_VALUE}><UsesRow view={view} onChoose={onChoose} t={t} catalogue={catalogue} /></dd>
            {view.deliveryRequested && clock ? <>
            <dt className={ROW_LABEL}>{t('cowork_home.confirm.sends_to', 'Sends to')}</dt>
            <dd className={`${ROW_VALUE} mb-0`}>
                <SendsToRow view={view} onChoose={onChoose} t={t} steps={steps} />
            </dd>
            </> : <>
                <dt className={ROW_LABEL}>{t('cowork_home.confirm.result', 'Result')}</dt>
                <dd className={ROW_VALUE}>{clock ? t('cowork_home.confirm.in_task', 'Available in this Cowork task') : t('cowork_home.confirm.sends_sender', 'The sender of each mail, as a draft')}</dd>
            </>}
        </dl>
    );
}

function ReviewSummary({ view, steps, t }: Pick<RowsProps, 'view' | 'steps' | 't'>) {
    const { payload, recipients } = view;
    const names = [...(recipients.me ? [t('cowork_home.confirm.me', 'Me')] : []), ...recipients.others];
    const delivery = !isClockPayload(payload) ? t('cowork_home.confirm.sends_sender', 'The sender of each mail, as a draft')
        : names.length ? [t('cowork_home.confirm.sends_to', 'Sends to'), names.join(', ')].join(' · ')
            : t('cowork_home.confirm.in_task', 'Available in this Cowork task');
    return <div className="grid gap-1">

        <p className={META}>{dayWords(payload, t)} {isClockPayload(payload) && hasTimeOfDay(payload) && timeOf(payload)}</p>
        <p className={META}>{delivery}</p>
        {view.sendsToOthers && <p className={META}>{steps && view.showFirst
            ? t('cowork_home.confirm.show_first_on', 'Nothing goes to someone else before you have seen it, under Needs you.')
            : steps ? t('cowork_home.confirm.show_first_off', 'Cowork still shows you each message at first. After 10 runs you let through, you can choose “Don’t ask” in the task.')
                : t('cowork_home.confirm.sends_ai', 'The AI sends what it writes by itself. Showing you each message first needs fixed steps, which your organisation does not have.')}</p>}
    </div>;
}

function ReviewFields(props: RowsProps) {
    return <>
        <details className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2 text-[13px]">
            <summary className="cursor-pointer font-medium">{props.t('cowork_home.confirm.instructions', 'View task instructions')}</summary>
            <p className="mt-2 whitespace-pre-wrap break-words text-[var(--text-secondary)]">{props.view.payload.prompt}</p>
        </details>
        <ConfirmRows {...props} />
    </>;
}

function targetQuestion(target: 'folder' | 'table' | 'recipient', t: TranslateFn) {
    return {
        folder: t('cowork_home.confirm.target_folder', 'Which folder should receive the files?'),
        table: t('cowork_home.confirm.target_table', 'Which table should receive the rows?'),
        recipient: t('cowork_home.confirm.target_recipient', 'Who should receive the result?'),
    }[target];
}

function AskDestination({ target, onAnswer, onCancel, submitLabel, t }: {
    target: 'folder' | 'table' | 'recipient'; onAnswer: (answer: string) => void; onCancel: () => void; submitLabel: string; t: TranslateFn;
}) {
    const [answer, setAnswer] = useState('');
    const tables = useReadableTables(target === 'table');
    const list = useId();
    const question = targetQuestion(target, t);
    const me = t('cowork_home.confirm.me', 'Me');
    const valid = target === 'recipient' ? answer === me || isAddress(answer) : !!answer.trim();
    return <CoworkActivity message={question} work={{ action: 'ask' }} tone="rest" testId="cowork-confirm">
        <form className="flex flex-wrap justify-center items-center gap-2" onSubmit={event => {
            event.preventDefault();
            if (valid) onAnswer(answer.trim());
        }}>
            <label><span className="sr-only">{question}</span>
                <input className={FIELD_WIDE} list={list} value={answer} maxLength={300} onChange={event => setAnswer(event.target.value)}
                    placeholder={target === 'recipient' ? t('cowork_home.confirm.address_placeholder', 'name@example.com') : undefined} />
            </label>
            <datalist id={list}>
                {target === 'table' && tables.data?.map(table => <option key={table.id} value={table.name || table.id} />)}
                {target === 'recipient' && <option value={me} />}
            </datalist>
            <button type="button" className={LINK_INLINE} onClick={onCancel}>{t('cowork_home.confirm.cancel', 'Cancel')}</button>
            <button className={BUTTON_PRIMARY} disabled={!valid}>{submitLabel}</button>
        </form>
    </CoworkActivity>;
}

function scheduleToAsk(draft: CoworkDraft, choices: ConfirmChoices) {
    if (choices.schedule || !isClockPayload(draft.payload)) return null;
    return needsScheduleAnswer(draft) ? draft.payload : null;
}

type DraftProps = CoworkConfirmCardProps & {
    draft: CoworkDraft; view: ConfirmView; steps: boolean; catalogue: RowsProps['catalogue']; t: TranslateFn;
};

function DraftReview({ advanced, onAdvanced, cowork, view, steps, catalogue, onChoose, rereading, onStart, onCancel, t }: DraftProps) {
    const [changing, setChanging] = useState(false);
    const busy = cowork.submitting || rereading;
    const fixed = steps && isClockPayload(view.payload);
    if (!advanced) return <CoworkActivity message={fixed ? view.title : t('cowork_home.confirm.start_question', 'Start “{title}” on this schedule?', { title: view.title })} work={{ action: 'ask' }} tone="rest" testId="cowork-confirm">
        <div className="grid gap-3 text-center">
            <ReviewSummary view={view} steps={fixed} t={t} />
            {cowork.error && <p role="alert" className={ALERT}>{cowork.error}</p>}
            <div className="flex justify-center gap-2">
                <button className={LINK_INLINE} onClick={onCancel}>{t('cowork_home.confirm.cancel', 'Cancel')}</button>
                <button className={BUTTON_PRIMARY} disabled={busy} onClick={() => onStart(startPayload(view, fixed))}>{startLabel(false, fixed, t)}</button>
            </div>
        </div>
    </CoworkActivity>;
    return (
        <section className={`${CARD} ${ENTER} p-4 flex flex-col gap-4`} aria-labelledby="cowork-confirm-heading" data-testid="cowork-confirm" data-tour="cowork-options">
            <h2 id="cowork-confirm-heading" className="m-0 text-[16px] leading-6 font-semibold text-[var(--text-primary)]">{t('cowork_home.confirm.heading', 'Review your task')}</h2>
            <ReviewFields view={view} steps={fixed} asking={changing} setChanging={setChanging} onChoose={onChoose} catalogue={catalogue} t={t} />
            <button type="button" aria-expanded={advanced} className={LINK_INLINE + ' self-start'} onClick={onAdvanced}>{t('cowork_overview.advanced', 'Advanced')}</button>
            <p className={META}>{hintOf(fixed, t)}</p>
            {rereading && <p role="status" className={META}>{t('cowork_home.confirm.rereading', 'Reading your sentence again…')}</p>}
            {cowork.error && <p role="alert" className={ALERT}>{cowork.error}</p>}
            <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={BUTTON_PRIMARY} data-testid="cowork-confirm-start" disabled={busy} onClick={() => onStart(startPayload(view, fixed))}>
                    {startLabel(cowork.submitting && !rereading, fixed, t)}
                </button>
                <button type="button" className={BUTTON_SECONDARY} disabled={cowork.submitting && !rereading} onClick={onCancel}>{t('cowork_home.confirm.cancel', 'Cancel')}</button>
            </div>
        </section>
    );
}

/** Apply the last answer directly to the held test. Live tasks still need an explicit Start. */
function DraftQuestions(props: DraftProps) {
    const { draft, view, choices, onChoose, onStart, onCancel, sentence, catalogue, t } = props;
    const schedule = scheduleToAsk(draft, choices);
    const target = missingDestination(draft, view, choices);
    const quick = !props.advanced && props.steps && canTestDraft(view.payload);
    const nextLabel = t('cowork_home.examples.next', 'Continue');
    const apply = (change: Partial<ConfirmChoices>, complete: boolean) => {
        onChoose(change);
        if (quick && complete) {
            const answered = confirmView(draft, { ...choices, ...change }, sentence, catalogue);
            onStart(startPayload(answered, true));
        }
    };
    if (props.rereading && (target || schedule)) return <CoworkActivity message={t('cowork_home.activity.thinking', 'I’m working out what your task needs.')} testId="cowork-confirm" />;
    if (target) return <AskDestination key={target} target={target} t={t} onCancel={onCancel}
        submitLabel={quick && !schedule ? startLabel(false, true, t) : nextLabel} onAnswer={answer => {
            if (target !== 'recipient') { props.onClarify(targetQuestion(target, t) + ' ' + answer); return; }
            const me = answer === t('cowork_home.confirm.me', 'Me');
            apply({ recipients: { me, others: me ? [] : [answer] } }, !schedule);
        }} />;
    if (schedule) return <CoworkScheduleQuestion payload={schedule} {...scheduleInputs(draft)}
        submitLabel={quick ? startLabel(false, true, t) : nextLabel} onCancel={onCancel} onAnswer={schedule => apply({ schedule }, true)} />;
    return <DraftReview {...props} />;
}

export default function CoworkConfirmCard(props: CoworkConfirmCardProps) {
    const { t } = useTranslation();
    const steps = useMayHaveSteps();
    const { availableApps } = useCoworkApps();
    const draft = props.cowork.draft;
    if (!draft) return null;
    const clarification = draft.spec?.clarification;
    if (clarification && !props.advanced) {
        if (props.rereading) return <CoworkActivity message={t('cowork_home.activity.thinking', 'I’m working out what your task needs.')} testId="cowork-confirm" />;
        return <CoworkBriefQuestion key={clarification.question} clarification={clarification} onAnswer={props.onClarify} onCancel={props.onCancel} />;
    }
    const catalogue = availableApps.filter(app => !app.isStep);
    const view = confirmView(draft, props.choices, props.sentence, catalogue);
    return <DraftQuestions {...props} draft={draft} view={view} steps={steps} catalogue={catalogue} t={t} />;
}

function startLabel(starting: boolean, steps: boolean, t: TranslateFn): string {
    if (starting) return t('cowork_home.confirm.starting', 'Starting…');
    return steps ? t('cowork_home.confirm.set_up', 'Set up and test') : t('cowork_home.confirm.start_ai', 'Start');
}
