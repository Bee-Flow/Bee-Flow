import React from 'react';
import { Lock } from 'lucide-react';
import { interpolate } from '../../../hooks/useTranslation';
import { describePrivacyLine } from './privacyLine';

/** Reserve-`t` die wél interpoleert — zie de koptekst. */
const FALLBACK_T = (_key, en, params) => interpolate(en, params);

/**
 * De privacyregel onder een bericht (C7).
 *
 * Twee vormen, en het verschil tussen die twee is de hele bevinding — zie
 * `privacyLine.js` voor de meting eronder. Wat hier telt:
 *
 *   • De demonstratievorm noemt de plaatsvervanger die er daadwerkelijk voor in
 *     de plaats ging. Hij verschijnt alleen als die bekend is.
 *   • De onbewezen vorm zegt dat het scherm de plaatsvervanger niet kan tonen.
 *     Hij zegt NIET "de echte waarde bleef hier" — dat is precies de zin die
 *     zonder tokenmap niet gecontroleerd is, en een privacyclaim zonder meting
 *     eronder is erger dan geen claim.
 *
 * De regel verving de blauwe "N items redacted"-pil onder het gebruikersbericht.
 * Die pil was de tellervorm: een bewering over een aantal, zonder één
 * aanwijzing erbij. De amberen "Scan incomplete"-pil staat er los van en blijft.
 *
 * ── Twee dingen die deze zin NIET doet ─────────────────────────────────────
 * 1. LIDMAATSCHAP CLAIMEN. Waar er meer vervangen is dan aangetoond, staat er
 *    niet "{count} vervangen, waaronder {tokens}": dat maakt de aangetoonde
 *    plaatsvervanger lid van een verzameling waarvan het scherm dat niet weet
 *    (de kluismap is conversatiebreed). De twee beweringen staan daarom naast
 *    elkaar: de server telde er zoveel, én dít token staat voor een waarde in
 *    dit bericht.
 * 2. GERUSTSTELLEN OVER EEN DOORLAAT. Is een deel van deze beurt niet
 *    gecontroleerd, dan ging dat deel onder fail_open ONGEREDIGEERD naar de
 *    AI. "de echte waarde bleef hier" is dan waar over het aangetoonde en
 *    misleidend over de rest, dus de zin krijgt de doorlaat er direct achteraan
 *    — in de zin zelf, niet alleen in de pil ernaast. PrivacyPanel doet dit al
 *    zo (`anyIncompleteAttachment`); de regel die de primaire, altijd
 *    zichtbare uitspraak werd mag die voorwaarde niet zijn kwijtgeraakt.
 *
 * De reserve-`t` MOET interpoleren: de zinnen dragen een `{count}`, en een
 * reserve die alleen zijn tweede argument teruggeeft zet die placeholder
 * letterlijk op het scherm bij een aanroeper die geen `t` doorgeeft.
 */
export default function PrivacyLine({
    count, messageText, tokenMap, scanIncomplete = false, t = FALLBACK_T,
}) {
    const line = describePrivacyLine({ count, messageText, tokenMap, scanIncomplete });
    if (!line) return null;

    const sentence = line.form === 'unproven'
        ? t(
            line.count === 1 ? 'dlp.line_unproven' : 'dlp.line_unproven_plural',
            line.count === 1
                ? '1 value was replaced before this went to the AI — this screen cannot show which placeholder took its place'
                : '{count} values were replaced before this went to the AI — this screen cannot show which placeholders took their place',
            { count: line.count },
        )
        : line.partial
            ? t(
                'dlp.line_replaced_partial',
                // Twee losse beweringen, met opzet niet tot één samengevoegd:
                // de telling komt van de server, de aanwijzing van dit scherm.
                '{count} values were replaced before this went to the AI. {tokens} stands for a value in this message — that real value stayed here',
                { count: line.count },
            )
            : t(
                line.count === 1 ? 'dlp.line_replaced' : 'dlp.line_replaced_plural',
                line.count === 1
                    ? '1 value replaced with {tokens} — the real value stayed here'
                    : '{count} values replaced with {tokens} — the real values stayed here',
                { count: line.count },
            );

    // `{tokens}` blijft met opzet staan in de vertaalde zin: de plaatsvervangers
    // zijn geen tekst maar monospace-chips, en die overleven interpolate() niet.
    // Ontbreekt de placeholder in een vertaling, dan komen ze achteraan — nooit
    // verdwijnen ze, want dan bleef de tellervorm over.
    const at = sentence.indexOf('{tokens}');
    const before = at === -1 ? sentence : sentence.slice(0, at);
    const after = at === -1 ? '' : sentence.slice(at + '{tokens}'.length);

    return (
        <span
            data-testid="privacy-line"
            data-privacy-line={line.form}
            className="text-[11px] leading-[16px]"
            style={{ color: 'var(--text-tertiary)' }}
        >
            <Lock className="w-3 h-3 inline-block shrink-0 mr-1 align-[-2px]" aria-hidden="true" />
            {before}
            {line.tokens.map((token, i) => (
                <React.Fragment key={token}>
                    {i > 0 && ', '}
                    <code
                        data-testid="privacy-line-token"
                        className="font-mono rounded px-1"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                    >
                        {token}
                    </code>
                </React.Fragment>
            ))}
            {after}
            {line.incomplete && (
                <span data-testid="privacy-line-incomplete">
                    {' '}
                    {t(
                        'dlp.line_scan_incomplete',
                        'Part of this message could not be checked, and that part was sent as it was.',
                    )}
                </span>
            )}
        </span>
    );
}
