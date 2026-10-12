// The compact "New sprint" form that opens inside the sprint list (or in the
// empty state): a name, a start date, a length and a capacity; the goal stays
// behind an "Add goal" link until someone wants one.

import { Plus } from 'lucide-react';
import React, { useState } from 'react';
import { useCreateSprint, type Sprint } from '../../../../api/queries/projectSprints';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import { projectErrorText } from '../projectErrorText';
import { GhostButton, PrimaryButton, SelectField } from '../workspaceUi';
import { addDays } from './taskPlanning';
import { SMALL_INPUT } from './sprintUi';

export const SPRINT_WEEKS = [1, 2, 3, 4];

export default function SprintCreateForm({ projectId, canEdit, onCreated, onCancel, className = '' }: {
    projectId: string; canEdit: boolean; onCreated: (sprint: Sprint) => void; onCancel?: () => void; className?: string;
}) {
    const { t } = useTranslation();
    const create = useCreateSprint(projectId);
    const [name, setName] = useState('');
    const [goal, setGoal] = useState('');
    const [withGoal, setWithGoal] = useState(false);
    const [start, setStart] = useState('');
    const [weeks, setWeeks] = useState(2);
    const [capacity, setCapacity] = useState('');
    const submit = (e?: React.FormEvent) => {
        e?.preventDefault();
        const clean = name.trim();
        if (!clean || !canEdit) return;
        create.mutate({
            name: clean, goal: goal.trim() || undefined,
            startDate: start || null, endDate: start ? addDays(start, weeks * 7 - 1) : null,
            capacityPoints: capacity ? Number(capacity) : null,
        }, {
            onSuccess: sprint => {
                setName(''); setGoal(''); setCapacity(''); setWithGoal(false);
                toast.success(t('project_tasks.sprint_created', 'Sprint created'));
                if (sprint) onCreated(sprint);
            },
            onError: err => toast.error(projectErrorText(t, err)),
        });
    };
    return (
        <form onSubmit={submit} className={`space-y-2 p-3 ${className}`.trim()} data-testid="sprint-create-form"
            onKeyDown={e => { if (e.key === 'Escape' && onCancel) { e.stopPropagation(); onCancel(); } }}>
            <input autoFocus className={SMALL_INPUT} value={name} maxLength={60} onChange={e => setName(e.target.value)}
                aria-label={t('project_tasks.sprint_name', 'Sprint name')} placeholder={t('project_tasks.sprint_name', 'Sprint name')} />
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <input className={SMALL_INPUT} type="date" value={start} onChange={e => setStart(e.target.value)}
                    aria-label={t('project_tasks.start_label', 'Start date')} title={t('project_tasks.start_label', 'Start date')} />
                <SelectField bare className={`${SMALL_INPUT} !w-auto`} value={weeks} onChange={e => setWeeks(Number(e.target.value))}
                    aria-label={t('project_tasks.sprint_length', 'Length')}>
                    {SPRINT_WEEKS.map(w => <option key={w} value={w}>{t('project_tasks.sprint_weeks', '{count} weeks', { count: w })}</option>)}
                </SelectField>
            </div>
            <input className={SMALL_INPUT} type="number" min={0} inputMode="numeric" value={capacity} onChange={e => setCapacity(e.target.value)}
                aria-label={t('project_tasks.sprint_capacity', 'Capacity (pts)')} placeholder={t('project_tasks.sprint_capacity', 'Capacity (pts)')} />
            {withGoal ? (
                <input className={SMALL_INPUT} value={goal} maxLength={200} onChange={e => setGoal(e.target.value)}
                    aria-label={t('project_tasks.sprint_goal', 'Goal')} placeholder={t('project_tasks.sprint_goal_placeholder_short', 'What should this sprint achieve?')} />
            ) : (
                <GhostButton onClick={() => setWithGoal(true)} className="-ml-1.5"><Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.sprint_add_goal', 'Add goal')}</GhostButton>
            )}
            <div className="flex items-center justify-end gap-1 pt-1">
                {onCancel && <GhostButton onClick={onCancel} className="h-8 px-2.5">{t('project_content.cancel', 'Cancel')}</GhostButton>}
                <PrimaryButton type="submit" disabled={!canEdit || !name.trim()} busy={create.isPending}>{t('project_tasks.sprint_create', 'Create sprint')}</PrimaryButton>
            </div>
        </form>
    );
}
