// One row of the hierarchy tree and the small pieces it is made of. The whole
// row opens the task (the title is a stretched button, so it keeps its own
// accessible name); the chevron, "+" and "…" sit above it and stop the click.
// Depth is a padding class, not an inline style, and a 1px guide line runs
// down each open branch so deep trees stay readable.

import { ChevronDown, ChevronRight, ExternalLink, MoreHorizontal, Plus } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { Avatar } from '../workspaceUi';
import { ProgressBar } from './sprintUi';
import { StatusGlyph, TypeChip } from './TaskFields';
import { rollup, storyPoints, workItemType, type WorkNode } from './taskPlanning';
import { AnchoredMenu, MENU_ITEM_CLASS, MENU_PANEL_CLASS } from './tasksMenu';

type T = ReturnType<typeof useTranslation>['t'];
type People = ReturnType<typeof useChatPeople>;

// 12px gutter plus 20px per level; the guide line sits under the parent's chevron centre.
const INDENT = ['pl-3', 'pl-8', 'pl-[52px]', 'pl-[72px]', 'pl-[92px]', 'pl-[112px]'];
const GUIDE = ['before:left-[22px]', 'before:left-[42px]', 'before:left-[62px]', 'before:left-[82px]', 'before:left-[102px]', 'before:left-[122px]'];
const at = (list: string[], depth: number) => list[Math.min(depth, list.length - 1)];

const ICON_BUTTON = 'relative z-[2] grid place-items-center flex-none rounded-md text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] transition-colors';
const REVEAL = 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100';

/** Right-aligned meta with a fixed width so the columns line up: parents show progress, leaves their points. */
function RowMeta({ node, t }: { node: WorkNode; t: T }) {
    const { task } = node;
    if (node.children.length) {
        const sums = rollup(node);
        const sentence = t('project_tasks.rollup_progress', '{done}/{total} done · {points} pts', { done: sums.done, total: sums.total, points: sums.points });
        // The short visible form is for the eye; screen readers get the full sentence (a title alone is not announced).
        return (
            <span className="flex flex-none items-center justify-end gap-2 sm:w-[180px] text-[11.5px] text-[var(--text-tertiary)] tabular-nums" data-testid={`hierarchy-rollup-${task.id}`}
                title={sentence}>
                <span className="sr-only">{sentence}</span>
                <span aria-hidden="true">{sums.done}/{sums.total}</span>
                <span className="hidden sm:block w-12 flex-none" aria-hidden="true">
                    <ProgressBar value={sums.done} max={sums.total} label={sentence} className="w-12" />
                </span>
                <span className="sm:w-12 text-right" aria-hidden="true">{sums.points ? t('project_tasks.points_short', '{points} pts', { points: sums.points }) : ''}</span>
            </span>
        );
    }
    const points = storyPoints(task);
    return (
        <span className="flex flex-none items-center justify-end sm:w-[180px] text-[11.5px] text-[var(--text-tertiary)] tabular-nums">
            {points ? <span className="sm:w-12 text-right">{t('project_tasks.points_short', '{points} pts', { points })}</span> : null}
        </span>
    );
}

/** The "…" menu: every hover action again, reachable by keyboard and touch. */
function RowMenu({ task, canAddChild, onOpen, onAddChild, onNewSibling, t }: {
    task: ProjectTask; canAddChild: boolean; onOpen: () => void; onAddChild: () => void; onNewSibling?: () => void; t: T;
}) {
    const anchorRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    // Stable, so AnchoredMenu's focus effect does not re-run (and refocus the first item) on every render.
    const close = useCallback(() => setOpen(false), []);
    const pick = (fn: () => void) => () => { setOpen(false); fn(); };
    const label = t('project_tasks.row_actions', 'More actions for {title}', { title: task.title || t('project_tasks.untitled', 'Untitled task') });
    return (
        <>
            <button ref={anchorRef} type="button" onClick={() => setOpen(v => !v)} aria-haspopup="menu" aria-expanded={open}
                aria-label={label} title={label} data-testid={`hierarchy-menu-${task.id}`} className={`${ICON_BUTTON} ${REVEAL} w-7 h-7`}>
                <MoreHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={close} anchorRef={anchorRef} align="right" minWidth={208} role="menu" aria-label={label}
                className={MENU_PANEL_CLASS}>
                <button type="button" role="menuitem" className={MENU_ITEM_CLASS} onClick={pick(onOpen)}>
                    <ExternalLink className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />{t('project_tasks.open_item', 'Open')}
                </button>
                {canAddChild && (
                    <button type="button" role="menuitem" className={MENU_ITEM_CLASS} onClick={pick(onAddChild)}>
                        <Plus className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />{t('project_tasks.add_child_short', 'Add child')}
                    </button>
                )}
                {onNewSibling && (
                    <button type="button" role="menuitem" className={MENU_ITEM_CLASS} onClick={pick(onNewSibling)}>
                        <Plus className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />{t('project_tasks.new_sibling', 'New sibling')}
                    </button>
                )}
            </AnchoredMenu>
        </>
    );
}

