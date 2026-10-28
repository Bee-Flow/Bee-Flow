import { UserRound } from 'lucide-react';
import React from 'react';
import { PERSONA_LIMITS } from './personaFacts';
import type { TranslateFn } from '@/hooks/useTranslation';
import RoleCard, { RoleCounter, RoleEmpty, RoleTextArea } from './RoleCard';

/**
 * "Who it is": the role and expertise of the agent (Agents artboard 1c).
 *
 * One text box, because this is the only field of the five where a sentence works
 * better than a list: "an experienced back-office colleague who knows our quotes, and
 * who works for sales staff and not for customers" is one thought with a delimitation
 * in it, and that does not cut neatly into bullets.
 *
 * The text becomes literally the FIRST block of the system prompt (`renderSystemPrompt`
 * puts `who` at the front). Hence the counter: the server truncates at 600 characters
 * without saying anything, and then the delimitation, usually the last sentence, is gone.
 */
export default function WhoCard({ t, value = '', onChange, readOnly = false }: {
    t: TranslateFn;
    value?: string;
    onChange?: (next: string) => void;
    readOnly?: boolean;
}) {
    return (
        <RoleCard
            testId="agent-role-who"
            icon={<UserRound size={14} />}
            title={t('agent_studio.role.who_title', 'Who it is')}
            hint={t('agent_studio.role.who_hint', 'role and expertise')}
            action={!readOnly && (
                <RoleCounter
                    testId="agent-role-who-counter"
                    value={value}
                    max={PERSONA_LIMITS.who}
                    label={t('agent_studio.role.characters_used', 'Characters used')}
                />
            )}
        >
            {readOnly ? (
                value
                    ? <p data-testid="agent-role-who-text" className="text-[12px] leading-[18px] m-0 text-[var(--text-secondary)]">{value}</p>
                    : <RoleEmpty testId="agent-role-who-empty">{t('agent_studio.role.who_empty', 'Nothing written down yet.')}</RoleEmpty>
            ) : (
                <RoleTextArea
                    testId="agent-role-who-input"
                    ariaLabel={t('agent_studio.role.who_title', 'Who it is')}
                    value={value}
                    onChange={onChange}
                    maxLength={PERSONA_LIMITS.who}
                    placeholder={t('agent_studio.role.who_placeholder', 'Describe the job and the expertise: who does this agent stand in for, and who is it answering?')}
                />
            )}
        </RoleCard>
    );
}
