// The pieces of the skill Test tab (TestTab.tsx): its header, the agent
// picker, the per-step verdict and the run history.
import { Check, CircleAlert, FlaskConical, Play, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { SkillTestRun, SkillTestStepResult } from '@/api/skillsApi';
import { kindColorVar, kindTint } from '@/components/shared/kindColors';
import type { TranslateFn, TranslateParams } from '@/hooks/useTranslation';
import type { TestTabProps, StepRowProps, RunRowProps } from './TestTab.types';

const STATUS_ICON: Record<string, LucideIcon> = {
    ok: Check,
    warning: TriangleAlert,
    error: CircleAlert,
};
const STATUS_COLOR: Record<string, string> = {
    ok: 'var(--success)',
    warning: 'var(--warning)',
    error: 'var(--error)',
};

export function TestTabSection2({ t, run, canRun, running }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; run: () => Promise<void>; canRun: boolean; running: boolean; }) {
    return <div className="flex items-center gap-2">
        <FlaskConical size={14} aria-hidden="true" className="text-[var(--text-secondary)]" />
        <h2 className="text-[13px] font-semibold text-[var(--text-primary)] m-0">
            {t('skills_studio.test.title', 'Test')}
        </h2>
        <span className="text-xs text-[var(--text-tertiary)]">
            {t('skills_studio.test.hint', 'one question through the steps')}
        </span>
        <button
            type="button"
            onClick={run}
            disabled={!canRun}
            data-testid="skill-test-run"
            className="ml-auto h-8 px-3 rounded-[10px] text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
        >
            <Play size={11} aria-hidden="true" />
            {running ? t('skills_studio.test.running', 'Running…') : t('skills_studio.test.run', 'Run')}
        </button>
    </div>;
}

export function TestTabSection({ t, agentId, agents, setAgentId }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; agentId: string; agents: boolean | { id: string; name: string; }[] | null; setAgentId: Dispatch<SetStateAction<string>>; }) {
    return <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--text-secondary)]" htmlFor="skill-test-agent">
            {t('skills_studio.test.as_agent', 'as agent')}
        </label>
        <select
            id="skill-test-agent"
            data-testid="skill-test-agent"
            value={agentId}
            disabled={!Array.isArray(agents) || agents.length === 0}
            onChange={(e) => setAgentId(e.target.value)}
            className="h-8 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2 text-xs text-[var(--text-primary)] disabled:opacity-50"
        >
            <option value="">{t('skills_studio.test.no_agent', 'Just this skill')}</option>
            {(Array.isArray(agents) ? agents : []).map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
            ))}
        </select>
        {agents === false && (
            <span className="text-xs text-[var(--warning-ink)]" data-testid="skill-test-agents-failed">
                {t('skills_studio.test.agents_failed', 'Could not load your agents, so a test cannot run as one.')}
            </span>
        )}
    </div>;
}

export function StepRow({ row, index }: StepRowProps) {
    // An unknown status is drawn as a warning, never as a pass — the same
    // direction the server clamps in.
    const status = STATUS_ICON[row.status] ? row.status : 'warning';
    const Icon = STATUS_ICON[status];
    return (
        <li
            data-testid="skill-test-step-row"
            data-status={status}
            className="flex gap-2.5 px-2.5 py-2 rounded-lg bg-[var(--bg-card)] border"
            style={{ borderColor: status === 'ok' ? 'var(--border-default)' : STATUS_COLOR[status] }}
        >
            <span
                aria-hidden="true"
                className="w-5 h-5 rounded-md grid place-items-center text-[10px] font-bold flex-shrink-0"
                style={{ background: kindTint('skill', 14), color: kindColorVar('skill') }}
            >
                {index + 1}
            </span>
            <div className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-[var(--text-primary)]">{row.title}</span>
                <span className="block text-xs text-[var(--text-tertiary)]">{row.evidence}</span>
            </div>
            <Icon size={14} aria-hidden="true" style={{ color: STATUS_COLOR[status] }} />
        </li>
    );
}

