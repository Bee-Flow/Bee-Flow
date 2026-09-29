import { AlertTriangle } from 'lucide-react';
import React from 'react';
import { summariseCardFooter } from './cardFooter';
import useTranslation from '../../../hooks/useTranslation';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';

/**
 * De voet van een agentkaart in het overzicht (A5, deel D).
 *
 * Eén regel onder de kaart, in drie vormen:
 *
 *   ⚠ Answers from memory — connect a knowledge base
 *   312 conversations · also in 2 routines, 1 app
 *   Only you · 4 conversations
 *
 * "Test" staat er bewust NIET bij. Dit product heeft een eersteklas testbegrip
 * met eigen tabellen en een eigen teller (`agent_tests` / `agent_test_runs`,
 * stores/agent/agentTests.js), en dat is wat het Test-tabblad van dezelfde
 * agent telt. Deze telling komt uit `agent_conversations` — gewone gesprekken.
 * Twee getallen die niets met elkaar te maken hebben mogen niet hetzelfde
 * woord dragen.
 *
 * Welke van de drie het wordt, beslist `summariseCardFooter` hiernaast; dit
 * bestand kiest alleen de woorden. De waarschuwing komt van de server
 * (`grounding.verdict`, uit core/agentRuntime/agentGrounding.js) en wordt hier
 * niet nagerekend — zie de kop van cardFooter.js voor waarom dat de hele
 * opzet is.
 *
 * ── ÉÉN REGEL, DUS DE WAARSCHUWING VERDRINGT DE TELLINGEN ──────────────────
 * Van de drie vormen is de waarschuwing de enige die om iets VRAAGT. Naast
 * "312 conversations" gezet zou hij de sfeer krijgen van een voetnoot bij een
 * succesverhaal; hij staat er alleen. De tellingen zijn dan niet weg — ze
 * staan op het tabblad "Used by" van dezelfde agent.
 *
 * ── ONLEESBAAR KRIJGT WOORDEN, GEEN NUL ────────────────────────────────────
 * "312 conversations" en "the conversation count could not be read" zijn
 * verschillende zinnen. De tweede is de zin die je krijgt als `stats: null`
 * terugkomt, en hij mag nooit als de eerste met een 0 lezen. Hetzelfde voor
 * "gebruikt door": een soort in `usage.partial` is niet nul, die krijgt zijn
 * eigen halve zin.
 */

/**
 * De GETELDE naam van een consumentsoort — enkelvoud én meervoud.
 *
 * Een `switch` met LETTERLIJKE sleutels, om dezelfde reden die
 * DeleteBlockedNotice.jsx opschrijft: de i18n-guard leest aanroepplekken, dus
 * een sleutel die uit een variabele wordt samengesteld is voor hem onzichtbaar
 * en kan ongemerkt meereizen tot hij opduikt in een taal die niemand getest
 * had. (Dit commentaar noemt met opzet GEEN voorbeeldaanroep meer: de guard
 * leest de rúwe bestandstekst en zonderde commentaar niet uit, dus een
 * illustratieve `nOf(...)` hierboven eiste een spooksleutel die nooit mag
 * bestaan — en de volgende lezer had die in de woordenboeken gezet.)
 *
 * Dit zijn niet de sleutels van die dialoog: `agent_usage.kind_*` zijn
 * KOPJES ("Routines"), die geen enkelvoud kennen en er in een geteld zinsdeel
 * ook geen kunnen krijgen zonder daar iets anders te gaan betekenen. Voor het
 * zinsdeel "could not check: …" zijn ze wél precies goed, en dáár worden ze
 * hieronder hergebruikt.
 *
 * Een soort die de server later toevoegt valt terug op zijn eigen ruwe naam:
 * lelijk en eerlijk verslaat een etiket dat stilletjes iets anders beweert.
 */
function usedByPhrase(t, kind, n) {
    switch (kind) {
        case 'task': return nOf(t, 'agent_studio.card.n_task', n, '{count} scheduled task', '{count} scheduled tasks');
        case 'cowork': return nOf(t, 'agent_studio.card.n_cowork', n, '{count} Cowork schedule', '{count} Cowork schedules');
        case 'support': return nOf(t, 'agent_studio.card.n_support', n, '{count} support inbox', '{count} support inboxes');
        case 'automation': return nOf(t, 'agent_studio.card.n_automation', n, '{count} routine', '{count} routines');
        case 'app': return nOf(t, 'agent_studio.card.n_app', n, '{count} app', '{count} apps');
        case 'webpage': return nOf(t, 'agent_studio.card.n_webpage', n, '{count} webpage', '{count} webpages');
        default: return `${n} ${kind}`;
    }
}

