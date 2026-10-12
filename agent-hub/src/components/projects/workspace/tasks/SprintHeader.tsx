// The header of one sprint: name and status, dates and goal on one meta line,
// the single primary action (Start or Complete) and a "…" menu with Rename,
// the goal and Delete (planned sprints only). Each step asks first. A rename
// also rewrites the items' `bf:sprint:<name>` mirror labels: the server does not
// (the labels are sealed per task), and a stale label would pull those tasks into
// a later sprint of the old name. A failed rewrite is reported in one toast.

import { CheckCheck, MoreHorizontal, Pencil, Play, Target, Trash2 } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { useUpdateTask, type ProjectTask } from '../../../../api/queries/projectTasks';
import { useCompleteSprint, useDeleteSprint, useStartSprint, useUpdateSprint, type Sprint } from '../../../../api/queries/projectSprints';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';
import { projectErrorText } from '../projectErrorText';
import { PrimaryButton } from '../workspaceUi';
import { sprintName, withPlanningMeta } from './taskPlanning';
import { AnchoredMenu, formatSprintDates, ICON_BUTTON, MENU_ICON, MENU_ITEM, MENU_PANEL, META, SMALL_INPUT, SprintStatusChip } from './sprintUi';

/** Rename the sprint or change its goal, in place of the header text. */
function InlineEdit({ value, label, maxLength, onSave, onCancel, className }: {
    value: string; label: string; maxLength: number; onSave: (next: string) => void; onCancel: () => void; className: string;
}) {
    const [draft, setDraft] = useState(value);
    // Enter or Escape ends the edit; the blur that may follow must not save a second time.
    const settled = useRef(false);
    const finish = (save: boolean) => {
        if (settled.current) return;
        settled.current = true;
        if (save) onSave(draft); else onCancel();
    };
    return (
        <input autoFocus className={`${SMALL_INPUT} ${className}`} value={draft} maxLength={maxLength} aria-label={label}
            onChange={e => setDraft(e.target.value)} onBlur={() => finish(true)}
            onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); finish(true); }
                if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            }} />
    );
}

function SprintMenu({ sprint, busy, onEdit, onDelete }: { sprint: Sprint; busy: boolean; onEdit: (field: 'name' | 'goal') => void; onDelete: () => void }) {
    const { t } = useTranslation();
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    const label = t('project_tasks.sprint_more', 'More sprint actions');
    const pick = (fn: () => void) => { setOpen(false); fn(); };
    return (
        <>
            <button ref={anchorRef} type="button" className={`${ICON_BUTTON} !w-8 !h-8`} aria-haspopup="menu" aria-expanded={open}
                aria-label={label} title={label} onClick={() => setOpen(o => !o)} data-testid="sprint-more">
                <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right" width={208} role="menu" aria-label={label} className={MENU_PANEL}>
                <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => pick(() => onEdit('name'))}>
                    <Pencil className={MENU_ICON} aria-hidden="true" />{t('project_tasks.sprint_rename', 'Rename')}
                </button>
                <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => pick(() => onEdit('goal'))}>
                    <Target className={MENU_ICON} aria-hidden="true" />{sprint.goal ? t('project_tasks.sprint_edit_goal', 'Edit goal') : t('project_tasks.sprint_add_goal', 'Add goal')}
                </button>
                {sprint.status === 'planned' && <>
                    <div className="my-1 border-t border-[var(--border-subtle)]" role="separator" />
                    <button type="button" role="menuitem" className={`${MENU_ITEM} !text-[var(--error-ink)]`} disabled={busy}
                        onClick={() => pick(onDelete)} data-testid="sprint-delete">
                        <Trash2 className="w-3.5 h-3.5 flex-none" aria-hidden="true" />{t('project_tasks.sprint_delete', 'Delete sprint')}
                    </button>
                </>}
            </AnchoredMenu>
        </>
    );
}