export interface RowProps {
    node: WorkNode; depth: number; collapsed: Set<string>; onToggle: (id: string) => void;
    canEdit: boolean; onOpen: (task: ProjectTask) => void; onAddChild: (task: ProjectTask) => void;
    /** Starts an item next to this one; absent when there is no sensible place for it. */
    newSibling: (task: ProjectTask) => (() => void) | undefined;
    people?: People; t: T;
}

export function HierarchyRow(props: RowProps) {
    const { node, depth, collapsed, onToggle, canEdit, onOpen, onAddChild, newSibling, people, t } = props;
    const { task } = node;
    const type = workItemType(task);
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(task.id);
    const canAddChild = canEdit && type !== 'task';
    const done = task.status === 'done';
    const title = task.title || t('project_tasks.untitled', 'Untitled task');
    return (
        <li className="list-none">
            <div className={`group relative flex items-center gap-2 h-10 pr-2 ${at(INDENT, depth)} hover:bg-[var(--item-hover-bg)] focus-within:bg-[var(--item-hover-bg)] transition-colors cursor-pointer`} data-testid={`hierarchy-row-${task.id}`}>
                {hasChildren ? (
                    <button type="button" onClick={() => onToggle(task.id)} aria-expanded={!isCollapsed}
                        aria-label={isCollapsed ? t('project_tasks.expand_item', 'Expand {title}', { title }) : t('project_tasks.collapse_item', 'Collapse {title}', { title })}
                        className={`${ICON_BUTTON} w-5 h-5`}>
                        {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
                    </button>
                ) : <span className="w-5 flex-none" aria-hidden="true" />}
                <StatusGlyph status={task.status} />
                <TypeChip type={type} />
                {/* Stretched over the row: one click target with the title as its name. */}
                <button type="button" onClick={() => onOpen(task)}
                    className={`min-w-0 flex-1 truncate text-left text-[13px] after:absolute after:inset-0 after:content-[''] after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-[var(--accent-primary)] ${type === 'epic' ? 'font-semibold' : 'font-medium'} ${done ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]'}`}>
                    {title}
                </button>
                <RowMeta node={node} t={t} />
                {people && (
                    <span className="hidden sm:flex w-10 flex-none justify-end -space-x-1.5" title={task.assigneeIds.map(id => people.nameOf(id)).filter(Boolean).join(', ') || undefined}>
                        {task.assigneeIds.slice(0, 2).map(id => <Avatar key={id} name={people.nameOf(id)} size="sm" picture={people.avatarOf(id)} color={people.colorOf(id)} />)}
                    </span>
                )}
                {canEdit && <span className="flex flex-none items-center gap-0.5 w-[58px] justify-end">
                    {canAddChild && (
                        <button type="button" onClick={() => onAddChild(task)} data-testid={`hierarchy-add-child-${task.id}`}
                            aria-label={t('project_tasks.add_child', 'Add an item inside {title}', { title })}
                            title={t('project_tasks.add_child', 'Add an item inside {title}', { title })}
                            className={`${ICON_BUTTON} ${REVEAL} w-7 h-7`}>
                            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    )}
                    <RowMenu task={task} canAddChild={canAddChild} onOpen={() => onOpen(task)} onAddChild={() => onAddChild(task)} onNewSibling={newSibling(task)} t={t} />
                </span>}
            </div>
            {hasChildren && !isCollapsed && (
                <ul className={`relative m-0 p-0 before:absolute before:inset-y-0 before:z-[1] before:w-px before:bg-[var(--border-subtle)] before:pointer-events-none ${at(GUIDE, depth)}`}>
                    {node.children.map(child => <HierarchyRow key={child.task.id} {...props} node={child} depth={depth + 1} />)}
                </ul>
            )}
        </li>
    );
}
