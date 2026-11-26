import { type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTaskInteractionBusy } from '@/api/coworkProposals';
import CoworkActivity from '../CoworkActivity';
import type { OrbWork } from '../CoworkOrbSources';
import { LINK_INLINE } from '../coworkUi';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { TaskTab } from './CoworkTaskTabs';
import type { SettingRowId } from './coworkTaskSettingsModel';

export type OrbView = Exclude<TaskTab, 'settings'> | SettingRowId | 'edit' | 'actions' | 'overview' | 'review';

export const isSetting = (view: OrbView): view is SettingRowId => ['what', 'when', 'uses', 'sends'].includes(view);

function labels(t: TranslateFn): Record<OrbView, string> {
    return {
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
    coworkId: string; view: OrbView; select: (view: OrbView) => void; onAdvanced: () => void;
    work: OrbWork; composer: ReactNode; live: boolean; saved: boolean; heading: ReactNode;
    children: ReactNode; t: TranslateFn;
}

/** Keep only the selected task action on screen. Plan edits and live runs render their own evolving orb. */
export default function CoworkTaskOrb({ coworkId, view, select, onAdvanced, work, composer, live, saved, heading, children, t }: Props) {
    const names = labels(t);
    const busy = useTaskInteractionBusy(coworkId);

    const ownOrb = live || view === 'edit' || view === 'overview';
    const message = saved ? t('cowork_task.edit.saved', 'Saved') : names[view];
    return <div className="cowork-task-guided flex flex-col gap-4" data-testid="cowork-task-view">
        <div className="cowork-task-scroll">
        <div className="flex flex-wrap items-start justify-between gap-3">
            {heading}
            <div className="flex flex-wrap justify-end items-center gap-2">
                <button type="button" className={LINK_INLINE} disabled={busy} onClick={onAdvanced}>{t('cowork_overview.advanced', 'Advanced')}</button>
            </div>
        </div>
        {!ownOrb && <button type="button" className={LINK_INLINE + ' self-start'} onClick={() => select('overview')}><ArrowLeft size={14}/>{names.overview}</button>}
        <section aria-label={names[view]} className={ownOrb ? undefined : 'cowork-orb-detail'}>
            {ownOrb ? children : <CoworkActivity message={message} work={work} tone="rest">
                <div className="cowork-detail-content w-full min-w-0 text-left">{children}</div>
            </CoworkActivity>}
        </section>
        </div>
        {composer}

    </div>;
}
