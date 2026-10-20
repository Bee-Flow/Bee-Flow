// "Use the input of a recorded run": the automation's recent finished runs,
// newest first. The server takes the input this step received in the chosen
// run and keeps it as test data; this picker only names the run.
import { useMemo } from 'react';
import { useRunList, type RunListFilters, type RunRowData } from '../../../../../../api/queries/automation/runs';
import { useTranslation } from '../../../../../../hooks/useTranslation';

const FINISHED = new Set(['success', 'error', 'cancelled']);
const FILTERS: RunListFilters = { status: 'all', period: 0, q: '', showTests: true };

/** Finished runs, newest first. Exported for the test. */
export function finishedRuns(runs: RunRowData[]): RunRowData[] {
    return runs
        .filter((r) => FINISHED.has(String(r.status || '')))
        .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

interface CaptureFromRunPickerProps {
    automationId: string | null;
    value: string;
    onChange: (runId: string) => void;
    invalid?: boolean;
    describedBy?: string;
}

export default function CaptureFromRunPicker({ automationId, value, onChange, invalid = false, describedBy }: CaptureFromRunPickerProps) {
    const { t } = useTranslation();
    const list = useRunList(automationId, FILTERS, true);
    const runs = useMemo(() => finishedRuns(list.data || []), [list.data]);
    const statusText = (s: string | null | undefined): string => (s === 'success'
        ? t('automation_testing.run.succeeded', 'Succeeded')
        : s === 'error' ? t('automation_testing.run.failed', 'Failed') : t('automation_testing.run.cancelled', 'Cancelled'));
    const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : t('automation_testing.run.unknown_time', 'Unknown time'));

    return (
        <div className="space-y-1">
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                aria-label={t('automation_testing.run.pick', 'Run to take the input from')}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 text-xs outline-none focus:border-[var(--accent-primary)] aria-[invalid=true]:border-[var(--error)]"
            >
                <option value="">{t('automation_testing.run.choose', 'Choose a run…')}</option>
                {/* A run that is not in the recent list (a case being edited) stays selectable. */}
                {value && !runs.some((r) => r.id === value) && <option value={value}>{t('automation_testing.run.current', 'The run chosen before')}</option>}
                {runs.map((r) => (
                    <option key={r.id} value={r.id}>{`${when(r.startedAt)} · ${statusText(r.status)}${r.isTest ? ` · ${t('automation_testing.run.test', 'test')}` : ''}`}</option>
                ))}
            </select>
            {list.isLoading && <p className="text-xs text-[var(--text-tertiary)]">{t('automation_testing.run.loading', 'Loading runs…')}</p>}
            {!list.isLoading && runs.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)]">{t('automation_testing.run.none', 'No finished runs yet. Run the automation once, or type values instead.')}</p>
            )}
        </div>
    );
}
