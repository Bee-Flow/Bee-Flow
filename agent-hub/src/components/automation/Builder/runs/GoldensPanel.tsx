import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AiAnswers, GoldenItem, ReplayStatus } from '@/api/queries/automation/runChecks';
import { useGoldens, useReplayGoldens, useUnmarkGolden } from '@/api/queries/automation/runChecks';
import { GoldenHelp } from './GoldenControl';
import { goldenErrorText, replayFailureText } from './runChecksErrors';
import { PRIMARY_BTN, SECONDARY_BTN } from './runChecksStyles';

const BADGE: Record<ReplayStatus, string> = {
    running: 'text-[var(--accent-primary)]',
    same: 'text-[var(--success)]',
    soft: 'text-[var(--warning)]',
    changed: 'text-[var(--error)]',
    error: 'text-[var(--error)]',
    interrupted: 'text-[var(--text-secondary)]',
};

function badgeText(t: TranslateFn, status: ReplayStatus): string {
    switch (status) {
        case 'running': return t('automation_run_checks.replay.running', 'Running');
        case 'same': return t('automation_run_checks.replay.same', 'Same');
        case 'soft': return t('automation_run_checks.replay.soft', 'Only AI differs');
        case 'changed': return t('automation_run_checks.replay.changed', 'Different');
        case 'interrupted': return t('automation_run_checks.replay.interrupted', 'Interrupted');
        default: return t('automation_run_checks.replay.error', 'Error');
    }
}

/** Why the last replay has no verdict, when it has none. */
function replayNote(t: TranslateFn, golden: GoldenItem): { text: string; error: boolean } | null {
    const last = golden.lastReplay;
    if (last?.status === 'error') return { text: replayFailureText(last.errorCode, t), error: true };
    if (last?.status === 'interrupted') return { text: t('automation_run_checks.replay.interrupted_hint', 'The replay was cut off. Run it again.'), error: false };
    return null;
}

interface GoldenRowProps {
    golden: GoldenItem;
    selected: boolean;
    onToggle: () => void;
    onCompare: (golden: GoldenItem) => void;
    onOpenRun: (runId: string) => void;
    onRemove: (golden: GoldenItem) => void;
}

