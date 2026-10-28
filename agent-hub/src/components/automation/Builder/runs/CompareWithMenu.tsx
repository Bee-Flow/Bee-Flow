import React, { useState } from 'react';
import { GitCompare } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { RunListFilters, RunRowData } from '@/api/queries/automation/runs';
import { useRunList } from '@/api/queries/automation/runs';
import RunAction from './RunAction';
import { runTone } from './runOutcome';
import { POPOVER_PANEL, PRIMARY_BTN } from './runChecksStyles';

/** The Runs tab's own default, so the list below is already in the cache. */
const RECENT: RunListFilters = { status: 'all', period: 168, q: '', showTests: true };

/** The run just before this one, else the newest other run. Exported for the test. */
function previousRun(runs: RunRowData[], current: RunRowData): RunRowData | null {
    const others = runs.filter(r => r.id !== current.id);
    return others.find(r => !current.startedAt || !r.startedAt || r.startedAt < current.startedAt) ?? others[0] ?? null;
}

/** "Compare with…": pick another recent run of this automation; the previous one is preselected. */
export default function CompareWithMenu({ automationId, run, onCompare }: {
    automationId: string;
    run: RunRowData;
    onCompare: (otherRunId: string) => void;
}) {
    const { t, locale } = useTranslation();
    const [open, setOpen] = useState(false);
    const [picked, setPicked] = useState<string | null>(null);
    const list = useRunList(automationId, RECENT, open);
    const others = (list.data || []).filter(r => r.id !== run.id);
    const choice = picked ?? previousRun(list.data || [], run)?.id ?? '';

    const optionText = (r: RunRowData) => {
        const when = r.startedAt ? new Date(r.startedAt).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        const tone = runTone(r);
        const ended = tone === 'success' ? t('automation_run_checks.side.finished', 'Finished')
            : tone === 'error' ? t('automation_run_checks.side.stopped', 'Stopped') : String(r.status || '');
        return [when, ended, r.version != null ? t('runs.tab.version_n', 'version {n}', { n: r.version }) : ''].filter(Boolean).join(' · ');
    };

    return (
        <div className="relative">
            <RunAction icon={GitCompare} label={t('automation_run_checks.compare.with', 'Compare with…')} onClick={() => setOpen(o => !o)} expanded={open} />
            {open && (
                <div role="group" aria-label={t('automation_run_checks.compare.with', 'Compare with…')} className={POPOVER_PANEL}>
                    <label htmlFor="compare-with-run" className="font-medium text-[var(--text-primary)]">
                        {t('automation_run_checks.compare.pick', 'Compare this run with')}
                    </label>
                    {list.isLoading && <p className="text-[var(--text-tertiary)]">{t('automation_run_checks.compare.loading_runs', 'Loading runs…')}</p>}
                    {!list.isLoading && others.length === 0 && (
                        <p className="text-[var(--text-tertiary)]">{t('automation_run_checks.compare.no_other_runs', 'There is no other recent run to compare with.')}</p>
                    )}
                    {others.length > 0 && (
                        <select
                            id="compare-with-run"
                            value={choice}
                            onChange={e => setPicked(e.target.value)}
                            className="h-[30px] px-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
                        >
                            {others.map(r => <option key={r.id} value={r.id}>{optionText(r)}</option>)}
                        </select>
                    )}
                    <button
                        type="button"
                        disabled={!choice}
                        onClick={() => { setOpen(false); onCompare(choice); }}
                        className={`self-start ${PRIMARY_BTN}`}
                    >
                        {t('automation_run_checks.compare.go', 'Compare')}
                    </button>
                </div>
            )}
        </div>
    );
}
