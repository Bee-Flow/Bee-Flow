// The sprints of a project, backed by the server, as a master/detail view: the
// open sprints in a compact list on the left (with "New sprint" opening a small
// form inside that list, and the finished ones folded underneath), the chosen
// sprint on the right. Starting, completing and filling a sprint live in
// SprintDetail; membership is mirrored into `bf:sprint:*` labels there.

import { CalendarDays, ChevronDown, ChevronRight, Plus, Sparkles, Upload } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { useCreateSprint, useProjectSprintsQuery, type Sprint } from '../../../../api/queries/projectSprints';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import scopedStorage from '../../../../utils/scopedStorage';
import EmptyState from '../../../shared/EmptyState';
import type { useChatPeople } from '../chat/chatPeople';
import { GhostButton, Notice } from '../workspaceUi';
import SprintCreateForm from './SprintCreateForm';
import SprintDetail from './SprintDetail';
import { sprintName } from './taskPlanning';
import {
    AnchoredMenu, CARD, formatSprintDates, MENU_ICON, MENU_ITEM, MENU_PANEL, META, ProgressBar, ROW_LIST, SECTION_LABEL, SprintStatusChip,
    TOOLBAR_BUTTON,
} from './sprintUi';

/** Does this task belong to the sprint? The column is the truth; the label is the legacy mirror. */
function inSprint(task: ProjectTask, sprint: Sprint): boolean {
    return task.sprintId === sprint.id || sprintName(task) === sprint.name;
}

const BAR = 'block h-2.5 animate-pulse rounded-full bg-[var(--bg-secondary)]';

/** Pulsing placeholders while the sprints load, echoing the list and the detail. */
function SprintsSkeleton({ label }: { label: string }) {
    return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[260px_minmax(0,1fr)]" role="status" aria-label={label} data-testid="sprints-skeleton">
            <div className={`${CARD} divide-y divide-[var(--border-subtle)]`}>
                {['w-1/2', 'w-2/3', 'w-2/5'].map(width => (
                    <div key={width} className="space-y-2 px-3 py-3" aria-hidden="true">
                        <span className={`${BAR} h-3 ${width}`} />
                        <span className={`${BAR} w-3/4`} />
                        <span className={`${BAR} h-1 w-full`} />
                    </div>
                ))}
            </div>
            <div className="hidden space-y-3 md:block" aria-hidden="true">
                <span className={`${BAR} h-4 w-1/3`} />
                <span className={`${BAR} w-1/2`} />
                <div className={`${CARD} h-40`} />
            </div>
        </div>
    );
}

function SprintListRow({ sprint, selected, onSelect, t, locale }: { sprint: Sprint; selected: boolean; onSelect: () => void; t: TranslateFn; locale: string }) {
    const capacity = sprint.capacityPoints || 0;
    const over = capacity > 0 && sprint.pointsTotal > capacity;
    return (
        <li>
            <button type="button" onClick={onSelect} aria-pressed={selected} data-testid={`sprint-card-${sprint.id}`}
                className="block w-full space-y-1 px-3 py-2.5 text-left transition-colors hover:bg-[var(--item-hover-bg)] aria-pressed:bg-[var(--item-active-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-primary)]">
                <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">{sprint.name}</span>
                    <SprintStatusChip status={sprint.status} />
                </span>
                <span className={`block truncate tabular-nums ${META}`}>
                    {formatSprintDates(t, sprint, locale)} · {sprint.itemCount
                        ? t('project_tasks.sprint_done_short', '{done}/{total} done', { done: sprint.doneCount, total: sprint.itemCount })
                        : t('project_tasks.sprint_items_count', '{count} items', { count: 0 })}
                </span>
                <span className="flex items-center gap-2 pt-0.5">
                    <ProgressBar value={sprint.doneCount} max={sprint.itemCount} className="flex-1"
                        label={t('project_tasks.sprint_done_short', '{done}/{total} done', { done: sprint.doneCount, total: sprint.itemCount })} />
                    <span className={`flex-none text-[11px] tabular-nums ${over ? 'text-[var(--warning-ink)]' : 'text-[var(--text-tertiary)]'}`}>
                        {capacity
                            ? t('project_tasks.sprint_capacity_short', '{points}/{capacity} pts', { points: sprint.pointsTotal, capacity })
                            : t('project_tasks.points_short', '{points} pts', { points: sprint.pointsTotal })}
                    </span>
                </span>
            </button>
        </li>
    );
}

