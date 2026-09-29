// "Skills for this step": the agent's own skills with a switch each (off =
// not used in this step), the step's extra skills, the leading pill, and
// "Add a skill for this step".
import { Plus, X, Zap } from 'lucide-react';
import type { SkillRow } from '../../../../../../api/queries/automation/agents';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { EmptySectionNote, SectionNote, hintTextClass } from '../formPrimitives';
import type { StepSkillRow } from './agentStepModel';

export function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
    return (
        <label className="relative inline-flex shrink-0 cursor-pointer items-center">
            <input
                type="checkbox"
                role="switch"
                checked={on}
                onChange={(e) => onChange(e.target.checked)}
                aria-label={label}
                className="peer sr-only"
            />
            <span
                aria-hidden="true"
                className={`relative h-4 w-[26px] rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--accent-primary)] ${on ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)]'}`}
            >
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-[left] ${on ? 'left-3' : 'left-0.5'}`} />
            </span>
        </label>
    );
}

interface AddSkillMenuProps {
    list: SkillRow[] | null;
    status: 'loading' | 'error' | 'ok';
    exclude: Set<string>;
    onAdd: (id: string) => void;
    t: TranslateFn;
}

function AddSkillMenu({ list, status, exclude, onAdd, t }: AddSkillMenuProps) {
    if (status === 'loading') return <p className={hintTextClass()}>{t('routine_editor.skills_loading', 'Loading…')}</p>;
    if (status === 'error') {
        return (
            <SectionNote tone="warn">
                {t('routine_editor.skills_unreadable', 'The list of skills could not be read. Any skills this step already uses are kept.')}
            </SectionNote>
        );
    }
    const options = (list || []).filter((s) => !exclude.has(s.id));
    if (options.length === 0) {
        return <EmptySectionNote>{t('routine_editor.skills_empty', 'No skills yet — write one under Skills first.')}</EmptySectionNote>;
    }
    return (
        <ul className="flex max-h-44 flex-col overflow-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] py-1" aria-label={t('routines.agent_step.add_skill_list', 'Skills you can add')}>
            {options.map((s) => (
                <li key={s.id}>
                    <button
                        type="button"
                        onClick={() => onAdd(s.id)}
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
                    >
                        <Zap size={12} className="shrink-0 text-[var(--kind-skill)]" aria-hidden="true" />
                        <span className="truncate">{s.name}</span>
                    </button>
                </li>
            ))}
        </ul>
    );
}

function SkillRowItem({ row: r, onRemove, onToggleAgentSkill, t }: {
    row: StepSkillRow;
    onRemove: (id: string) => void;
    onToggleAgentSkill: (id: string, on: boolean) => void;
    t: TranslateFn;
}) {
    return (
        <div className="flex items-center gap-2 px-3 py-2 text-[12px]" data-testid="step-skill-row">
            {r.source === 'agent' ? (
                <Switch on={r.enabled} label={r.name} onChange={(on) => onToggleAgentSkill(r.id, on)} />
            ) : (
                <Switch on label={r.name} onChange={() => onRemove(r.id)} />
            )}
            <Zap size={12} className={`shrink-0 ${r.enabled ? 'text-[var(--kind-skill)]' : 'text-[var(--text-tertiary)]'}`} aria-hidden="true" />
            <span className={`min-w-0 truncate font-medium ${r.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}>{r.name}</span>
            <span className="shrink-0 truncate text-[11px] text-[var(--text-tertiary)]">
                {r.source === 'step'
                    ? t('routines.agent_step.skill_extra', 'extra for this step')
                    : r.enabled
                        ? t('routines.agent_step.skill_from_agent', 'from the agent')
                        : t('routines.agent_step.skill_from_agent_off', 'from the agent · not needed here')}
            </span>
            {r.leading ? (
                <span className="ml-auto shrink-0 rounded-full bg-[color-mix(in_srgb,var(--kind-skill)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--kind-skill)]">
                    {t('routines.agent_step.skill_leading', 'leading')}
                </span>
            ) : null}
            {r.source === 'step' ? (
                <button
                    type="button"
                    onClick={() => onRemove(r.id)}
                    aria-label={t('routines.agent_step.remove_skill', 'Remove {name}', { name: r.name })}
                    className={`${r.leading ? '' : 'ml-auto'} shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]`}
                >
                    <X size={12} />
                </button>
            ) : null}
        </div>
    );
}

export interface StepSkillsListProps {
    rows: StepSkillRow[];
    withAgent: boolean;
    atCap: boolean;
    cap: number;
    skillList: SkillRow[] | null;
    skillListStatus: 'loading' | 'error' | 'ok';
    adding: boolean;
    onSetAdding: (v: boolean) => void;
    onAdd: (id: string) => void;
    onRemove: (id: string) => void;
    onToggleAgentSkill: (id: string, on: boolean) => void;
    t: TranslateFn;
}

export default function StepSkillsList({
    rows, withAgent, atCap, cap, skillList, skillListStatus, adding, onSetAdding, onAdd, onRemove, onToggleAgentSkill, t,
}: StepSkillsListProps) {
    const exclude = new Set(rows.map((r) => r.id));

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-tertiary)]">
                    {t('routine_editor.skills_label', 'Skills for this step')}
                </span>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                    {withAgent
                        ? t('routines.agent_step.skills_sub_agent', 'from the agent · on or off per step · or pick one extra')
                        : t('routines.agent_step.skills_sub', 'a written way of working · the first one leads')}
                </span>
            </div>
            <div className="flex flex-col divide-y divide-[var(--border-default)] rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)]">
                {rows.map((r) => (
                    <SkillRowItem key={r.id} row={r} onRemove={onRemove} onToggleAgentSkill={onToggleAgentSkill} t={t} />
                ))}
                <button
                    type="button"
                    onClick={() => onSetAdding(!adding)}
                    disabled={atCap}
                    aria-expanded={adding}
                    className="flex items-center gap-1.5 px-3 py-2 text-left text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <Plus size={12} aria-hidden="true" />
                    {t('routines.agent_step.add_skill', 'Add a skill for this step')}
                </button>
            </div>
            {atCap ? (
                <p className={hintTextClass()}>
                    {t('routine_editor.skills_at_cap', 'That is the most a step can use ({n}). Remove one to pick another — the first one stays the leading skill.', { n: cap })}
                </p>
            ) : null}
            {adding && !atCap ? (
                <AddSkillMenu
                    list={skillList}
                    status={skillListStatus}
                    exclude={exclude}
                    onAdd={(id) => { onSetAdding(false); onAdd(id); }}
                    t={t}
                />
            ) : null}
        </div>
    );
}
