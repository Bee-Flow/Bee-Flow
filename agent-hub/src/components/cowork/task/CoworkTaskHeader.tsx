/**
 * The top of an opened task (./CoworkTaskView.tsx): its status and its name. When it runs and who it sends to are in
 * its Settings, right under it. A task someone shared says when it runs, by whom it is shared, and what the reader
 * may do with it.
 *
 * Under it, the three actions an owner has: "Run for real now", Pause or Resume, and Share (which opens the Share row
 * under People). A button that is off says why, on the button and in a line under the buttons: while something is on
 * the go, and for running also while the task waits for its owner (its steps wait for approval or a first test, or
 * something has to be fixed first).
 */
import { Pause, Play, Share2 } from 'lucide-react';
import { SWAP } from '../coworkMotion';
import { isMailTriggerItem } from '../mailTrigger';
import CoworkStatusPill from '../CoworkStatusPill';
import { BTN_PRIMARY, BTN_QUIET, META, ROW_ACTIONS, TAG_ACCENT } from './taskUi';
import type { CoworkItem } from '@/api/cowork.types';
import type { TaskStatus } from '../coworkTaskStatus';
import type { TranslateFn } from '@/hooks/useTranslation';

interface SharedBy { owner: string; role: 'viewer' | 'approver' }

interface CoworkTaskHeaderProps {
    item: Pick<CoworkItem, 'title'>;
    status: TaskStatus;
    /** A task someone shared: when it runs, as its owner set it up. */
    meta?: string;
    sharedBy?: SharedBy | null;
    t: TranslateFn;
}

function SharedLine({ shared, t }: { shared: SharedBy; t: TranslateFn }) {
    return (
        <div className={`${ROW_ACTIONS} mt-1`} data-testid="cowork-task-shared-by">
            <span className={TAG_ACCENT}>{t('cowork_task.head.shared_by', 'Shared by {owner}', { owner: shared.owner })}</span>
            <span className={META}>
                {shared.role === 'approver'
                    ? t('cowork_task.head.shared_answer', 'You can see it and answer what it asks. Only {owner} can change it.', { owner: shared.owner })
                    : t('cowork_task.head.shared_see', 'You can see it. Only {owner} can change it.', { owner: shared.owner })}
            </span>
        </div>
    );
}

export default function CoworkTaskHeader({ item, status, meta, sharedBy = null, t }: CoworkTaskHeaderProps) {
    return (
        <header className="flex flex-col gap-1.5" data-testid="cowork-task-header">
            <div key={status} className={SWAP}><CoworkStatusPill status={status} /></div>
            <h1 className="m-0 text-[20px] leading-7 font-semibold break-words text-[var(--text-primary)] outline-none">
                {item.title || t('cowork_task.head.untitled', 'Untitled task')}
            </h1>
            {meta && <p className={META} data-testid="cowork-task-when">{meta}</p>}
            {sharedBy && <SharedLine shared={sharedBy} t={t} />}
        </header>
    );
}

/** What holds the task back from running for real now; null when nothing does. */
export type HeldBy = 'live' | 'approval' | 'test' | 'problem' | null;

/** Why a button is off, in one line; null when nothing holds the task back. */
function heldWords(heldBy: HeldBy, t: TranslateFn): string | null {
    switch (heldBy) {
        case 'live': return t('cowork_task.held.live', 'It is running or being tested right now. You can run or pause it once that is over.');
        case 'approval': return t('cowork_task.held.approval', 'It cannot run for real yet: its steps wait for your approval.');
        case 'test': return t('cowork_task.held.test', 'It cannot run for real yet: test it once first.');
        case 'problem': return t('cowork_task.held.problem', 'It cannot run for real yet: something needs you first. See below.');
        default: return null;
    }
}

interface ActionsProps {
    item: Pick<CoworkItem, 'id' | 'isActive' | 'triggerKind' | 'trigger'>;
    heldBy: HeldBy;
    /** A change of this task is being saved. */
    busy: boolean;
    onRunNow: () => void;
    onToggle: () => void;
    onShare: () => void;
    t: TranslateFn;
}

/** Run for real now, Pause or Resume, Share. A task a new mail starts cannot be run by hand, and says so. */
export function CoworkTaskActions({ item, heldBy, busy, onRunNow, onToggle, onShare, t }: ActionsProps) {
    const paused = item.isActive === false;
    const byMail = isMailTriggerItem({ triggerKind: item.triggerKind ?? null, trigger: item.trigger });
    const why = heldWords(heldBy, t);
    const live = heldBy === 'live';
    const whyId = `cowork-task-held-${item.id}`;
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-task-actions">
            <div className={ROW_ACTIONS}>
                {!byMail && (
                    <button type="button" className={BTN_PRIMARY} disabled={!!heldBy || busy} title={why ?? undefined} aria-describedby={why ? whyId : undefined} onClick={onRunNow}>
                        <Play aria-hidden="true" size={16} />{t('cowork_task.action.run_for_real', 'Run for real now')}
                    </button>
                )}
                <button type="button" className={BTN_QUIET} disabled={live || busy} title={live ? why ?? undefined : undefined} onClick={onToggle}>
                    {paused ? <Play aria-hidden="true" size={16} /> : <Pause aria-hidden="true" size={16} />}
                    {paused ? t('cowork_task.action.resume', 'Resume') : t('cowork_task.action.pause', 'Pause')}
                </button>
                <button type="button" className={BTN_QUIET} onClick={onShare}>
                    <Share2 aria-hidden="true" size={16} />{t('cowork_task.more.share', 'Share')}
                </button>
            </div>
            {why && <p key={why} id={whyId} className={`${META} ${SWAP}`} data-testid="cowork-task-held">{why}</p>}
            {byMail && !why && <p className={META}>{t('cowork_task.held.by_mail', 'It starts when a new e-mail arrives, so it cannot be started by hand.')}</p>}
        </div>
    );
}
