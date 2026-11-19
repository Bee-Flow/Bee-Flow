import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { TranslateParams } from '@/hooks/useTranslation';
import type { PlannedSkill, SkillActivation } from '../plannedSkills';

type T = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;

interface Choice extends PlannedSkill { selected: boolean }

interface Props {
    t: T;
    skills: PlannedSkill[];
    /** pending | busy | added | skipped | failed */
    state: string;
    addedCount?: number;
    onAdd: (chosen: PlannedSkill[]) => void;
    onSkip: () => void;
}

const ACTIVATION_LABEL: Record<SkillActivation, [string, string]> = {
    static: ['wizard_skills.static', 'Always on'],
    dynamic: ['wizard_skills.dynamic', 'When relevant'],
};
const ACTIVATION_HINT: Record<SkillActivation, [string, string]> = {
    static: ['wizard_skills.static_hint', 'Its instructions are part of every answer.'],
    dynamic: ['wizard_skills.dynamic_hint', 'Loaded only when a task needs it.'],
};

/**
 * The skills turn of the refine rail: the NEW skills a refinement proposed.
 * Nothing is stored until "Add selected skills"; per skill the person can
 * untick it, switch static/dynamic, open it (when to use it, steps, rules)
 * and change its name and one-liner. The chosen ones go to onAdd as they are
 * now; the server stores them with their draft (POST /api/skills/from-plan).
 */
