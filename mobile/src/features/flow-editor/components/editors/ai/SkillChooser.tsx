/**
 * The step's skills — the web's SkillChooser (agentStepFields.jsx): a skill
 * is a written way of working; the FIRST one picked leads (its instructions
 * come first, its output fields are inherited), and the cap is the runner's
 * own. A list that could not be read says so, and keeps what the step uses.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FieldRow } from '@/features/flow-editor/components/fields';
import { MAX_AI_STEP_SKILL_IDS } from '@/features/flow-editor/formState';
import { useSkills } from '@/features/skills';
import { OptionRow } from '@/shared/ui';

import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';
import type { StepEditorProps } from '../types';
import { toggleSkill } from './aiModel';

export function SkillChooser({ draft, setMany, ctx }: StepEditorProps) {
    const t = useTranslation();
    const skills = useSkills();
    const selected = Array.isArray(draft.skillIds) ? (draft.skillIds as string[]) : [];
    const atCap = selected.length >= MAX_AI_STEP_SKILL_IDS;
    let body: React.ReactNode;
    if (skills.isPending) body = <Note>{t('automation_editor.skills_loading', 'Loading…')}</Note>;
    else if (skills.isError) body = <Warn>{t('automation_editor.skills_unreadable', 'The list of skills could not be read. Any skills this step already uses are kept.')}</Warn>;
    else if (!skills.data?.length) body = <Note>{t('automation_editor.skills_empty', 'No skills yet — write one under Skills first.')}</Note>;
    else {
        body = (
            <>
                {skills.data.map((s) => {
                    const on = selected.includes(s.id);
                    return (
                        <OptionRow
                            key={s.id}
                            label={s.name || s.id}
                            description={on && selected[0] === s.id ? t('automation_editor.skills_leading', 'Leading') : undefined}
                            selected={on}
                            onPress={() => {
                                const next = toggleSkill(draft, s.id);
                                if (next) setMany(next);
                            }}
                            disabled={ctx.disabled || (!on && atCap)}
                        />
                    );
                })}
                {atCap ? (
                    <Note>
                        {t('automation_editor.skills_at_cap', 'That is the most a step can use ({n}). Remove one to pick another — the first one stays the leading skill.', {
                            n: MAX_AI_STEP_SKILL_IDS,
                        })}
                    </Note>
                ) : null}
            </>
        );
    }
    return (
        <FieldRow
            label={t('automation_editor.skills_label', 'Skills for this step')}
            hint={t(
                'automation_editor.skills_hint',
                "A skill is a written way of working. The first one leads: it is the one whose instructions come first, and whose output fields the step inherits. With an agent, the step's skills come before the agent's own.",
            )}
        >
            {body}
        </FieldRow>
    );
}
