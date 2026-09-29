import { Zap } from 'lucide-react';
import React from 'react';
import CanUseCard, { CanUseRow, EmptyRow, LinkButton, UnreadableNotice } from './CanUseCard';
import { READ } from './canUseFacts';
import { CHOOSER_SECTION, chooserRequest } from './toolChooser';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';

/**
 * De Skills-kaart van de tab "Kan gebruiken" — de werkwijzen die de agent
 * volgt (Agents-artboard 1a, A2 stap 2).
 *
 * Eén rij per gekoppelde skill: "5 stappen · 3 regels · ook gebruikt door 2
 * andere agents". De eerste twee komen uit de skill zelf, de derde uit
 * `GET /api/skills/usage-summary`.
 *
 * ── "ANDERE" IS EEN AFTREKSOM, EN DIE MOET KLOPPEN ──────────────────
 * De samenvatting telt élke agent die de skill koppelt, deze erbij. Er gaat
 * dus één af — maar alleen als deze agent er ook echt in zit, en dat is een
 * vraag over de OPGESLAGEN config: een skill die je zojuist aanvinkte staat
 * nog nergens op de server. `canUseFacts.skillRows` maakt die aftreksom, deze
 * kaart tekent hem alleen. Onbekend blijft onbekend: dan valt de hele
 * bijzin weg en zegt de kaart onderaan waarom.
 *
 * ── TWEE LEZINGEN, TWEE UITKOMSTEN ──────────────────────────────────
 * De skills en hun gebruikstelling zijn LOSSE lezingen. De tweede mag
 * mislukken zonder de eerste mee te trekken: dan staan de stappen en regels er
 * gewoon, en ontbreekt alleen de bijzin. Eén gedeelde "er ging iets mis" zou
 * feiten weggooien die we wél hebben.
 */
export default function SkillsCard({
    t, ro = false,
    rows = [], state = READ.OK, onRetry,
    usageState = READ.OK,
    onOpenChooser,
}) {
    // "Nog niet gelezen" is geen "niet te lezen": tijdens het laden staat er
    // geen waarschuwing bij een rij waarvan de naam simpelweg nog onderweg is.
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
                        <div className="text-[12px]" style={{ color: 'var(--warning)' }}>
                            {t('agent_studio.can_use.skill_row_unreadable', 'Attached, but this skill could not be read — so what it does is unknown.')}
                        </div>
                    )}
                />
            ))}

            {/* De gebruikstelling is een APARTE lezing. Mislukt alleen die, dan
                staan de stappen en regels er gewoon en ontbreekt de bijzin —
                en dan hoort er te staan dat hij ontbreekt, niet niets. */}
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

            {/* Een rij zonder naam is al gemeld op de rij zelf; deze regel is
                voor het GEVAL dat de lijst wél gelezen is maar de skill er niet
                in stond — dan is er geen kaartbrede fout om het aan op te
                hangen. */}
            {state === READ.OK && anyUnreadableRow && (
                <UnreadableNotice
                    testId="agent-skills-partial"
                    message={t('agent_studio.can_use.skills_partial', 'One or more attached skills are not in the list you can see — they still run.')}
                />
            )}
        </CanUseCard>
    );
}
