// "Continues as": the fields this step hands to the next one, by the run's own
// rule (server core/automationRunner/aiStepSkills.effectiveOutputSchema): the
// step's own Structured output wins, otherwise the leading skill's output
// contract. Showing the skill's fields over the step's would promise fields
// the run never hands on.
import { ArrowRightFromLine, Braces, Calendar, Hash, List, ToggleLeft, Type } from 'lucide-react';
import type { SkillOutputField } from '../../../../../../api/queries/automation/agents';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { hintTextClass } from '../formPrimitives';
import { fieldTypeWord } from './agentStepModel';

function FieldIcon({ type }: { type: string }) {
    const cls = 'shrink-0 text-[var(--text-tertiary)]';
    if (type === 'number') return <Hash size={12} className={cls} aria-hidden="true" />;
    if (type === 'array') return <List size={12} className={cls} aria-hidden="true" />;
    if (type === 'datetime') return <Calendar size={12} className={cls} aria-hidden="true" />;
    if (type === 'boolean') return <ToggleLeft size={12} className={cls} aria-hidden="true" />;
    if (type === 'object') return <Braces size={12} className={cls} aria-hidden="true" />;
    return <Type size={12} className={cls} aria-hidden="true" />;
}

export interface ContinuesAsProps {
    /** The leading skill's fields; null while unknown (no skill, or not read). */
    skillFields: SkillOutputField[] | null;
    skillName: string | null;
    stepFields: SkillOutputField[];
    t: TranslateFn;
}

export default function ContinuesAs({ skillFields, skillName, stepFields, t }: ContinuesAsProps) {
    const skillHas = !!skillFields && skillFields.length > 0;
    const ownWins = stepFields.length > 0;
    const fromSkill = skillHas && !ownWins;
    const fields = fromSkill ? skillFields : stepFields;
    return (
        <section className="flex flex-col gap-2" aria-label={t('routines.agent_step.continues_as', 'Continues as')}>
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-primary)]">
                <ArrowRightFromLine size={13} aria-hidden="true" />
                {t('routines.agent_step.continues_as', 'Continues as')}
                <span className="font-normal text-[var(--text-tertiary)]">
                    {t('routines.agent_step.continues_as_sub', 'fields for the next step')}
                </span>
            </div>
            {fields.length > 0 ? (
                <ul className="flex flex-col divide-y divide-[var(--border-default)] rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)]">
                    {fields.map((f) => (
                        <li key={f.key} className="flex items-center gap-2 px-3 py-1.5 text-[12px]" data-testid="continues-field">
                            <FieldIcon type={f.type} />
                            <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">{f.title || f.key}</span>
                            <span className="ml-auto shrink-0 text-[11px] text-[var(--text-tertiary)]">{fieldTypeWord(t, f.type)}</span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className={hintTextClass()}>
                    {t('routines.agent_step.continues_free_text', 'One text answer. Add fields under Structured output to hand on named values.')}
                </p>
            )}
            {fromSkill ? (
                <p className={hintTextClass()}>
                    {t('routines.agent_step.fields_from_skill', 'The fields come from the skill "{name}". Need other fields? Change the skill, or add a field below for this step only.', { name: skillName || '' })}
                </p>
            ) : ownWins && skillHas ? (
                <p className={hintTextClass()}>
                    {t('routines.agent_step.fields_replace_skill', 'These are this step\'s own fields, set under Structured output below. They replace the fields of the skill "{name}".', { name: skillName || '' })}
                </p>
            ) : fields.length > 0 ? (
                <p className={hintTextClass()}>
                    {t('routines.agent_step.fields_from_step', 'These are this step\'s own fields, set under Structured output below.')}
                </p>
            ) : null}
        </section>
    );
}