export default function SprintHeader({ projectId, sprint, items = [], canEdit, onDeleted }: {
    projectId: string; sprint: Sprint; canEdit: boolean; onDeleted: () => void;
    /** The sprint's tasks, so a rename can carry their legacy mirror labels along. */
    items?: ProjectTask[];
}) {
    const { t, locale } = useTranslation();
    const startSprint = useStartSprint(projectId);
    const completeSprint = useCompleteSprint(projectId);
    const deleteSprint = useDeleteSprint(projectId);
    const updateSprint = useUpdateSprint(projectId);
    const updateTask = useUpdateTask(projectId);
    const { confirm, confirmDialog } = useConfirm();
    const [editing, setEditing] = useState<'name' | 'goal' | null>(null);
    const onError = (e: Error) => toast.error(projectErrorText(t, e));
    const cancelLabel = t('project_content.cancel', 'Cancel');

    const startNow = async () => {
        if (await confirm({ title: t('project_tasks.sprint_start_title', 'Start this sprint?'), description: t('project_tasks.sprint_start_hint', 'It becomes the active sprint; any other active sprint goes back to planned.'), confirmLabel: t('project_tasks.sprint_start', 'Start sprint'), cancelLabel }))
            startSprint.mutate(sprint.id, { onSuccess: () => toast.success(t('project_tasks.sprint_started', 'Sprint started')), onError });
    };
    const completeNow = async () => {
        if (await confirm({ title: t('project_tasks.sprint_complete_title', 'Complete this sprint?'), description: t('project_tasks.sprint_complete_hint', 'It moves to the history; unfinished items stay on the board.'), confirmLabel: t('project_tasks.sprint_complete', 'Complete sprint'), cancelLabel }))
            completeSprint.mutate(sprint.id, { onSuccess: () => toast.success(t('project_tasks.sprint_completed', 'Sprint completed')), onError });
    };
    const deleteNow = async () => {
        if (await confirm({ title: t('project_tasks.sprint_delete_title', 'Delete this sprint?'), description: t('project_tasks.sprint_delete_hint', 'The tasks stay; they simply leave the sprint.'), confirmLabel: t('project_tasks.sprint_delete', 'Delete sprint'), cancelLabel, destructive: true }))
            deleteSprint.mutate(sprint.id, { onSuccess: () => { onDeleted(); toast.success(t('project_tasks.sprint_deleted', 'Sprint deleted')); }, onError });
    };
    // The server renames only the sprint; the items' legacy mirror labels follow here. One toast
    // for whatever failed, so a partial rewrite never goes unnoticed (nor floods the screen).
    const carryMirrorLabels = async (oldName: string, newName: string) => {
        const stale = items.filter(task => sprintName(task) === oldName);
        const results = await Promise.allSettled(stale.map(task => updateTask.mutateAsync(
            { id: task.id, patch: { labels: withPlanningMeta(task.labels, { sprint: newName }) } })));
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed) {
            toast.error(t('project_tasks.sprint_rename_labels_failed', 'The sprint is renamed, but {count} of its items still carry the old name.', { count: failed }));
        }
    };
    const save = (field: 'name' | 'goal', value: string) => {
        setEditing(null);
        const clean = value.trim();
        if (field === 'name' ? !clean || clean === sprint.name : clean === (sprint.goal || '')) return;
        if (field === 'goal') { updateSprint.mutate({ sprintId: sprint.id, patch: { goal: clean } }, { onError }); return; }
        const oldName = sprint.name;
        updateSprint.mutate({ sprintId: sprint.id, patch: { name: clean } }, {
            onSuccess: () => void carryMirrorLabels(oldName, clean),
            onError,
        });
    };
    const stopEditing = () => setEditing(null);

    return (
        <header className="space-y-1">
            <div className="flex min-h-8 flex-wrap items-center gap-2">
                {editing === 'name'
                    ? <InlineEdit value={sprint.name} label={t('project_tasks.sprint_name', 'Sprint name')} maxLength={60} className="!w-64 max-w-full font-semibold" onSave={v => save('name', v)} onCancel={stopEditing} />
                    : <h3 className="m-0 min-w-0 truncate text-[15px] font-semibold text-[var(--text-primary)]">{sprint.name}</h3>}
                <SprintStatusChip status={sprint.status} />
                {canEdit && (
                    <div className="ml-auto flex items-center gap-1">
                        {sprint.status === 'planned' && <PrimaryButton onClick={() => void startNow()} busy={startSprint.isPending} data-testid="sprint-start"><Play className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.sprint_start', 'Start sprint')}</PrimaryButton>}
                        {sprint.status === 'active' && <PrimaryButton onClick={() => void completeNow()} busy={completeSprint.isPending} data-testid="sprint-complete"><CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.sprint_complete', 'Complete sprint')}</PrimaryButton>}
                        <SprintMenu sprint={sprint} busy={deleteSprint.isPending} onEdit={setEditing} onDelete={() => void deleteNow()} />
                    </div>
                )}
            </div>
            {editing === 'goal'
                ? <InlineEdit value={sprint.goal || ''} label={t('project_tasks.sprint_goal', 'Goal')} maxLength={200} className="max-w-xl" onSave={v => save('goal', v)} onCancel={stopEditing} />
                : <p className={`m-0 truncate ${META}`} title={sprint.goal || undefined}>{formatSprintDates(t, sprint, locale)}{sprint.goal ? ` · ${sprint.goal}` : ''}</p>}
            {confirmDialog}
        </header>
    );
}
