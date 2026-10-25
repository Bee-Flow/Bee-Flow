import { Check, Circle, CircleDashed, SkipForward } from 'lucide-react';
import type { StagePosition, SectionProps, StageTimelineProps, StageStepProps } from './ApprovalDetail.types';

export function Section({ label, aside, children }: SectionProps) {
    return (
        <section className="mt-6 pt-6 border-t border-[var(--border-subtle)]">
            {(label || aside) && (
                <div className="flex items-baseline justify-between gap-2 flex-wrap mb-2.5">
                    {label ? <h2 className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">{label}</h2> : <span />}
                    {aside}
                </div>
            )}
            {children}
        </section>
    );
}

export function StageTimeline({ progress, approval, t }: StageTimelineProps) {
    const stages = Array.isArray(progress.stages) ? progress.stages : [];
    if (!stages.length) return null;
    // "Stage 2 of 3" counts the stages that actually run, exactly as the
    // server's stagePosition does — a skipped stage was never a step anybody
    // waited on, so numbering it would describe a chain that never existed.
    const activeTotal = progress.position?.total ?? stages.filter(s => s.state !== 'skipped').length;
    const positions = stages.reduce<{ seen: number; list: (StagePosition | null)[] }>((acc, stage) => {
        const seen = acc.seen + (stage.state === 'skipped' ? 0 : 1);
        return { seen, list: [...acc.list, stage.state === 'skipped' ? null : { index: seen, total: activeTotal }] };
    }, { seen: 0, list: [] }).list;
    return (
        <Section
            label={t('approvals.stages_title', 'Approval chain')}
            aside={approval.status === 'pending' && progress.position ? (
                <span className="text-[12px] text-[var(--text-secondary)]">
                    {t('approvals.stage_of', 'Stage {n} of {m}', {
                        n: String(progress.position.index), m: String(progress.position.total),
                    })}
                </span>
            ) : null}
        >
            <ol className="space-y-0">
                {stages.map((stage, i) => (
                    <StageStep
                        key={stage.key || i}
                        stage={stage}
                        position={positions[i]}
                        last={i === stages.length - 1}
                        t={t}
                    />
                ))}
            </ol>
        </Section>
    );
}

function StageStep({ stage, position, last, t }: StageStepProps) {
    const state = stage.state;
    const done = state === 'done';
    const current = state === 'current';
    const skipped = state === 'skipped';
    const stopped = state === 'never_reached';

    const marker = done
        ? <Check size={11} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        : current
            ? <Circle size={11} className="text-amber-600 dark:text-amber-400 fill-current" aria-hidden="true" />
            : skipped
                ? <SkipForward size={11} className="text-[var(--text-tertiary)]" aria-hidden="true" />
                : <CircleDashed size={11} className="text-[var(--text-tertiary)]" aria-hidden="true" />;

    const ruleLabel = stage.rule === 'first'
        ? t('approvals.rule_first', 'First to respond decides')
        : (stage.rule === 'quorum'
            ? t('approvals.rule_quorum', 'At least {n} of {m} must approve')
                .replace('{n}', String(stage.needed)).replace('{m}', String(stage.seatCount))
            : t('approvals.rule_all', 'Everyone must approve'));

    const stateLine = done
        ? t('approvals.stage_state_done', 'Decided')
        : current
            ? t('approvals.stage_state_current', 'Waiting on this stage')
            : skipped
                ? t('approvals.stage_state_skipped', 'Skipped — its condition was not met, so the chain went straight past it')
                : stopped
                    ? t('approvals.stage_state_never_reached', 'Never reached — the chain stopped before this stage')
                    : t('approvals.stage_state_waiting', 'Not started yet');

    const votes = Array.isArray(stage.votes) ? stage.votes : [];
    const muted = skipped || stopped;

    return (
        <li className="flex gap-2">
            <div className="flex flex-col items-center shrink-0 pt-0.5">
                <span
                    className={`inline-flex items-center justify-center w-4 h-4 rounded-full border ${
                        done ? 'border-emerald-500/50 bg-emerald-500/10'
                            : current ? 'border-amber-500/60 bg-amber-500/15'
                                : 'border-[var(--border-default)] bg-[var(--bg-secondary)]'
                    }`}
                >
                    {marker}
                </span>
                {!last && (
                    <span
                        className={`w-px flex-1 min-h-[1.25rem] ${done ? 'bg-emerald-500/40' : 'bg-[var(--border-default)]'} ${muted ? 'opacity-50' : ''}`}
                        aria-hidden="true"
                    />
                )}
            </div>
            <div className={`min-w-0 flex-1 pb-2 ${muted ? 'opacity-70' : ''}`}>
                <div className="flex items-baseline gap-1.5 flex-wrap">
                    <span className={`text-[13px] ${current ? 'font-semibold' : 'font-medium'} text-[var(--text-primary)] ${skipped ? 'line-through decoration-[var(--text-tertiary)]' : ''}`}>
                        {stage.name || t('approvals.stage_unnamed', 'this stage')}
                    </span>
                    {position && (
                        <span className="text-[11px] text-[var(--text-secondary)]">
                            {t('approvals.stage_of', 'Stage {n} of {m}', { n: String(position.index), m: String(position.total) })}
                        </span>
                    )}
                </div>
                {stage.description && (
                    <div className="text-[12px] text-[var(--text-secondary)]">{stage.description}</div>
                )}
                <div className="text-[11px] text-[var(--text-secondary)]">
                    {stateLine}
                    {!skipped && !stopped && ` · ${ruleLabel}`}
                    {(done || current) && !skipped && ` · ${t('approvals.stage_tally', '{n} of {m} approved', {
                        n: String(stage.approvals), m: String(stage.needed),
                    })}`}
                    {stage.rejects > 0 && ` · ${t('approvals.stage_declined_here', 'declined here')}`}
                </div>
                {votes.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                        {votes.map((v, i) => (
                            <li key={i} className="text-[12px] text-[var(--text-secondary)] flex items-baseline gap-1.5">
                                <span className={v.decision === 'approve' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                                    {v.decision === 'approve' ? '✓' : '✕'}
                                </span>
                                <span className="font-medium text-[var(--text-primary)]">{v.name || v.by}</span>
                                {v.reason && <span className="truncate">— “{v.reason}”</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </li>
    );
}