function GoldenRowMeta({ golden }: { golden: GoldenItem }) {
    const { t, locale } = useTranslation();
    const started = golden.run?.startedAt;
    const note = replayNote(t, golden);
    return (
        <div className="ml-6 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[var(--text-tertiary)]">
            {started && <span>{new Date(started).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
            {golden.run?.version != null && <span>{t('runs.tab.version_n', 'version {n}', { n: golden.run.version })}</span>}
            {note && <span className={note.error ? 'text-[var(--error)]' : ''}>{note.text}</span>}
        </div>
    );
}

function GoldenRow({ golden, selected, onToggle, onCompare, onOpenRun, onRemove }: GoldenRowProps) {
    const { t } = useTranslation();
    const last = golden.lastReplay;
    const title = golden.label || t('automation_run_checks.golden.unlabelled', 'Golden run');
    const hasVerdict = last?.status === 'same' || last?.status === 'soft' || last?.status === 'changed';
    return (
        <li className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2">
            <div className="flex items-center gap-2">
                <input
                    type="checkbox"
                    checked={selected}
                    onChange={onToggle}
                    aria-label={t('automation_run_checks.golden.select', 'Select {name}', { name: title })}
                />
                <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">{title}</span>
                {last && <span className={`font-medium ${BADGE[last.status]}`}>{badgeText(t, last.status)}</span>}
            </div>
            <GoldenRowMeta golden={golden} />
            <div className="ml-6 mt-1 flex flex-wrap gap-x-3 text-[var(--accent-primary)]">
                {hasVerdict && !!last?.replayRunId && (
                    <button type="button" className="hover:underline" onClick={() => onCompare(golden)}>
                        {t('automation_run_checks.replay.see_differences', 'See differences')}
                    </button>
                )}
                <button type="button" className="hover:underline" onClick={() => onOpenRun(golden.runId)}>
                    {t('automation_run_checks.golden.open_run', 'Open the golden run')}
                </button>
                <button type="button" className="text-[var(--text-secondary)] hover:underline" onClick={() => onRemove(golden)}>
                    {t('automation_run_checks.golden.remove_short', 'Remove')}
                </button>
            </div>
        </li>
    );
}

/** How a replay treats the steps that ask a model. */
function AiAnswersChoice({ value, onChange }: { value: AiAnswers; onChange: (v: AiAnswers) => void }) {
    const { t } = useTranslation();
    return (
        <fieldset className="flex flex-col gap-1">
            <legend className="font-medium text-[var(--text-primary)]">{t('automation_run_checks.replay.ai_legend', 'AI answers')}</legend>
            <label className="flex items-center gap-2 text-[var(--text-secondary)]">
                <input type="radio" name="golden-ai" checked={value === 'live'} onChange={() => onChange('live')} />
                {t('automation_run_checks.replay.ai_live', 'Ask the AI again')}
            </label>
            <label className="flex items-center gap-2 text-[var(--text-secondary)]">
                <input type="radio" name="golden-ai" checked={value === 'cache'} onChange={() => onChange('cache')} />
                {t('automation_run_checks.replay.ai_cache', 'Reuse stored answers where available')}
            </label>
            <p className="text-[var(--text-tertiary)]">
                {t('automation_run_checks.replay.ai_help', 'Reusing works for AI steps that keep their answers for later runs; the others ask the AI again.')}
            </p>
        </fieldset>
    );
}

interface ReplayBarProps {
    chosen: number;
    running: boolean;
    pending: boolean;
    onReplay: () => void;
    onClear: () => void;
}

/** "Replay goldens" (all) or "Replay n selected", and the sign that one is running. */
function ReplayBar({ chosen, running, pending, onReplay, onClear }: ReplayBarProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2">
            <button type="button" className={PRIMARY_BTN} onClick={onReplay} disabled={pending || running}>
                {chosen > 0
                    ? t('automation_run_checks.replay.selected', 'Replay {n} selected', { n: chosen })
                    : t('automation_run_checks.replay.all', 'Replay goldens')}
            </button>
            {chosen > 0 && (
                <button type="button" className={SECONDARY_BTN} onClick={onClear}>
                    {t('automation_run_checks.replay.clear', 'Clear selection')}
                </button>
            )}
            {running && <span className="text-[var(--text-secondary)]">{t('automation_run_checks.replay.in_progress', 'Replaying…')}</span>}
        </div>
    );
}

interface GoldensPanelProps {
    automationId: string;
    active?: boolean;
    /** Open the compare view: the golden (A) against its last replay (B). */
    onCompare: (golden: GoldenItem) => void;
    onOpenRun: (runId: string) => void;
}

/** The Testing tab's golden runs: the list, the last verdicts, and "Replay goldens". */
export default function GoldensPanel({ automationId, active = true, onCompare, onOpenRun }: GoldensPanelProps) {
    const { t } = useTranslation();
    const goldens = useGoldens(automationId, active);
    const replay = useReplayGoldens(automationId);
    const unmark = useUnmarkGolden(automationId);
    const [selected, setSelected] = useState<string[]>([]);
    const [aiAnswers, setAiAnswers] = useState<AiAnswers>('live');
    const [error, setError] = useState<string | null>(null);

    const list = goldens.data?.goldens ?? [];
    const running = list.some(g => g.lastReplay?.status === 'running');
    const chosen = selected.filter(id => list.some(g => g.goldenId === id));

    const attempt = async (call: () => Promise<unknown>) => {
        setError(null);
        try { await call(); } catch (e) { setError(goldenErrorText(e, t)); }
    };
    const toggle = (id: string) => setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));

    return (
        <section aria-label={t('automation_run_checks.golden.section', 'Golden runs')} className="flex flex-col gap-2.5 p-4 text-xs">
            <div className="flex items-center gap-1.5">
                <h3 className="font-semibold text-sm text-[var(--text-primary)]">{t('automation_run_checks.golden.section', 'Golden runs')}</h3>
                <GoldenHelp />
                {goldens.data?.max != null && (
                    <span className="ml-auto text-[var(--text-tertiary)]">
                        {t('automation_run_checks.golden.count_of_max', '{n} of {max}', { n: list.length, max: goldens.data.max })}
                    </span>
                )}
            </div>
            {goldens.isError && <p role="alert" className="text-[var(--error)]">{t('automation_run_checks.golden.load_failed', 'Could not load the golden runs.')}</p>}
            {list.length === 0 && error && <p role="alert" className="text-[var(--error)]">{error}</p>}
            {goldens.isSuccess && list.length === 0 && (
                <p className="text-[var(--text-tertiary)]">
                    {t('automation_run_checks.golden.empty', 'No golden runs yet. Open a run that finished well and choose "Mark as golden".')}
                </p>
            )}
            {list.length > 0 && (
                <>
                    <AiAnswersChoice value={aiAnswers} onChange={setAiAnswers} />
                    <ReplayBar
                        chosen={chosen.length}
                        running={running}
                        pending={replay.isPending}
                        onReplay={() => attempt(() => replay.mutateAsync({ goldenIds: chosen, aiAnswers }))}
                        onClear={() => setSelected([])}
                    />
                    {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
                    <ul className="flex flex-col gap-1.5">
                        {list.map(g => (
                            <GoldenRow
                                key={g.goldenId}
                                golden={g}
                                selected={chosen.includes(g.goldenId)}
                                onToggle={() => toggle(g.goldenId)}
                                onCompare={onCompare}
                                onOpenRun={onOpenRun}
                                onRemove={(x) => attempt(() => unmark.mutateAsync(x.runId))}
                            />
                        ))}
                    </ul>
                    <p className="text-[var(--text-tertiary)]">
                        {t('automation_run_checks.replay.footnote', 'A replay runs the same input again as a test run. Nothing is sent.')}
                    </p>
                </>
            )}
        </section>
    );
}
