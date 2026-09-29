import { UserRound } from 'lucide-react';
import React from 'react';
import { PERSONA_LIMITS } from './personaFacts';
import RoleCard, { RoleCounter, RoleEmpty, RoleTextArea } from './RoleCard';

/**
 * "Wie is het" — de rol en de expertise van de agent (Agents-artboard 1c).
 *
 * Eén tekstvak, want dit is het enige veld van de vijf waar een zin beter werkt
 * dan een lijst: "een ervaren binnendienst-collega die onze offertes kent, en
 * die voor verkopers werkt en niet voor klanten" is één gedachte met een
 * afbakening erin, en die knipt niet netjes in bullets.
 *
 * De tekst wordt letterlijk het EERSTE blok van het systeemprompt
 * (`renderSystemPrompt` zet `who` vooraan). Vandaar de teller: de server knipt
 * op 600 tekens zonder iets te zeggen, en dan is de afbakening — meestal de
 * laatste zin — weg.
 */
export default function WhoCard({ t, value = '', onChange, readOnly = false }) {
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