/** De kopjesnaam van een soort, voor "could not check: …". */
function kindHeading(t, kind) {
    switch (kind) {
        case 'task': return t('agent_usage.kind_task', 'Scheduled tasks');
        case 'cowork': return t('agent_usage.kind_cowork', 'Cowork schedules');
        case 'support': return t('agent_usage.kind_support', 'Support inboxes');
        case 'automation': return t('agent_usage.kind_automation', 'Routines');
        case 'app': return t('agent_usage.kind_app', 'Apps');
        case 'webpage': return t('agent_usage.kind_webpage', 'Webpages');
        default: return kind;
    }
}

/**
 * De halve zinnen na de telling: wat de agent gebruikt, en wat niemand kon
 * controleren. Allebei mogen ze ontbreken, en geen van beide mag als nul
 * lezen — een lijst zonder `?usage=1` levert hier niets op, en dat is iets
 * anders dan "door niets gebruikt".
 */
function usageParts(t, footer) {
    const parts = [];
    if (footer.usedBy.length > 0) {
        const items = footer.usedBy.map(u => usedByPhrase(t, u.kind, u.count)).join(', ');
        parts.push(t('agent_studio.card.also_in', 'also in {items}', { items }));
    }
    if (footer.unchecked.length > 0) {
        const kinds = footer.unchecked.map(k => kindHeading(t, k)).join(', ');
        parts.push(t('agent_studio.card.unchecked', 'could not check: {kinds}', { kinds }));
    }
    return parts;
}

/**
 * @param {object} props
 * @param {unknown} props.agent  één rij van GET /agents/all
 * @param {string|null} [props.viewerId]  wie er kijkt — zonder dit kan
 *   "Only you" niet waar zijn en verschijnt die vorm niet
 */
export default function AgentCardFooter({ agent, viewerId = null }) {
    const { t } = useTranslation();
    const footer = summariseCardFooter(agent, viewerId);

    // `<span className="block">`, geen `<p>`. De voet hangt binnen de
    // kaartknop van AgentCard.jsx, en een `<button>` neemt alleen phrasing
    // content — dat is de reden dat elk kind daar een span is.
    if (footer.variant === 'ungrounded') {
        return (
            <span
                className="flex items-center gap-1.5 text-xs"
                style={{ color: 'var(--warning)' }}
                data-testid="agent-card-footer"
                data-variant="ungrounded"
            >
                <AlertTriangle size={12} aria-hidden="true" className="flex-shrink-0" />
                <span>{t('agent_studio.card.ungrounded', 'Answers from memory — connect a knowledge base')}</span>
            </span>
        );
    }

    // De telling. Drie antwoorden: niet gevraagd (dan zwijgt de voet erover —
    // /agents/system rekent geen tellingen uit), niet gelezen (dat krijgt
    // woorden), of een getal dat de server geteld heeft (ook een 0).
    const unreadable = footer.statsAsked && footer.conversations === null;
    const countPart = !footer.statsAsked
        ? null
        : (unreadable
            ? t('agent_studio.card.conversations_unreadable', 'The conversation count could not be read')
            : nOf(t, 'agent_studio.card.n_conversations', footer.conversations, '{count} conversation', '{count} conversations'));

    const parts = [
        ...(footer.variant === 'private' ? [t('agent_studio.card.only_you', 'Only you')] : []),
        ...(countPart ? [countPart] : []),
        ...usageParts(t, footer),
    ];

    // Niets te zeggen is niets zeggen: een lege regel onder de kaart zou alleen
    // ruimte innemen en suggereren dat er iets ontbreekt.
    if (parts.length === 0) return null;

    return (
        <span
            className="block text-xs text-[var(--text-tertiary)]"
            data-testid="agent-card-footer"
            data-variant={footer.variant}
        >
            {parts.map((part, i) => (
                <React.Fragment key={`${i}-${part}`}>
                    {i > 0 && <span aria-hidden="true"> · </span>}
                    <span className={unreadable && part === countPart ? 'italic' : undefined}>{part}</span>
                </React.Fragment>
            ))}
        </span>
    );
}
