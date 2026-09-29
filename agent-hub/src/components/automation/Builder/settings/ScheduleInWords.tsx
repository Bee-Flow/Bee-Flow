import { CalendarCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useSchedulePreviewQuery } from '../../../../api/queries/automation/settings';
import Toggle from '../../../shared/Toggle';
import { TIMEZONE_OPTIONS, describeCron } from '../flow/scheduleBuilderUtils';
import { LINK_BTN, SELECT } from './settingsUi';
import { cronFromWords, toggleDay, withFrequency } from './startChoice';
import type { Frequency, ScheduleWords } from './startChoice';

// Monday first, as the artboard draws the day buttons.
const DAY_BUTTONS: { id: number; key: string; label: string }[] = [
    { id: 1, key: 'mon', label: 'Mon' }, { id: 2, key: 'tue', label: 'Tue' }, { id: 3, key: 'wed', label: 'Wed' },
    { id: 4, key: 'thu', label: 'Thu' }, { id: 5, key: 'fri', label: 'Fri' }, { id: 6, key: 'sat', label: 'Sat' },
    { id: 0, key: 'sun', label: 'Sun' },
];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "Tue 29 Sep 07:00" in the schedule's own time zone. */
export function formatNextRun(iso: string, tz: string, locale?: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
        const parts = new Intl.DateTimeFormat(locale || 'en-GB', {
            timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(d);
        const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
        return `${get('weekday')} ${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`;
    } catch {
        return d.toLocaleString();
    }
}

interface Props {
    words: ScheduleWords;
    tz: string;
    skipHolidays: boolean;
    onChange: (next: { words?: ScheduleWords; tz?: string; skipHolidays?: boolean }) => void;
}

/**
 * The schedule in words (artboard 5e-2): Every [weekday ▾] at [07:00] tz, the
 * Mon–Sun day buttons, the next three runs, "Skip public holidays" and the cron
 * notation behind a link, never as the first thing a person sees.
 */
export default function ScheduleInWords({ words, tz, skipHolidays, onChange }: Props) {
    const { t, locale } = useTranslation();
    // Plain 'en' formats US-style ("Sep 29"); the artboard reads "Tue 29 Sep".
    const dateLocale = !locale || locale === 'en' ? 'en-GB' : locale;
    const [showCron, setShowCron] = useState(words.freq === 'custom');
    const cron = words.freq === 'custom' ? words.cron : cronFromWords(words);
    // The preview is rate limited per user: ask once the typing settles.
    const [settledCron, setSettledCron] = useState(cron);
    useEffect(() => {
        const handle = setTimeout(() => setSettledCron(cron), 400);
        return () => clearTimeout(handle);
    }, [cron]);
    const preview = useSchedulePreviewQuery(settledCron, tz, skipHolidays);

    const freqOptions: { value: Frequency; label: string }[] = [
        { value: 'weekday', label: t('routines.settings.freq_weekday', 'weekday') },
        { value: 'day', label: t('routines.settings.freq_day', 'day') },
        { value: 'week', label: t('routines.settings.freq_week', 'week') },
        { value: 'month', label: t('routines.settings.freq_month', 'month') },
        ...(words.freq === 'custom' ? [{ value: 'custom' as Frequency, label: t('routines.settings.freq_custom', 'custom schedule') }] : []),
    ];
    const setTime = (value: string) => {
        const [h, m] = value.split(':').map((x) => Number(x));
        if (!Number.isFinite(h) || !Number.isFinite(m)) return;
        const next = { ...words, hour: h, minute: m, freq: words.freq === 'custom' ? 'day' as Frequency : words.freq };
        onChange({ words: { ...next, cron: cronFromWords(next) } });
    };

    return (
        <div className="flex flex-col gap-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3.5 text-[12px]">
            <div className="flex items-center gap-2 flex-wrap">
                <span>{t('routines.settings.every', 'Every')}</span>
                <select
                    aria-label={t('routines.settings.frequency', 'How often')}
                    className={SELECT}
                    value={words.freq}
                    onChange={(e) => onChange({ words: withFrequency(words, e.target.value as Frequency) })}
                >
                    {freqOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {words.freq === 'month' && (
                    <>
                        <span>{t('routines.settings.on_day', 'on day')}</span>
                        <input
                            type="number"
                            min={1}
                            max={31}
                            aria-label={t('routines.settings.day_of_month', 'Day of the month')}
                            className={`${SELECT} w-16`}
                            value={words.dayOfMonth}
                            onChange={(e) => {
                                const next = { ...words, dayOfMonth: Number(e.target.value) || 1 };
                                onChange({ words: { ...next, cron: cronFromWords(next) } });
                            }}
                        />
                    </>
                )}
                <span>{t('routines.settings.at', 'at')}</span>
                <input
                    type="time"
                    aria-label={t('routines.settings.time', 'Time')}
                    className={SELECT}
                    value={`${pad2(words.hour)}:${pad2(words.minute)}`}
                    onChange={(e) => setTime(e.target.value)}
                />
                <select aria-label={t('routines.settings.timezone', 'Time zone')} className={`${SELECT} max-w-[200px]`} value={tz} onChange={(e) => onChange({ tz: e.target.value })}>
                    {(TIMEZONE_OPTIONS.includes(tz) ? TIMEZONE_OPTIONS : [tz, ...TIMEZONE_OPTIONS]).map((z: string) => <option key={z} value={z}>{z}</option>)}
                </select>
            </div>
            {words.freq !== 'month' && words.freq !== 'custom' && (
                <div className="flex gap-1" role="group" aria-label={t('routines.settings.days', 'Days')}>
                    {DAY_BUTTONS.map((d) => {
                        const on = words.days.includes(d.id);
                        return (
                            <button
                                key={d.id}
                                type="button"
                                aria-pressed={on}
                                onClick={() => onChange({ words: toggleDay(words, d.id) })}
                                className={`w-10 py-1 rounded-md border text-[12px] font-medium transition ${on
                                    ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-[var(--text-primary)]'
                                    : 'border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-tertiary)]'}`}
                            >
                                {t(`routines.schedule.day_${d.key}`, d.label)}
                            </button>
                        );
                    })}
                </div>
            )}
            <div className="flex items-start gap-1.5 text-[var(--text-secondary)]" aria-live="polite">
                <CalendarCheck size={13} className="mt-0.5 shrink-0" />
                <span>
                    {preview.data?.valid === false
                        ? t('routines.settings.schedule_invalid', 'This schedule never runs. Check the days and the time.')
                        : preview.data?.next.length
                            ? t('routines.settings.next_runs', 'Next runs: {list}', { list: preview.data.next.map((iso) => formatNextRun(iso, tz, dateLocale)).join(' · ') })
                            : describeCron(cron, { t, tz })}
                </span>
            </div>
            <div className="flex items-center gap-3 flex-wrap text-[var(--text-secondary)]">
                <span className="inline-flex items-center gap-2">
                    <Toggle
                        size="sm"
                        checked={skipHolidays}
                        onChange={(v) => onChange({ skipHolidays: v })}
                        ariaLabel={t('routines.settings.skip_holidays', 'Skip public holidays')}
                    />
                    <span aria-hidden>{t('routines.settings.skip_holidays', 'Skip public holidays')}</span>
                </span>
                <button type="button" className={LINK_BTN} onClick={() => setShowCron((v) => !v)} aria-expanded={showCron}>
                    {showCron ? t('routines.settings.hide_cron', 'Hide cron notation') : t('routines.settings.show_cron', 'Show cron notation')}
                </button>
            </div>
            {showCron && (
                <input
                    aria-label={t('routines.settings.cron', 'Cron notation')}
                    className={`${SELECT} font-mono`}
                    value={cron}
                    onChange={(e) => onChange({ words: { ...words, freq: 'custom', cron: e.target.value } })}
                />
            )}
        </div>
    );
}
