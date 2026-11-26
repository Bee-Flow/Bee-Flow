import { type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTaskInteractionBusy } from '@/api/coworkProposals';
import CoworkActivity from '../CoworkActivity';
import type { OrbWork } from '../CoworkOrbSources';
import { LINK_INLINE } from '../coworkUi';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { TaskStatus } from '../coworkTaskStatus';
import type { TaskTab } from './CoworkTaskTabs';
import type { TaskOperation } from './CoworkOperationReview';
import type { SettingRowId } from './coworkTaskSettingsModel';

export type OrbView = 'goal' | 'memory' | 'budget' | 'changes' | 'proof' | 'test' | 'compare' | TaskOperation | Exclude<TaskTab, 'settings'> | SettingRowId | 'edit' | 'actions' | 'overview' | 'review' | 'delete';

export const isSetting = (view: OrbView): view is SettingRowId => ['what', 'when', 'uses', 'sends'].includes(view);

function labels(t: TranslateFn): Record<OrbView, string> {
    return {
        goal: t('cowork_task.target.heading', 'Target to track'),
        memory: t('cowork_task.remembers.heading', 'What it remembers'),
        budget: t('cowork_task.limit.heading', 'Spending limit'),
        changes: t('cowork_task.history.changes', 'Changes'),
        proof: t('cowork_task.history.proof', 'Proof of each run'),
        test: t('cowork_task.steps.test', 'Test, sends nothing'),
        compare: t('cowork_task.steps.compare', 'Compare with last month'),
        run: t('cowork_task.action.run_for_real', 'Run for real now'),
        pause: t('cowork_task.action.pause', 'Pause'),
        resume: t('cowork_task.action.resume', 'Resume'),
        delete: t('cowork_task.more.delete', 'Delete this task'),
        review: t('cowork_task.orb.review_result', 'Review task'),
        overview: t('cowork_task.orb.back', 'Back to the orb'),
        result: t('cowork_task.tabs.result', 'Result'),
        edit: t('cowork_task.edit.task', 'Adjust this task'),
        when: t('cowork_task.orb.schedule', 'Schedule'),
        what: t('cowork_home.activity.edit_brief', 'Edit task instructions'),
        uses: t('cowork_task.set.uses', 'Uses'),
        sends: t('cowork_task.set.sends', 'Sends to'),
        steps: t('cowork_task.orb.tests', 'Tests and permissions'),
        people: t('cowork_task.people.heading', 'People'),
        history: t('cowork_task.history.heading', 'History'),
        actions: t('cowork_home.activity.task_actions', 'Task actions'),
    };
}

interface Props {
    back: ReactNode; status: TaskStatus; coworkId: string; view: OrbView; select: (view: OrbView) => void; onAdvanced: () => void;
    work: OrbWork; composer: ReactNode; live: boolean; saved: boolean; heading: ReactNode;
    children: ReactNode; t: TranslateFn;
}

/** Keep only the selected task action on screen. Plan edits and live runs render their own evolving orb. */
export default function CoworkTaskOrb({ back, status, coworkId, view, select, onAdvanced, work, composer, live, saved, heading, children, t }: Props) {
    const names = labels(t);
    const busy = useTaskInteractionBusy(coworkId);

    const ownOrb = live || view === 'edit' || view === 'overview';
    const message = saved ? t('cowork_task.edit.saved', 'Saved') : names[view];
    return <div className="cowork-task-guided flex flex-col gap-4" data-testid="cowork-task-view" data-status={status}>
        <div className="cowork-task-scroll">
        <div className="cowork-task-identity">{heading}</div>
        {!ownOrb && !['run', 'pause', 'resume'].includes(view) && <button type="button" className={LINK_INLINE + ' self-start'} onClick={() => select('overview')}><ArrowLeft size={14}/>{names.overview}</button>}
        <section aria-label={names[view]} className={ownOrb ? undefined : 'cowork-orb-detail'}>
            {ownOrb ? children : <CoworkActivity message={message} work={work} tone="rest">
                <div className="cowork-detail-content w-full min-w-0 text-left">{children}</div>
            </CoworkActivity>}
        </section>
        </div>
        {composer}
        <footer className="cowork-task-footer">
            {back}
            <button type="button" className={LINK_INLINE} disabled={busy} onClick={onAdvanced}>{t('cowork_overview.advanced', 'Advanced')}</button>
        </footer>

    </div>;
}
