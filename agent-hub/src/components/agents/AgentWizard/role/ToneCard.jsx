import { MessageCircle } from 'lucide-react';
import React from 'react';
import { PERSONA_LIMITS, toneChipRows, toneChipsFull, toneLanguageClash } from './personaFacts';
import RoleCard, { RoleCounter, RoleEmpty, RoleNote, RoleTextArea } from './RoleCard';

/**
 * "Hoe het praat" — toon en vorm (Agents-artboard 1c).
 *
 * ── WAAROM DIT GEEN `shared/ChoiceCards` IS ─────────────────────────
 * `ChoiceCards` is een ARIA-radiogroup: precies één optie tegelijk, en
 * `aria-checked` zegt dat de opties elkaar uitsluiten. Toon is meervoudig —
 * "zakelijk" én "kort" én "met bedragen in €" is de normale keuze — dus een
 * radiogroup zou een schermlezer iets vertellen dat niet waar is. Dat is
 * exact het defect waarvoor `ChoiceCards` zelf is gebouwd (zie zijn kop: twee
 * eerdere kopieën gaven kleur als enige selectiesignaal), alleen dan
 * andersom. Vandaar: `role="group"` met `aria-pressed`-schakelknoppen, de
 * standaardvorm voor een meervoudige keuze. De radiogroup zit wél op "Als het
 * niet weet", want daar is de keuze echt één uit drie.
 *
 * ── DE CHIPWAARDE IS PROMPTTEKST ────────────────────────────────────
 * Wat hier aan staat wordt letterlijk `Tone: formal, friendly.` in het
 * systeemprompt. Het label gaat door `t()`, de WAARDE niet — zie de kop van
 * `personaFacts.js`. Chips die deze kaart niet aanbiedt (uit de AI-parse, of
 * met de hand gezet) staan er gewoon bij: de server bewaart ze woordelijk en
 * rendert ze mee, dus ze verzwijgen zou de instructie verzwijgen.
 */

/** Het label van een aangeboden chip. Letterlijke t()-aanroepen, zodat de i18n-guard ze ziet. */
function chipLabel(t, value) {
    switch (value) {
        case 'formal': return t('agent_studio.role.tone_formal', 'Businesslike');
        case 'friendly': return t('agent_studio.role.tone_friendly', 'Friendly');
        case 'concise': return t('agent_studio.role.tone_concise', 'Short');
        case 'amounts in euros': return t('agent_studio.role.tone_amounts_eur', 'Amounts in €');
        case 'Dutch unless asked otherwise': return t('agent_studio.role.tone_dutch_default', 'Dutch, unless asked otherwise');
        // Een eigen chip is de eigen tekst van de eigenaar; die vertaalt niet.
        default: return value;
    }
}

function ToneChip({ t, row, onToggle, readOnly, full }) {
    const label = chipLabel(t, row.value);
    if (readOnly) {
        return (
            <span
                data-testid="agent-role-tone-chip"
                data-on="true"
                className="px-2.5 py-0.5 rounded-full text-[12px] font-semibold"
                style={{ background: 'var(--text-primary)', color: 'var(--bg-primary)' }}
            >{label}</span>
        );
    }
    return (
        <button
            type="button"
            data-testid="agent-role-tone-chip"
            data-on={row.on ? 'true' : 'false'}
            aria-pressed={row.on}
            disabled={!row.on && full}
            onClick={() => onToggle?.(row.value)}
            className="px-2.5 py-0.5 rounded-full text-[12px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={row.on
                ? { background: 'var(--text-primary)', color: 'var(--bg-primary)', fontWeight: 600 }
                : { border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
        >{label}</button>
    );
}

export default function ToneCard({ t, persona, onToggleChip, onChangeText, readOnly = false }) {
    const rows = toneChipRows(persona);
    const shown = readOnly ? rows.filter(r => r.on) : rows;
    const hasOwn = rows.some(r => !r.offered);
    const full = toneChipsFull(persona);
    const text = persona?.tone?.text || '';
    const clash = toneLanguageClash(persona);

    return (
        <RoleCard
            testId="agent-role-tone"
            icon={<MessageCircle size={14} />}
            title={t('agent_studio.role.tone_title', 'How it talks')}
            hint={t('agent_studio.role.tone_hint', 'tone and form')}
            action={!readOnly && (
                <RoleCounter
                    testId="agent-role-tone-counter"
                    value={text}
                    max={PERSONA_LIMITS.toneText}
                    label={t('agent_studio.role.characters_used', 'Characters used')}
                />
            )}
        >
            {shown.length > 0 ? (
                <div
                    role="group"
                    aria-label={t('agent_studio.role.tone_group', 'Tone')}
                    data-testid="agent-role-tone-chips"
                    className="flex flex-wrap gap-1.5"
                >
                    {shown.map(row => (
                        <ToneChip key={row.value} t={t} row={row} onToggle={onToggleChip} readOnly={readOnly} full={full} />
                    ))}
                </div>
            ) : (
                <RoleEmpty testId="agent-role-tone-empty">
                    {t('agent_studio.role.tone_empty', 'No tone picked — the agent writes the way the model writes.')}
                </RoleEmpty>
            )}

            {full && !readOnly && (
                <RoleNote tone="warn" testId="agent-role-tone-full">
                    {t('agent_studio.role.tone_full', 'Twelve tone words is the maximum this agent keeps — switch one off to add another.')}
                </RoleNote>
            )}

            {hasOwn && !readOnly && (
                <RoleNote testId="agent-role-tone-own">
                    {t('agent_studio.role.tone_own_chip_note', 'Tone words this agent already carried are kept exactly as written — switch one off to remove it.')}
                </RoleNote>
            )}

            {clash && (
                <RoleNote tone="warn" testId="agent-role-tone-clash">
                    {t('agent_studio.role.tone_language_clash', 'This agent also has a fixed reply language, and that instruction says "whatever language the question is in". It overrules "unless asked otherwise" — keep one of the two.')}
                </RoleNote>
            )}

            {readOnly ? (
                text
                    ? <p data-testid="agent-role-tone-text" className="text-[12px] leading-[18px] m-0 text-[var(--text-secondary)]">{text}</p>
                    : null
            ) : (
                <RoleTextArea
                    testId="agent-role-tone-input"
                    ariaLabel={t('agent_studio.role.tone_text_label', 'How it talks, in your own words')}
                    value={text}
                    onChange={onChangeText}
                    rows={2}
                    maxLength={PERSONA_LIMITS.toneText}
                    placeholder={t('agent_studio.role.tone_placeholder', 'Anything the chips do not cover — what comes first in an answer, when to name a source.')}
                />
            )}
        </RoleCard>
    );
}
