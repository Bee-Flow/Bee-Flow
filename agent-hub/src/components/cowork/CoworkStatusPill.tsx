/**
 * A task's status as a pill, in the one vocabulary of ./coworkTaskStatus.ts: green Done, red Failed, amber Needs you,
 * a pulsing dot while Running or Testing, quiet grey for Scheduled, Paused and Nothing to do. The home's rows show it,
 * and the opened task's header.
 */
import { taskStatusLabel, type TaskStatus } from './coworkTaskStatus';
import { useTranslation } from '@/hooks/useTranslation';

const TONE: Readonly<Record<TaskStatus, string>> = {
    done: 'text-[var(--success-ink)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)]',
    failed: 'text-[var(--error-ink)] bg-[color-mix(in_srgb,var(--error)_9%,transparent)]',
    needs: 'text-[var(--warning-ink)] bg-[color-mix(in_srgb,var(--warning)_11%,transparent)]',
    running: 'text-[var(--type-ai)] bg-[color-mix(in_srgb,var(--type-ai)_12%,transparent)]',
    testing: 'text-[var(--type-ai)] bg-[color-mix(in_srgb,var(--type-ai)_12%,transparent)]',
    scheduled: 'text-[var(--text-secondary)] bg-[var(--bg-tertiary)]',
    nothing: 'text-[var(--text-secondary)] bg-[var(--bg-tertiary)]',
    paused: 'text-[var(--text-tertiary)] bg-[var(--bg-tertiary)]',
};

export default function CoworkStatusPill({ status }: { status: TaskStatus }) {
    const { t } = useTranslation();
    const live = status === 'running' || status === 'testing';
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[13px] font-semibold whitespace-nowrap ${TONE[status]}`} data-testid="cowork-status" data-status={status}>
            <span aria-hidden="true" className={`w-[7px] h-[7px] rounded-full bg-current ${live ? 'motion-safe:animate-pulse' : ''}`} />
            {taskStatusLabel(status, t)}
        </span>
    );
}
