import { useState } from 'react';
import type { CoworkPayload } from '@/api/cowork.types';
import { useTranslation } from '@/hooks/useTranslation';
import CoworkActivity from './CoworkActivity';
import { schedulePartOf, WEEK_DAYS, withTime, type SchedulePart } from './coworkConfirmModel';
import { advanceByRepeat, COWORK_REPEAT_OPTIONS, resolveWhen, toDateInput } from './coworkSchedule';
import { BUTTON_PRIMARY, FIELD, LINK_INLINE } from './coworkUi';

interface Props {
    payload: CoworkPayload;
    knownTime?: string;
    firstDate?: string;
    once: boolean;
    submitLabel: string;
    onAnswer: (schedule: SchedulePart) => void;
    onCancel: () => void;
}

const weekly = (repeat: string) => repeat === 'weekly' || repeat === 'biweekly';
const dated = (repeat: string) => ['once', 'monthly', 'quarterly', 'yearly'].includes(repeat);

function chosenSchedule(payload: CoworkPayload, repeat: string, day: string, date: string, time: string): SchedulePart | null {
    const repeatInterval = repeat === 'once' ? null : repeat;
    const now = new Date();
    if (!repeat) return null;
    if (repeat === 'hourly') return { repeatInterval, nextRunAt: advanceByRepeat(now, repeat)!.toISOString() };
    if (!time) return null;
    if (dated(repeat)) {
        const first = resolveWhen('custom', { date, time, now });
        if (!first || first <= now) return null;
        return { repeatInterval, nextRunAt: first.toISOString(), ...(repeatInterval ? { timeOfDay: time } : {}) };
    }
    const daysOfWeek = payload.daysOfWeek?.length ? payload.daysOfWeek : day ? [day] : undefined;
    if (weekly(repeat) && !daysOfWeek?.length) return null;
    return schedulePartOf(withTime({ ...payload, repeatInterval, daysOfWeek }, time, now));
}

function useScheduleInput({ payload, knownTime, firstDate, once }: Props) {
    const cadence = payload.repeatInterval || (payload.daysOfWeek?.length ? 'weekly' : once ? 'once' : '');
    const [repeat, setRepeat] = useState(cadence);
    const [day, setDay] = useState('');
    const [time, setTime] = useState(knownTime || payload.timeOfDay || '');
    const [date, setDate] = useState(firstDate || '');
    const needsWeekday = weekly(repeat) && !payload.daysOfWeek?.length;
    const answer = () => chosenSchedule(payload, repeat, day, date, time);
    const timeOnly = !!cadence && !needsWeekday && (!dated(repeat) || !!firstDate);
    return { cadence, repeat, setRepeat, needsWeekday, day, setDay, date, setDate, time, setTime, timeOnly, answer };
}

export default function CoworkScheduleQuestion(props: Props) {
    const { knownTime, firstDate, submitLabel, onAnswer, onCancel } = props;
    const { t, locale } = useTranslation();
    const { cadence, repeat, setRepeat, needsWeekday, day, setDay, date, setDate, time, setTime, timeOnly, answer } = useScheduleInput(props);
    const timeLabel = t('cowork_home.confirm.what_time', 'At what time?');
    const question = timeOnly ? timeLabel : t('cowork.when.sheet_title', 'When should this run?');
    return <CoworkActivity message={question} tone="rest" work={{ action: 'ask' }} testId="cowork-confirm">
        <form className="grid max-w-full gap-3 text-left" onSubmit={event => {
            event.preventDefault();
            const schedule = answer();
            if (schedule) onAnswer(schedule);
        }}>
            {!cadence && <label className="grid gap-1">{t('cowork_task.when.how_often', 'How often')}
                <select required className={FIELD} value={repeat} onChange={event => setRepeat(event.target.value)}>
                    <option value="" disabled>—</option>
                    {COWORK_REPEAT_OPTIONS.map(option => <option key={option.value} value={option.value || 'once'}>{t(option.labelKey, option.label)}</option>)}
                </select>
            </label>}
            {needsWeekday && <label className="grid gap-1">{t('cowork_home.confirm.which_day', 'Which day?')}
                <select required className={FIELD} value={day} onChange={event => setDay(event.target.value)}>
                    <option value="" disabled>—</option>
                    {WEEK_DAYS.map((value, i) => <option key={value} value={value}>{new Date(2024, 0, 8 + i, 12).toLocaleDateString(locale, { weekday: 'long' })}</option>)}
                </select>
            </label>}
            {dated(repeat) && !firstDate && <label className="grid gap-1">{t('cowork.when.date_aria', 'Date')}
                <input required className={FIELD} type="date" min={toDateInput(new Date())} value={date} onChange={event => setDate(event.target.value)} />
            </label>}
            {repeat && repeat !== 'hourly' && !knownTime && <label className="grid gap-1"><span className={timeOnly ? 'sr-only' : undefined}>{timeLabel}</span>
                <input required className={FIELD} type="time" value={time} onChange={event => setTime(event.target.value)} />
            </label>}
            <div className="flex justify-center gap-3">
                <button type="button" className={LINK_INLINE} onClick={onCancel}>{t('cowork_home.confirm.cancel', 'Cancel')}</button>
                <button className={BUTTON_PRIMARY} disabled={!answer()}>{submitLabel}</button>
            </div>
        </form>
    </CoworkActivity>;
}
