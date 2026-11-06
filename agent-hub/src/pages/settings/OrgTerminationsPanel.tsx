import { useState } from 'react';
import { AlertOctagon } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { AlertBanner } from './usage/kit';
import { TerminationEvents } from './usage/quality/TerminationEvents';
import { TerminationsByAgent } from './usage/quality/TerminationsByAgent';
import { TerminationsTimeline } from './usage/quality/TerminationsTimeline';
import { useTerminationsReport } from './usage/quality/qualityData';
import type { OrgTerminationsPanelProps } from './OrgTerminationsPanel.types';

const TERMINATIONS_ERROR_ALERT_PCT = 5;
const TERMINATIONS_MIN_SAMPLE = 10;

export default function OrgTerminationsPanel({ rangeParams, showTokens = true, reveal = false }: OrgTerminationsPanelProps) {
    const { t } = useTranslation();
    const report = useTerminationsReport(rangeParams, reveal);
    const [filterType, setFilterType] = useState('');
    const { summary, timeline = [], rows = [], byAgent = [] } = report.data ?? {};

    const total = summary?.total || 0;
    const errCount = summary?.by_type?.error || 0;
    const errPct = total > 0 ? Math.round((errCount / total) * 100) : null;

    if (report.isFetching && rows.length === 0) {
        return <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-8 text-center text-[var(--text-muted)]">{t('org.terminations_loading', 'Loading terminations…')}</div>;
    }
    return (
        <div className="flex flex-col gap-4">
            {total >= TERMINATIONS_MIN_SAMPLE && errPct !== null && errPct > TERMINATIONS_ERROR_ALERT_PCT && (
                <AlertBanner
                    severity={errPct > TERMINATIONS_ERROR_ALERT_PCT * 4 ? 'red' : 'amber'}
                    icon={AlertOctagon}
                    message={t('org.terminations_alert', '{n} sessions ended in an error ({pct}% of the total). Investigate failing integrations.', { n: errCount, pct: errPct })}
                    ctaLabel={t('org.terminations_alert_cta', 'Review errors')}
                    onCta={() => setFilterType('error')}
                />
            )}
            {byAgent.length > 0 && <TerminationsByAgent byAgent={byAgent} rows={rows} showTokens={showTokens} />}
            <TerminationsTimeline data={timeline} />
            <TerminationEvents rows={rows} showTokens={showTokens} filterType={filterType} onFilterType={setFilterType} />
            <p className="m-0 text-xs text-[var(--text-muted)]">{t('org.terminations_privacy_note', 'Privacy: messages are not logged. Only sanitised metadata is shown here.')}</p>
        </div>
    );
}