/** "New sprint ▾": a new sprint here, or the guided poker builder. */
function NewSprintMenu({ onNew, onPlanWithPoker }: { onNew: () => void; onPlanWithPoker?: () => void }) {
    const { t } = useTranslation();
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    const pick = (fn: () => void) => { setOpen(false); fn(); };
    if (!onPlanWithPoker) {
        return <button type="button" className={TOOLBAR_BUTTON} onClick={onNew}><Plus className="w-4 h-4" aria-hidden="true" />{t('project_tasks.sprint_new', 'New sprint')}</button>;
    }
    return (
        <>
            <button ref={anchorRef} type="button" className={TOOLBAR_BUTTON} onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} data-testid="sprint-new-menu">
                <Plus className="w-4 h-4" aria-hidden="true" />{t('project_tasks.sprint_new', 'New sprint')}<ChevronDown className="w-3 h-3" aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right" width={224} role="menu"
                aria-label={t('project_tasks.sprint_new', 'New sprint')} className={MENU_PANEL}>
                <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => pick(onNew)}><Plus className={MENU_ICON} aria-hidden="true" />{t('project_tasks.sprint_new', 'New sprint')}</button>
                <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => pick(onPlanWithPoker)} data-testid="plan-sprint-with-poker">
                    <Sparkles className={MENU_ICON} aria-hidden="true" />{t('project_tasks.plan_with_poker', 'Plan with poker')}
                </button>
            </AnchoredMenu>
        </>
    );
}

