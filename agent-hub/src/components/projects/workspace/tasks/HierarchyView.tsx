// The work items as a tree: epics at the top, stories under them, tasks at the
// leaves, all in one card with a divider between top-level branches. Parents
// carry a rollup of what is done underneath; a row's hover actions (and its
// "…" menu) start a new child or sibling of the right type in the task dialog.

import { ChevronsDownUp, ChevronsUpDown, ListTree, Plus } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import scopedStorage from '../../../../utils/scopedStorage';
import EmptyState from '../../../shared/EmptyState';
import type { useChatPeople } from '../chat/chatPeople';
import { GhostButton } from '../workspaceUi';
import { HierarchyRow } from './HierarchyRow';
import { buildWorkTree, storyPoints, workItemType, type WorkNode, type WorkRollup } from './taskPlanning';

const GROUP_LABEL = 'text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)] m-0';

function collapsedKey(projectId: string) { return `projectTaskHierarchy:${projectId}`; }

function readCollapsed(projectId: string): Set<string> {
    try {
        const saved = JSON.parse(scopedStorage.getItem(collapsedKey(projectId)) || '[]');
        return new Set(Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : []);
    } catch { return new Set(); }
}

/** Every item in the tree that has children, i.e. everything "Collapse all" folds. */
function parentIds(roots: WorkNode[]): string[] {
    const ids: string[] = [];
    const walk = (n: WorkNode) => { if (n.children.length) { ids.push(n.task.id); n.children.forEach(walk); } };
    roots.forEach(walk);
    return ids;
}

/** The card's top line: overall progress on the left, fold-all and "New epic" on the right. */
function TreeHeader({ totals, anyCollapsed, canToggle, onToggleAll, onNewEpic, t }: {
    totals: WorkRollup; anyCollapsed: boolean; canToggle: boolean; onToggleAll: () => void; onNewEpic?: () => void;
    t: ReturnType<typeof useTranslation>['t'];
}) {
    const allLabel = anyCollapsed ? t('project_tasks.expand_all', 'Expand all') : t('project_tasks.collapse_all', 'Collapse all');
    return (
        <div className="flex flex-wrap items-center gap-2 min-h-9 px-3 border-b border-[var(--border-subtle)]">
            <span className="text-[11.5px] text-[var(--text-tertiary)] tabular-nums" data-testid="hierarchy-summary">
                {t('project_tasks.hierarchy_summary', '{done}/{total} done', { done: totals.done, total: totals.total })}
                {totals.points ? ` · ${t('project_tasks.points_short', '{points} pts', { points: totals.points })}` : ''}
            </span>
            <span className="ml-auto flex items-center gap-1">
                {canToggle && (
                    <GhostButton onClick={onToggleAll} data-testid="hierarchy-toggle-all" title={allLabel}>
                        {anyCollapsed ? <ChevronsUpDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronsDownUp className="w-3.5 h-3.5" aria-hidden="true" />}
                        {allLabel}
                    </GhostButton>
                )}
                {onNewEpic && (
                    <GhostButton onClick={onNewEpic} data-testid="hierarchy-new-epic">
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.new_epic', 'New epic')}
                    </GhostButton>
                )}
            </span>
        </div>
    );
}

export default function HierarchyView({ projectId, tasks, canEdit, onOpen, onAddChild, onNewEpic, people }: {
    projectId: string; tasks: ProjectTask[]; canEdit: boolean;
    onOpen: (task: ProjectTask) => void; onAddChild: (parent: ProjectTask) => void;
    /** Opens the task dialog preset to a new epic; powers "New epic" and the empty state's call to action. */
    onNewEpic?: () => void;
    /** Project members; when given, rows show up to two assignee avatars. */
    people?: ReturnType<typeof useChatPeople>;
}) {
    const { t } = useTranslation();
    const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(projectId));
    const { roots, ungrouped } = useMemo(() => buildWorkTree(tasks), [tasks]);
    const parents = useMemo(() => parentIds(roots), [roots]);
    const byId = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
    const totals = useMemo<WorkRollup>(() => ({
        total: tasks.length,
        done: tasks.filter(task => task.status === 'done').length,
        points: tasks.reduce((sum, task) => sum + (storyPoints(task) || 0), 0),
    }), [tasks]);

    const save = (next: Set<string>) => {
        try { scopedStorage.setItem(collapsedKey(projectId), JSON.stringify([...next])); } catch { /* optional preference */ }
        return next;
    };
    const toggle = (id: string) => {
        setCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return save(next);
        });
    };
    const anyCollapsed = parents.some(id => collapsed.has(id));
    const toggleAll = () => setCollapsed(save(new Set(anyCollapsed ? [] : parents)));

    // A sibling shares the parent, so it is a child of that parent; a root epic's sibling is a new epic.
    const newSibling = (task: ProjectTask) => {
        const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined;
        if (parent && !ungrouped.includes(task)) return () => onAddChild(parent);
        if (!task.parentTaskId && workItemType(task) === 'epic' && onNewEpic) return onNewEpic;
        return undefined;
    };

    if (!tasks.length) {
        return <EmptyState icon={<ListTree className="w-8 h-8" />} title={t('project_tasks.hierarchy_empty_title', 'No work items yet')}
            description={<span className="text-[12.5px]">{t('project_tasks.hierarchy_empty_desc', 'Start with an epic, break it into stories, and add the tasks underneath.')}</span>}
            action={onNewEpic ? { label: t('project_tasks.hierarchy_empty_cta', 'Create an epic'), onClick: onNewEpic } : undefined} />;
    }
    const rowProps = { collapsed, onToggle: toggle, canEdit, onOpen, onAddChild, newSibling, people, t };
    return (
        <section aria-label={t('project_tasks.view_hierarchy', 'Hierarchy')} data-testid="hierarchy-view"
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
            <TreeHeader totals={totals} anyCollapsed={anyCollapsed} canToggle={parents.length > 0} onToggleAll={toggleAll}
                onNewEpic={canEdit ? onNewEpic : undefined} t={t} />
            {roots.length > 0 && (
                <ul className="m-0 p-0 divide-y divide-[var(--border-subtle)]">
                    {roots.map(node => <HierarchyRow key={node.task.id} node={node} depth={0} {...rowProps} />)}
                </ul>
            )}
            {ungrouped.length > 0 && (
                <section aria-label={t('project_tasks.ungrouped', 'Ungrouped')} className={roots.length ? 'border-t border-[var(--border-subtle)]' : ''}>
                    <div className="flex items-center h-8 px-3 bg-[var(--bg-secondary)]/50 border-b border-[var(--border-subtle)]">
                        <h3 className={GROUP_LABEL}>
                            {t('project_tasks.ungrouped', 'Ungrouped')}
                            <span className="ml-1.5 font-normal tabular-nums">{ungrouped.length}</span>
                        </h3>
                    </div>
                    <ul className="m-0 p-0 divide-y divide-[var(--border-subtle)]">
                        {ungrouped.map(task => <HierarchyRow key={task.id} node={{ task, children: [] }} depth={0} {...rowProps} />)}
                    </ul>
                </section>
            )}
        </section>
    );
}
