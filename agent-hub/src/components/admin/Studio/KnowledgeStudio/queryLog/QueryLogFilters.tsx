import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { QUERY_LOG_CHANNELS, QUERY_LOG_OUTCOMES, QUERY_LOG_REVIEW_STATUSES, type QueryLogFilters as Filters } from '@/api/queries/kbQueryLog';
import { PERIODS, channelLabel, outcomeLabel, periodFrom, statusLabel } from './queryLogLabels';

export interface QueryLogFiltersProps {
    value: Filters;
    onChange: (next: Filters) => void;
    people: { id: string; name: string }[];
}

const FIELD = 'rounded-md border px-2 py-1 text-xs [background:var(--bg-secondary)] [border-color:var(--border-default)] text-[var(--text-primary)]';

/** The filter bar of the Search log. Selects apply at once; the text filter applies on Enter or Search. */
export default function QueryLogFilters({ value, onChange, people }: QueryLogFiltersProps) {
    const { t } = useTranslation();
    const [period, setPeriod] = useState('all');
    const [text, setText] = useState(value.q ?? '');
    const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });
    const pick = (key: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => set({ [key]: e.target.value });

    return (
        <form
            className="flex flex-wrap items-end gap-2"
            data-testid="kb-query-log-filters"
            onSubmit={(e) => { e.preventDefault(); set({ q: text.trim() }); }}
        >
            <label className="flex flex-col gap-0.5 text-[11px] text-[var(--text-tertiary)]">
                {t('knowledge.query_log.f_period', 'Period')}
                <select
                    className={FIELD}
                    value={period}
                    data-testid="kb-ql-period"
                    onChange={(e) => {
                        setPeriod(e.target.value);
                        const days = PERIODS.find((p) => p.id === e.target.value)?.days ?? 0;
                        set({ from: periodFrom(days) });
                    }}
                >
                    {PERIODS.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.days === 0 ? t('knowledge.query_log.period_all', 'All time') : t('knowledge.query_log.period_days', 'Last {n} days', { n: p.days })}
                        </option>
                    ))}
                </select>
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] text-[var(--text-tertiary)]">
                {t('knowledge.query_log.f_person', 'Person')}
                <select className={FIELD} value={value.userId ?? ''} data-testid="kb-ql-person" onChange={pick('userId')}>
                    <option value="">{t('knowledge.query_log.any', 'Any')}</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] text-[var(--text-tertiary)]">
                {t('knowledge.query_log.f_channel', 'Channel')}
                <select className={FIELD} value={value.channel ?? ''} data-testid="kb-ql-channel" onChange={pick('channel')}>
                    <option value="">{t('knowledge.query_log.any', 'Any')}</option>
                    {QUERY_LOG_CHANNELS.map((c) => <option key={c} value={c}>{channelLabel(t, c)}</option>)}
                </select>
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] text-[var(--text-tertiary)]">
                {t('knowledge.query_log.f_outcome', 'Outcome')}
                <select className={FIELD} value={value.outcome ?? ''} data-testid="kb-ql-outcome" onChange={pick('outcome')}>
                    <option value="">{t('knowledge.query_log.any', 'Any')}</option>
                    {QUERY_LOG_OUTCOMES.map((o) => <option key={o} value={o}>{outcomeLabel(t, o)}</option>)}
                </select>
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] text-[var(--text-tertiary)]">
                {t('knowledge.query_log.f_status', 'Status')}
                <select className={FIELD} value={value.status ?? ''} data-testid="kb-ql-status" onChange={pick('status')}>
                    <option value="">{t('knowledge.query_log.any', 'Any')}</option>
                    {QUERY_LOG_REVIEW_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(t, s)}</option>)}
                </select>
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] text-[var(--text-tertiary)]">
                {t('knowledge.query_log.f_text', 'Text')}
                <input
                    type="search"
                    className={`${FIELD} w-44`}
                    value={text}
                    data-testid="kb-ql-text"
                    placeholder={t('knowledge.query_log.f_text_placeholder', 'In question or answer')}
                    onChange={(e) => setText(e.target.value)}
                />
            </label>
            <button type="submit" className="rounded-md border px-3 py-1 text-xs [border-color:var(--border-default)] text-[var(--text-secondary)]" data-testid="kb-ql-search">
                {t('knowledge.query_log.search', 'Search')}
            </button>
        </form>
    );
}