/** The finished sprints, folded under the list like a status group. */
function SprintHistory({ closed, t, locale }: { closed: Sprint[]; t: TranslateFn; locale: string }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="pt-2" data-testid="sprint-history">
            <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
                className={`${SECTION_LABEL} flex h-7 items-center gap-1 rounded hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]`}>
                {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />}
                {t('project_tasks.sprint_history', 'Finished sprints')}<span className="ml-1 font-normal tabular-nums">{closed.length}</span>
            </button>
            {open && (
                <ul className={`${ROW_LIST} mt-1`}>
                    {closed.map(sprint => (
                        <li key={sprint.id} className="px-3 py-2">
                            <span className="block truncate text-[13px] text-[var(--text-secondary)]">{sprint.name}</span>
                            <span className={`block truncate tabular-nums ${META}`}>
                                {formatSprintDates(t, sprint, locale)} · {t('project_tasks.sprint_done_short', '{done}/{total} done', { done: sprint.doneCount, total: sprint.itemCount })} · {t('project_tasks.points_short', '{points} pts', { points: sprint.pointsDone })}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

const NEW_ROW = 'flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] '
    + 'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-primary)]';

/** The left pane: open sprints as rows, "New sprint" as the last row (expanding into the form), the history below. */
function SprintList({ projectId, open, closed, selectedId, onSelect, canEdit, creating, setCreating, onCreated, pokerButton }: {
    projectId: string; open: Sprint[]; closed: Sprint[]; selectedId: string | null; onSelect: (id: string) => void; canEdit: boolean;
    creating: boolean; setCreating: (on: boolean) => void; onCreated: (sprint: Sprint) => void; pokerButton: React.ReactNode;
}) {
    const { t, locale } = useTranslation();
    return (
        <aside className="min-w-0 space-y-2 md:sticky md:top-0" aria-label={t('project_tasks.sprints', 'Sprints')}>
            <div className="flex h-8 items-center gap-2">
                <h3 className={SECTION_LABEL}>{t('project_tasks.sprints_open', 'Open sprints')}<span className="ml-1.5 font-normal tabular-nums">{open.length}</span></h3>
                {pokerButton}
            </div>
            <ul className={ROW_LIST}>
                {open.map(sprint => <SprintListRow key={sprint.id} sprint={sprint} selected={selectedId === sprint.id} onSelect={() => onSelect(sprint.id)} t={t} locale={locale} />)}
                {canEdit && creating && <li><SprintCreateForm projectId={projectId} canEdit={canEdit} onCreated={onCreated} onCancel={() => setCreating(false)} /></li>}
                {canEdit && !creating && (
                    <li>
                        <button type="button" onClick={() => setCreating(true)} className={NEW_ROW} data-testid="sprint-new-row">
                            <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.sprint_new', 'New sprint')}
                        </button>
                    </li>
                )}
                {!open.length && !canEdit && <li className="py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('project_tasks.sprints_none_open', 'No open sprint.')}</li>}
            </ul>
            {closed.length > 0 && <SprintHistory closed={closed} t={t} locale={locale} />}
        </aside>
    );
}

function useLegacySprints(legacyKey: string) {
    return useMemo(() => {
        try {
            const parsed = JSON.parse(scopedStorage.getItem(legacyKey) || '[]');
            return Array.isArray(parsed) ? parsed.filter(s => s && typeof s.name === 'string') as LegacySprint[] : [];
        } catch { return []; }
    }, [legacyKey]);
}

type LegacySprint = { name: string; start?: string; end?: string };

/** No sprints on the server yet: the legacy import (if any), the menu, and an empty state that opens the form in place. */
function SprintsEmpty({ projectId, canEdit, creating, setCreating, onCreated, legacy, legacyKey, menu }: {
    projectId: string; canEdit: boolean; creating: boolean; setCreating: (on: boolean) => void; onCreated: (sprint: Sprint) => void;
    legacy: LegacySprint[]; legacyKey: string; menu: React.ReactNode;
}) {
    const { t } = useTranslation();
    const form = <div className={`${CARD} w-full max-w-xs text-left`}><SprintCreateForm projectId={projectId} canEdit={canEdit} onCreated={onCreated} onCancel={() => setCreating(false)} /></div>;
    return (
        <div className="space-y-4" data-testid="sprints-panel">
            <LegacyImport projectId={projectId} legacy={legacy} legacyKey={legacyKey} canEdit={canEdit} />
            {menu}
            <EmptyState icon={<CalendarDays className="w-8 h-8" />}
                title={t('project_tasks.sprints_empty_title', 'No sprints yet')}
                description={t('project_tasks.sprints_empty_desc_short', 'Group work into a short, fixed window.')}
                action={!canEdit ? undefined : creating ? form : { label: t('project_tasks.sprint_create', 'Create sprint'), onClick: () => setCreating(true) }} />
        </div>
    );
}

export default function SprintsPanel({ projectId, tasks, canEdit, onOpen, onPlanWithPoker, people, actionsSlot }: {
    projectId: string; tasks: ProjectTask[]; canEdit: boolean;
    onOpen: (task: ProjectTask) => void; onPlanWithPoker?: () => void;
    /** Faces on the sprint items; optional so older callers keep working. */
    people?: ReturnType<typeof useChatPeople>;
    /** The sub-nav's right-hand slot; "New sprint ▾" renders there when given. */
    actionsSlot?: HTMLElement | null;
}) {
    const { t } = useTranslation();
    const query = useProjectSprintsQuery(projectId);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const legacyKey = `project-sprints:${projectId}`;
    const legacy = useLegacySprints(legacyKey);

    if (query.isPending) return <SprintsSkeleton label={t('project_tasks.sprints_loading', 'Loading sprints…')} />;
    if (query.isError) return <Notice tone="error" role="alert" action={<GhostButton onClick={() => query.refetch()}>{t('project_chat.retry', 'Try again')}</GhostButton>}>{t('project_tasks.sprints_failed', 'Could not load the sprints of this project.')}</Notice>;

    const sprints = query.data || [];
    const openSprints = sprints.filter(s => s.status !== 'closed');
    const selected = openSprints.find(s => s.id === selectedId) || openSprints[0] || null;
    const created = (sprint: Sprint) => { setSelectedId(sprint.id); setCreating(false); };
    const newMenu = canEdit ? <NewSprintMenu onNew={() => setCreating(true)} onPlanWithPoker={onPlanWithPoker} /> : null;
    const slotted = actionsSlot && newMenu ? createPortal(newMenu, actionsSlot) : null;

    if (sprints.length === 0) {
        return <SprintsEmpty projectId={projectId} canEdit={canEdit} creating={creating} setCreating={setCreating} onCreated={created}
            legacy={legacy} legacyKey={legacyKey} menu={slotted || (newMenu && <div className="flex justify-end">{newMenu}</div>)} />;
    }

    const pokerButton = !actionsSlot && canEdit && onPlanWithPoker ? (
        <button type="button" className={`${TOOLBAR_BUTTON} ml-auto -mr-1 !h-7 !px-2`} onClick={onPlanWithPoker} data-testid="plan-sprint-with-poker"
            title={t('project_tasks.plan_sprint_with_poker', 'Plan a sprint with poker')}>
            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.plan_with_poker', 'Plan with poker')}
        </button>
    ) : null;

    return (
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[260px_minmax(0,1fr)] lg:gap-6" data-testid="sprints-panel">
            {slotted}
            <SprintList projectId={projectId} open={openSprints} closed={sprints.filter(s => s.status === 'closed')} selectedId={selected?.id || null}
                onSelect={setSelectedId} canEdit={canEdit} creating={creating} setCreating={setCreating} onCreated={created} pokerButton={pokerButton} />
            {selected ? (
                <SprintDetail key={selected.id} projectId={projectId} sprint={selected} items={tasks.filter(task => inSprint(task, selected))}
                    backlog={tasks.filter(task => task.status !== 'done' && !task.sprintId && !sprintName(task))}
                    canEdit={canEdit} people={people} onOpen={onOpen} onDeleted={() => setSelectedId(null)} />
            ) : (
                <p className="m-0 py-10 text-center text-[12.5px] text-[var(--text-tertiary)]">
                    {canEdit ? t('project_tasks.sprint_pick_new', 'No open sprint. Start a new one from the list.') : t('project_tasks.sprints_none_open', 'No open sprint.')}
                </p>
            )}
        </div>
    );
}

/** One-time offer, only while the server has no sprints: recreate the ones this browser saved locally. */
function LegacyImport({ projectId, legacy, legacyKey, canEdit }: {
    projectId: string; legacy: LegacySprint[]; legacyKey: string; canEdit: boolean;
}) {
    const { t } = useTranslation();
    const create = useCreateSprint(projectId);
    const [done, setDone] = useState(false);
    if (!legacy.length || done || !canEdit) return null;
    const importNow = async () => {
        for (const s of legacy) {
            // One at a time: a rejected name should not lose the rest.
            await create.mutateAsync({ name: s.name, startDate: s.start || null, endDate: s.end || null }).catch(() => {});
        }
        try { scopedStorage.removeItem(legacyKey); } catch { /* optional */ }
        setDone(true);
    };
    return (
        <Notice tone="info" icon={Upload} testId="sprint-legacy-import"
            action={<GhostButton onClick={() => void importNow()} disabled={create.isPending} className="text-[var(--text-primary)]">{t('project_tasks.sprint_import_button', 'Import my locally saved sprints')}</GhostButton>}>
            <span className="text-[13px]">{t('project_tasks.sprint_import_short', '{count} sprints are saved only in this browser.', { count: legacy.length })}</span>
        </Notice>
    );
}
