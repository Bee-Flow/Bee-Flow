// Small pieces the Planning views share: the toolbar and icon button recipes,
// the status glyph, and a compact stack of faces. Kept here so the backlog and the
// timeline draw a task the same way.

import React from 'react';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { useChatPeople } from '../chat/chatPeople';
import { Avatar } from '../workspaceUi';
import { StatusGlyph } from './TaskFields';
import { statusLabel } from './taskText';

// The toolbar, icon button and menu row recipes are the ones every Tasks menu uses.
export { TOOLBAR_BUTTON_CLASS as TOOLBAR_BUTTON, ICON_BUTTON_CLASS as ICON_BUTTON, MENU_ITEM_CLASS as MENU_ITEM } from './tasksMenu';
export const MENU_SECTION = 'px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';
export const GROUP_LABEL = 'text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';
/** Hover-revealed on pointers, always shown on touch and while focused. */
export const REVEAL = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity';

type People = ReturnType<typeof useChatPeople>;

/** Where a task stands, in the list's glyphs; the word goes into the row's tooltip. */
export function StatusDot({ status }: { status: ProjectTask['status'] }) {
    return <StatusGlyph status={status} decorative />;
}

/** Up to `max` faces, overlapping; nothing when nobody has the task. */
export function Faces({ ids, people, max = 2 }: { ids: string[]; people: People; max?: number }) {
    if (!ids.length) return null;
    return (
        <span className="flex -space-x-1.5 flex-none" aria-hidden="true" title={ids.map(id => people.nameOf(id)).filter(Boolean).join(', ') || undefined}>
            {ids.slice(0, max).map(id => <Avatar key={id} name={people.nameOf(id)} size="sm" picture={people.avatarOf?.(id)} color={people.colorOf?.(id)} />)}
            {ids.length > max && <span className="grid place-items-center w-6 h-6 rounded-full bg-[var(--bg-secondary)] ring-2 ring-[var(--bg-card)] text-[10px] font-semibold text-[var(--text-tertiary)] tabular-nums">+{ids.length - max}</span>}
        </span>
    );
}

/** "Title · Alex, Sam · In progress": the facts a compact row leaves to its tooltip. */
export function useTaskTooltip(people: People) {
    const { t } = useTranslation();
    return (task: ProjectTask) => {
        const names = task.assigneeIds.map(id => people.nameOf(id)).filter(Boolean).join(', ') || t('project_tasks.not_assigned', 'Not assigned');
        return `${task.title} · ${names} · ${statusLabel(t, task.status)}`;
    };
}
