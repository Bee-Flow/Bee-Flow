/**
 * The top of an opened task (./CoworkTaskView.tsx): its status, its name, when it runs and who it sends to, and its
 * goal. A task someone shared says by whom, and what the reader may do with it. Under it, the three actions an owner
 * has: Run now, Pause or Resume, and Edit, each off while something is on the go, Run now also while the task waits
 * for its owner.
 */
import type { ReactNode } from 'react';
import { Pause, Pencil, Play } from 'lucide-react';
import { goalCountText } from '../coworkGoalModel';
import { whenLine } from '../coworkOverviewModel';
import { isMailTriggerItem } from '../mailTrigger';
import CoworkStatusPill from '../CoworkStatusPill';
import { BTN_PRIMARY, BTN_QUIET, META, ROW_ACTIONS, TAG_ACCENT } from './taskUi';
import type { CoworkGoal } from '@/api/coworkGoals';
import type { PlanPermissions } from '@/api/coworkPlan.types';
import type { CoworkItem } from '@/api/cowork.types';
import type { TaskStatus } from '../coworkTaskStatus';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { TaskMode } from './coworkTaskModel';

type HeaderItem = Pick<CoworkItem, 'title' | 'prompt' | 'isActive' | 'repeatInterval' | 'daysOfWeek' | 'timeOfDay' | 'nextRunAt' | 'lastStatus' | 'enabledApps' | 'trigger' | 'triggerKind'>;

/** Who it sends to, in a few words. */
export function sendsWords({ item, mode, sends }: { item: HeaderItem; mode: TaskMode; sends: PlanPermissions['sends'] | null }, t: TranslateFn): string {
    if (isMailTriggerItem({ triggerKind: item.triggerKind ?? null, trigger: item.trigger })) return t('cowork_task.head.sends_draft', 'drafts a reply to the sender');
    if (mode === 'steps' && sends === 'none') return t('cowork_task.head.sends_nothing', 'sends nothing');
    if (mode === 'steps' && sends === 'others') return t('cowork_task.head.sends_others', 'sends to other people');
    return t('cowork_task.head.sends_you', 'sends only to you');
}

interface SharedBy { owner: string; role: 'viewer' | 'approver' }

interface CoworkTaskHeaderProps {
    item: HeaderItem;
    status: TaskStatus;
    sends: string;
    goal: CoworkGoal | null;
    sharedBy?: SharedBy | null;
    /** When it runs, when the caller says it better (a link to the task it follows); else from the item. */
    when?: ReactNode;
    t: TranslateFn;
}

function GoalLine({ goal, t }: { goal: CoworkGoal; t: TranslateFn }) {
    const sentence = goal.sentence.replace(/[.!?]+$/, '');
    return (
        <p className={META} data-testid="cowork-task-goal">
            {t('cowork_task.head.goal', 'Goal: {sentence}. {count}.', { sentence, count: goalCountText(goal.count, t).replace(/^./, (c) => c.toUpperCase()) })}
        </p>
    );
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

export default function CoworkTaskHeader({ item, status, sends, goal, sharedBy = null, when, t }: CoworkTaskHeaderProps) {
    return (
        <header className="flex flex-col gap-1.5" data-testid="cowork-task-header">
            <div><CoworkStatusPill status={status} /></div>
            <h2 className="text-[26px] leading-[1.2] font-bold break-words text-[var(--text-primary)]">
                {item.title || t('cowork_task.head.untitled', 'Untitled task')}
            </h2>
            <p className={META} data-testid="cowork-task-when">{when ?? whenLine(item, t)} · {sends}</p>
            {goal && <GoalLine goal={goal} t={t} />}
            {sharedBy && <SharedLine shared={sharedBy} t={t} />}
        </header>
    );
}

interface ActionsProps {
    item: Pick<CoworkItem, 'isActive' | 'triggerKind' | 'trigger'>;
    /** A run, a try-out or the setting up of steps is on the go. */
    live: boolean;
    /** Something waits for the owner first. */
    blocked: boolean;
    busy: boolean;
    onRunNow: () => void;
    onToggle: () => void;
    onEdit: () => void;
    t: TranslateFn;
}

/** Run now, Pause or Resume, Edit. A task a new mail starts cannot be run by hand. */
export function CoworkTaskActions({ item, live, blocked, busy, onRunNow, onToggle, onEdit, t }: ActionsProps) {
    const paused = item.isActive === false;
    const byMail = isMailTriggerItem({ triggerKind: item.triggerKind ?? null, trigger: item.trigger });
    return (
        <div className={ROW_ACTIONS} data-testid="cowork-task-actions">
            {!byMail && (
                <button type="button" className={BTN_PRIMARY} disabled={live || blocked || busy} onClick={onRunNow}>
                    <Play aria-hidden="true" className="w-4 h-4" />{t('cowork_task.action.run_now', 'Run now')}
                </button>
            )}
            <button type="button" className={BTN_QUIET} disabled={live || busy} onClick={onToggle}>
                {paused ? <Play aria-hidden="true" className="w-4 h-4" /> : <Pause aria-hidden="true" className="w-4 h-4" />}
                {paused ? t('cowork_task.action.resume', 'Resume') : t('cowork_task.action.pause', 'Pause')}
            </button>
            <button type="button" className={BTN_QUIET} disabled={live} onClick={onEdit}>
                <Pencil aria-hidden="true" className="w-4 h-4" />{t('cowork_task.action.edit', 'Edit')}
            </button>
        </div>
    );
}
