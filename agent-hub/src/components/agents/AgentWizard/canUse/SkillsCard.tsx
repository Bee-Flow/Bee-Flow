import { Zap } from 'lucide-react';
import React from 'react';
import CanUseCard, { CanUseRow, EmptyRow, LinkButton, UnreadableNotice } from './CanUseCard';
import { READ } from './canUseFacts';
import { CHOOSER_SECTION, chooserRequest } from './toolChooser';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { ReadState } from '../agentEditor.types';
import type { skillRows } from './canUseFacts';

/** One attached skill, as `canUseFacts.skillRows` builds it. */
export type SkillCardRow = ReturnType<typeof skillRows>[number];

export interface SkillsCardProps {
    t: TranslateFn;
    ro?: boolean;
    rows?: SkillCardRow[];
    state?: ReadState;
    onRetry?: () => void;
    usageState?: ReadState;
    onOpenChooser?: (request: ReturnType<typeof chooserRequest>) => void;
}

/**
 * The Skills card of the "Can use" tab: the working methods that the agent follows (Agents artboard 1a,
 * A2 step 2).
 *
 * One row per linked skill: "5 steps · 3 rules · also used by 2 other agents". The first two come from the
 * skill itself, the third from `GET /api/skills/usage-summary`.
 *
 * ── "OTHERS" IS A SUBTRACTION, AND IT MUST BE CORRECT ──────────────
 * The summary counts EVERY agent that links the skill, this one included. So one is subtracted, but only if
 * this agent really is in that count. That is a question about the SAVED config: a skill that you just ticked
 * is not yet anywhere on the server. `canUseFacts.skillRows` makes that subtraction, and this card only draws
 * it. Unknown stays unknown: then the whole clause drops and the card says at the bottom why.
 *
 * ── TWO READS, TWO OUTCOMES ─────────────────────────────────────────
 * The skills and their usage count are SEPARATE reads. The second may fail without taking the first along:
 * then the steps and rules are still there, and only the clause is missing. One shared "something went
 * wrong" would throw away facts that we DO have.
 */
export default function SkillsCard({
    t, ro = false,
    rows = [], state = READ.OK, onRetry,
    usageState = READ.OK,
    onOpenChooser,
}: SkillsCardProps) {
    // "Not read yet" is not "cannot be read": while loading, no warning appears next to
    // a row whose name is simply still on its way.
    const pending = state === READ.LOADING;
    const anyUnreadableRow = rows.some(r => !r.readable);
    return (
        <CanUseCard
            kind="skill"
            testId="agent-skills-card"
            title={t('agent_studio.can_use.skills_title', 'Skills')}
            subtitle={t('agent_studio.can_use.skills_sub', 'The working methods it follows')}
            action={!ro && (
                <LinkButton
                    testId="agent-skills-link"
                    label={t('agent_studio.can_use.link', 'Link')}
                    onClick={() => onOpenChooser?.(chooserRequest(CHOOSER_SECTION.SKILLS))}
                />
            )}
        >
            {state === READ.ERROR && (
                <UnreadableNotice
                    testId="agent-skills-unreadable"
                    message={t('agent_studio.can_use.skills_unreadable', 'Could not load the skills, so their names and steps are missing here.')}
                    retryLabel={t('agent_studio.retry', 'Retry')}
                    onRetry={onRetry}
                />
            )}

            {rows.map((row) => (
                <CanUseRow
                    key={row.id}
                    testId="agent-skill-row"
                    icon={row.icon ? <span className="text-[14px] leading-none">{row.icon}</span> : <Zap size={14} />}
                    muted={!row.readable}
                    title={row.name || t('agent_studio.can_use.skill_unnamed', 'Skill')}
                    parts={[
                        row.stepCount === null
                            ? null
                            : nOf(t, 'agent_studio.can_use.n_steps', row.stepCount, '{count} step', '{count} steps'),
                        row.ruleCount === null
                            ? null
                            : nOf(t, 'agent_studio.can_use.n_rules', row.ruleCount, '{count} rule', '{count} rules'),
                        row.otherAgents === null
                            ? null
                            : nOf(
                                t, 'agent_studio.can_use.n_other_agents', row.otherAgents,
                                'also used by {count} other agent', 'also used by {count} other agents',
                            ),
                    ]}
                    note={(row.readable || pending) ? null : (
                        <div className="text-[12px] text-[var(--warning)]">
                            {t('agent_studio.can_use.skill_row_unreadable', 'Attached, but this skill could not be read — so what it does is unknown.')}
                        </div>
                    )}
                />
            ))}

            {/* The usage count is a SEPARATE read. If only that one fails, the steps and rules are
                still there and the clause is missing, and then it should say that it is missing,
                not say nothing. */}
            {usageState === READ.ERROR && rows.length > 0 && (
                <UnreadableNotice
                    testId="agent-skills-usage-unreadable"
                    message={t('agent_studio.can_use.skill_usage_unreadable', 'Could not read which other agents use these skills, so that is left unsaid.')}
                />
            )}

            {state === READ.OK && rows.length === 0 && (
                <EmptyRow
                    testId="agent-skills-empty"
                    message={t('agent_studio.can_use.skills_empty', 'No skills attached yet — the agent works from its instructions alone.')}
                />
            )}

            {/* A row without a name is already reported on the row itself. This line is for the CASE that
                the list was read but the skill was not in it. Then there is no card-wide error to
                attach it to. */}
            {state === READ.OK && anyUnreadableRow && (
                <UnreadableNotice
                    testId="agent-skills-partial"
                    message={t('agent_studio.can_use.skills_partial', 'One or more attached skills are not in the list you can see — they still run.')}
                />
            )}
        </CanUseCard>
    );
}
