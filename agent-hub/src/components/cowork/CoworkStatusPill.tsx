/**
 * A task's status as a small label, in the one vocabulary of ./coworkTaskStatus.ts: green Done, red Failed, amber
 * Needs you, a spinner while Running or Testing, quiet grey for Scheduled, Paused and Nothing to do. The home's rows
 * show it, and the opened task's header. When the status changes, the new one fades in (SWAP of ./coworkMotion.ts).
 */
import { SPIN, SWAP } from './coworkMotion';
import { taskStatusLabel, type TaskStatus } from './coworkTaskStatus';
import { TAG_BAD, TAG_LIVE, TAG_OK, TAG_PLAIN, TAG_WARN } from './coworkUi';
import { useTranslation } from '@/hooks/useTranslation';

const TONE: Readonly<Record<TaskStatus, string>> = {
    done: TAG_OK,
    failed: TAG_BAD,
    needs: TAG_WARN,
    running: TAG_LIVE,
    testing: TAG_LIVE,
    scheduled: TAG_PLAIN,
    nothing: TAG_PLAIN,
    paused: TAG_PLAIN,
};

export default function CoworkStatusPill({ status, animate = true }: { status: TaskStatus; animate?: boolean }) {
    const { t } = useTranslation();
    const live = status === 'running' || status === 'testing';
    return (
        <span key={status} className={`${TONE[status]} ${SWAP}`} data-testid="cowork-status" data-status={status}>
            {live && animate
                ? <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full border-2 border-current border-t-transparent ${SPIN}`} />
                : <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-current" />}
            {taskStatusLabel(status, t)}
        </span>
    );
}
