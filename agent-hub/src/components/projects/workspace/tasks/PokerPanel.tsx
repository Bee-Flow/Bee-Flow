// Live planning poker for the whole project: pick an item, everyone votes on
// their own device, the facilitator reveals, and the agreed estimate is saved.
// A session can carry a queue (started with several tasks): each reveal then
// offers "Save estimate & next item" until the queue is empty. Without a
// session this shows the items still to estimate as one pickable list.

import { Check, Sparkles } from 'lucide-react';
import React, { useState } from 'react';
import { usePokerSessionQuery, useStartPokerSession, type ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { PrimaryButton, Skeleton } from '../workspaceUi';
import PokerSession from './PokerSession';
import { TypeChip } from './TaskFields';
import { storyPoints, workItemType } from './taskPlanning';
import { CARD, InfoTip, SECTION_LABEL } from './sprintUi';

function PokerSkeleton({ label }: { label: string }) {
    return (
        <div className={`${CARD} px-3.5 py-3`}>
            <Skeleton rows={3} variant="lines" label={label} testId="poker-skeleton" />
        </div>
    );
}

export default function PokerPanel({ projectId, tasks, canEdit, people }: { projectId: string; tasks: ProjectTask[]; canEdit: boolean; people: ReturnType<typeof useChatPeople> }) {
    const { t } = useTranslation();
    const query = usePokerSessionQuery(projectId);
    const start = useStartPokerSession(projectId);
    const [selected, setSelected] = useState<string | null>(null);
    const session = query.data;

    if (query.isPending) return <PokerSkeleton label={t('project_tasks.poker_loading', 'Loading live poker session…')} />;
    if (session) return <PokerSession projectId={projectId} session={session} canEdit={canEdit} people={people} startPending={start.isPending} outerError={start.error || query.error} />;

    const openItems = tasks.filter(task => task.status !== 'done' && !storyPoints(task));
    const error = start.error || query.error;
    return (
        <section className="space-y-2" aria-label={t('project_tasks.poker_choose_item', 'Choose an item for the team')}>
            <div className="flex h-7 items-center gap-2">
                <h3 className={SECTION_LABEL}>{t('project_tasks.poker_not_estimated', 'Not estimated')}<span className="ml-1.5 font-normal tabular-nums">{openItems.length}</span></h3>
            </div>
            <div className={`${CARD} overflow-hidden`}>
                {openItems.length ? (
                    <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
                        {openItems.map(task => (
                            <li key={task.id}>
                                <button type="button" onClick={() => setSelected(task.id)} aria-pressed={selected === task.id}
                                    className="group flex h-10 w-full items-center gap-3 px-3 text-left transition-colors hover:bg-[var(--item-hover-bg)] aria-pressed:bg-[var(--item-active-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-primary)]">
                                    <span className="grid w-4 h-4 flex-none place-items-center rounded-full border border-[var(--border-default)] group-aria-pressed:border-[var(--accent-primary)] group-aria-pressed:bg-[var(--accent-primary)] group-aria-pressed:text-[var(--accent-primary-fg)]" aria-hidden="true">
                                        {selected === task.id && <Check className="w-2.5 h-2.5" />}
                                    </span>
                                    <TypeChip type={workItemType(task)} />
                                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">{task.title}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : <p className="m-0 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.poker_all_estimated', 'All open work items already have estimates.')}</p>}
                {openItems.length > 0 && (
                    <div className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
                        <InfoTip text={t('project_tasks.poker_start_hint', 'Everyone in this project can join from their own device. Cards stay hidden until they are revealed.')} />
                        <PrimaryButton disabled={!canEdit || !selected || start.isPending} busy={start.isPending} onClick={() => selected && start.mutate({ taskId: selected })}>
                            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.poker_start_button', 'Start planning poker')}
                        </PrimaryButton>
                    </div>
                )}
            </div>
            {error && <p role="alert" className="m-0 text-[12.5px] text-[var(--error-ink)]">{error.message}</p>}
        </section>
    );
}
