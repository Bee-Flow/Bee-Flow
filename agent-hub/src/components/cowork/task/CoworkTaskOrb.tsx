import { type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTaskInteractionBusy } from '@/api/coworkProposals';
import CoworkOrb, { HasTaskOrb, type ActivityTone } from '../CoworkOrb';
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
    work: OrbWork; composer: ReactNode; live: boolean; thinking: boolean; saved: boolean; heading: ReactNode;
    children: ReactNode; t: TranslateFn;
}

/** Detailed results, forms and Advanced can grow independently of Bee and the conversation. */
export function TaskAnchor({ heading, work, tone = 'rest' }: {heading: ReactNode; work: OrbWork; tone?: ActivityTone}) {
    return <div className="cowork-task-anchor">
        <div className="cowork-task-identity">{heading}</div>
        <CoworkOrb work={work} tone={tone} />
    </div>;
}

export default function CoworkTaskOrb({ back, status, coworkId, view, select, onAdvanced, work, composer, live, thinking, saved, heading, children, t }: Props) {
    const names = labels(t);
    const busy = useTaskInteractionBusy(coworkId);
    const workspace = live || view === 'edit' || view === 'overview';
    const hasCancel = ['run', 'pause', 'resume', 'delete'].includes(view);
    return <div className={'cowork-task-guided flex flex-col gap-4' + (workspace ? '' : ' is-detail')} data-testid="cowork-task-view" data-status={status} data-view={view}>
        {!workspace && <TaskAnchor heading={heading} work={thinking ? {...work, action: 'thinking'} : work} tone={thinking ? 'thinking' : 'rest'} />}
        <div key={workspace ? 'workspace' : view} className="cowork-task-scroll">
            {workspace && <div className="cowork-task-identity">{heading}</div>}
            <section aria-label={names[view]} className={workspace ? undefined : 'cowork-detail-content w-full min-w-0 text-left'}>
                {!workspace && <h2 className="text-base font-semibold">{names[view]}</h2>}
                {saved && !workspace && <p role="status">{t('cowork_task.edit.saved', 'Saved')}</p>}
                <HasTaskOrb.Provider value={!workspace}>{children}</HasTaskOrb.Provider>
            </section>
        </div>
        {composer}
        <footer className="cowork-task-footer">
            {workspace || hasCancel ? back : <button type="button" className={LINK_INLINE} onClick={() => select('overview')}><ArrowLeft size={14}/>{names.overview}</button>}
            <button type="button" className={LINK_INLINE} disabled={busy} onClick={onAdvanced}>{t('cowork_overview.advanced', 'Advanced')}</button>
        </footer>
    </div>;
}