export default function SkillProposalsCard({ t, skills, state, addedCount = 0, onAdd, onSkip }: Props) {
    const [choices, setChoices] = useState<Choice[]>(() => skills.map(s => ({ ...s, selected: true })));
    const update = (i: number, patch: Partial<Choice>) => setChoices(prev => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    const open = state === 'pending' || state === 'failed';
    const chosen = choices.filter(c => c.selected).map(({ selected: _selected, ...skill }) => skill);

    return (
        <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4" data-testid="skill-proposals">
            <div className="text-xs uppercase tracking-wide text-[var(--accent)] mb-1">{t('wizard_skills.title', 'Suggested skills')}</div>
            {open && <p className="text-xs text-[var(--text-secondary)] mb-3">{t('wizard_skills.intro', 'Choose the skills to add to this agent. You can change them later in the skill editor.')}</p>}
            <div className="divide-y divide-[var(--border-default)]">
                {choices.map((c, i) => (
                    <ProposalRow key={i} t={t} choice={c} disabled={!open} onChange={(patch) => update(i, patch)} />
                ))}
            </div>
            <Outcome t={t} state={state} addedCount={addedCount} />
            {open && (
                <div className="flex items-center justify-end gap-2 mt-3">
                    <button type="button" onClick={onSkip} className="px-3 py-1.5 rounded-full text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                        {t('wizard_skills.skip', 'Not now')}
                    </button>
                    <button
                        type="button"
                        onClick={() => onAdd(chosen)}
                        disabled={chosen.length === 0}
                        className="px-3 py-1.5 rounded-full text-xs font-medium border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                    >
                        {t('wizard_skills.add', 'Add selected skills ({count})', { count: chosen.length })}
                    </button>
                </div>
            )}
        </div>
    );
}

function Outcome({ t, state, addedCount }: { t: T; state: string; addedCount: number }) {
    if (state === 'busy') {
        return <div className="flex items-center gap-2 mt-3 text-xs text-[var(--text-secondary)]"><Loader2 className="w-3 h-3 animate-spin" />{t('wizard_skills.busy', 'Adding…')}</div>;
    }
    if (state === 'added') return <div className="mt-3 text-xs text-[var(--text-secondary)]">{t('wizard_skills.added', 'Added {count} skill(s) to this agent.', { count: addedCount })}</div>;
    if (state === 'skipped') return <div className="mt-3 text-xs text-[var(--text-secondary)]">{t('wizard_skills.skipped', 'No skills added.')}</div>;
    if (state === 'failed') return <div className="mt-3 text-xs text-[var(--error-ink)]">{t('wizard_skills.failed', 'The skills could not be added. Try again.')}</div>;
    return null;
}

function ProposalRow({ t, choice, disabled, onChange }: { t: T; choice: Choice; disabled: boolean; onChange: (patch: Partial<Choice>) => void }) {
    const [expanded, setExpanded] = useState(false);
    const [editing, setEditing] = useState(false);
    const [labelKey, labelText] = ACTIVATION_LABEL[choice.activation];
    const [hintKey, hintText] = ACTIVATION_HINT[choice.activation];
    const flip: SkillActivation = choice.activation === 'dynamic' ? 'static' : 'dynamic';
    const fieldClass = 'w-full rounded-md border border-[var(--border-default)] bg-transparent px-2 py-1 text-sm text-[var(--text-primary)]';

    return (
        <div className="py-2.5" data-testid="skill-proposal">
            <div className="flex items-start gap-2">
                <input
                    type="checkbox"
                    className="mt-1"
                    checked={choice.selected}
                    disabled={disabled}
                    aria-label={t('wizard_skills.include', 'Add this skill')}
                    onChange={(e) => onChange({ selected: e.target.checked })}
                />
                <div className="flex-1 min-w-0">
                    {editing ? (
                        <div className="space-y-1.5">
                            <label className="block text-[11px] text-[var(--text-tertiary)]">
                                {t('wizard_skills.name_label', 'Name')}
                                <input className={fieldClass} value={choice.name} onChange={(e) => onChange({ name: e.target.value })} />
                            </label>
                            <label className="block text-[11px] text-[var(--text-tertiary)]">
                                {t('wizard_skills.summary_label', 'What it does')}
                                <input className={fieldClass} value={choice.description} onChange={(e) => onChange({ description: e.target.value })} />
                            </label>
                        </div>
                    ) : (
                        <>
                            <div className="text-sm text-[var(--text-primary)] truncate">{choice.name}</div>
                            {choice.description && <div className="text-xs text-[var(--text-tertiary)] truncate">{choice.description}</div>}
                        </>
                    )}
                    <div className="flex flex-wrap items-center gap-2 mt-1.5">
                        <button
                            type="button"
                            disabled={disabled}
                            title={t(hintKey, hintText)}
                            onClick={() => onChange({ activation: flip })}
                            className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border border-[var(--border-default)] text-[var(--accent)] disabled:opacity-60"
                        >
                            {t(labelKey, labelText)}
                        </button>
                        <button type="button" onClick={() => setExpanded(v => !v)} className="inline-flex items-center gap-0.5 text-[11px] text-[var(--text-secondary)] hover:underline">
                            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            {expanded ? t('wizard_skills.details_hide', 'Hide details') : t('wizard_skills.details_show', 'Show details')}
                        </button>
                        {!disabled && (
                            <button type="button" onClick={() => setEditing(v => !v)} className="text-[11px] text-[var(--text-secondary)] hover:underline">
                                {editing ? t('wizard_skills.edit_done', 'Done') : t('wizard_skills.edit', 'Edit')}
                            </button>
                        )}
                    </div>
                    {expanded && <ProposalDetails t={t} skill={choice} />}
                </div>
            </div>
        </div>
    );
}

function ProposalDetails({ t, skill }: { t: T; skill: PlannedSkill }) {
    const when = skill.draft?.instructions || skill.instructions;
    const steps = skill.draft?.steps || [];
    const rules = skill.draft?.rulesV2 || [];
    return (
        <div className="mt-2 space-y-2 text-xs text-[var(--text-secondary)]">
            {when && (
                <div>
                    <div className="font-medium text-[var(--text-primary)]">{t('wizard_skills.when_label', 'When to use it')}</div>
                    <p>{when}</p>
                </div>
            )}
            {steps.length > 0 && (
                <div>
                    <div className="font-medium text-[var(--text-primary)]">{t('wizard_skills.steps_label', 'Steps')}</div>
                    <ol className="list-decimal pl-4">{steps.map((s, i) => <li key={i}>{s.text}</li>)}</ol>
                </div>
            )}
            {rules.length > 0 && (
                <div>
                    <div className="font-medium text-[var(--text-primary)]">{t('wizard_skills.rules_label', 'Rules')}</div>
                    <ul className="list-disc pl-4">
                        {rules.map((r, i) => (
                            <li key={i}>{r.polarity === 'never' ? t('wizard_skills.rule_never', 'Never') : t('wizard_skills.rule_must', 'Always')}: {r.text}</li>
                        ))}
                    </ul>
                </div>
            )}
            {steps.length === 0 && rules.length === 0 && <p className="italic">{t('wizard_skills.plain_note', 'Instructions only. Add steps and rules in the skill editor.')}</p>}
        </div>
    );
}