export function RunRow({ run, rel, t }: RunRowProps) {
    const ok = run.status === 'ok';
    const results = Array.isArray(run.results) ? run.results : [];
    return (
        <li
            data-testid="skill-test-run-row"
            data-status={run.status}
            className="flex gap-2.5 px-2.5 py-2 rounded-lg bg-[var(--bg-card)] border"
            style={{ borderColor: ok ? 'var(--border-default)' : 'var(--warning)' }}
        >
            <span
                aria-hidden="true"
                className="w-5 h-5 rounded-md grid place-items-center text-[10px] font-bold flex-shrink-0"
                style={{ background: kindTint('skill', 14), color: kindColorVar('skill') }}
            >
                {results.length || '—'}
            </span>
            <div className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-[var(--text-primary)] truncate">{run.question}</span>
                <span className="block text-xs text-[var(--text-tertiary)]">
                    {run.advice || t('skills_studio.test.no_advice', 'no advice')} · {rel(run.ranAt)}
                </span>
            </div>
            {ok
                ? <Check size={14} aria-hidden="true" className="[color:var(--success)]" />
                : <TriangleAlert size={14} aria-hidden="true" className="[color:var(--warning)]" />}
        </li>
    );
}

interface TestResultsProps {
    t: TranslateFn;
    results: SkillTestStepResult[];
    advice: SkillTestRun['advice'] | undefined;
    adviceHref: string | null;
    onNavigate: TestTabProps['onNavigate'];
}

/** The graded run: one row per step, then the advice and, when it points somewhere, a link to it. */
export function TestResults({ t, results, advice, adviceHref, onNavigate }: TestResultsProps) {
    return (
        <>
            <h3 className="text-xs font-semibold text-[var(--text-primary)] mt-1 m-0">
                {t('skills_studio.test.per_step', 'Per step')}
            </h3>
            <ul className="list-none p-0 m-0 flex flex-col gap-1.5">
                {results.map((row, i) => (
                    <StepRow key={row.stepId || i} row={row} index={i} />
                ))}
            </ul>
            <p className="text-xs m-0 flex items-center gap-2" data-testid="skill-test-advice">
                <span className="font-semibold text-[var(--text-primary)]">
                    {t('skills_studio.test.advice_label', 'Advice')}
                </span>
                <span className="text-[var(--text-secondary)]">
                    {advice || t('skills_studio.test.no_advice', 'no advice')}
                </span>
                {adviceHref && (
                    <button
                        type="button"
                        data-testid="skill-test-advice-link"
                        onClick={() => onNavigate?.(adviceHref)}
                        className="text-xs underline text-[var(--accent-primary)]"
                    >
                        {t('skills_studio.test.open_ref', 'Open what this step uses')}
                    </button>
                )}
            </p>
        </>
    );
}

interface TestHistoryProps {
    t: TranslateFn;
    runs: SkillTestRun[] | false | null;
    forbidden: boolean;
    rel: RunRowProps['rel'];
}

/** Earlier runs — loading, failed (never "not tested"), none, or the list. */
export function TestHistory({ t, runs, forbidden, rel }: TestHistoryProps) {
    return (
        <>
            <h3 className="text-xs font-semibold text-[var(--text-primary)] mt-2 m-0">
                {t('skills_studio.test.history', 'Earlier runs')}
            </h3>
            {runs === null && (
                <p className="text-xs text-[var(--text-tertiary)] m-0">{t('skills_studio.examples.loading', 'Loading…')}</p>
            )}
            {runs === false && !forbidden && (
                <p className="text-xs m-0 text-[var(--warning-ink)]" data-testid="skill-test-history-failed">
                    {t('skills_studio.test.history_failed', 'Could not load earlier runs, so the test history is unknown.')}
                </p>
            )}
            {runs !== false && runs?.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)] m-0" data-testid="skill-test-none">
                    {t('skills_studio.test.untested', 'not tested')}
                </p>
            )}
            <ul className="list-none p-0 m-0 flex flex-col gap-1.5">
                {(runs || []).map((row) => (
                    <RunRow key={row.id} run={row} rel={rel} t={t} />
                ))}
            </ul>
        </>
    );
}
