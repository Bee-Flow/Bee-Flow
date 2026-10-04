import React, { useRef } from 'react';
import { nOf } from './KnowledgeStudio/plural';
import { NewMenuButton } from './NewMenu';
import DescribeItPanel from './studioAi/DescribeItPanel';
import { useStudioCounts } from '../../../hooks/useStudioCounts';
import { useTranslation } from '../../../hooks/useTranslation';

/**
 * De kop van het Startscherm van Studio (Track H3, artboard 1b).
 *
 * Vier dingen, en drie ervan zijn een belofte die makkelijk te ver gaat.
 *
 * ── "Organisatie X · 12 makers" ─────────────────────────────────────────────
 *
 * Het getal komt van GET /api/studio/counts, waar het op de SERVER wordt
 * geteld: één verzameling van alle eigenaren over alle getelde soorten heen.
 * Niet in de client uit de lijsten afgeleid — die zijn gepagineerd en gegate,
 * en dan telt de kop iets anders dan er onder staat.
 *
 * Wat het getal WEL is, staat in de tooltip, want het is smaller dan de kop
 * suggereert: het zijn de eigenaren van alles wat DEZE persoon mag zien
 * (routes/studio/counts.js laat elke sleutel weg die je niet mag zien, en
 * telt per soort met de scoping van de lijst zelf). Een organisatiebreed
 * makersgetal zou een eigen, gegate telling op de server zijn; die bestaat
 * vandaag niet en wordt hier niet nagebootst.
 *
 * Drie waarden, drie renderingen — het verschil tussen "nul" en "onbekend" is
 * op dit scherm de kern:
 *   onbekend (nog niet geladen, of de fetch viel om) → geen zin. Er wordt
 *      niets beweerd tot het antwoord er is, dezelfde regel als de aantallen
 *      op de rail
 *   0  → "Nothing you can see here yet", niet "0 makers": dat laatste leest
 *      als "hier werkt niemand" terwijl de lezer er zelf bij staat. En de zin
 *      gaat over ZICHT, niet over de plek: 0 is ook wat je krijgt als elke
 *      soort voor deze lezer gegate is. Een 0 die uit een MISLUKTE telling
 *      kwam bestaat niet meer — routes/studio/counts.js laat `makers` weg
 *      zodra het antwoord partial is, precies zoals het een teller weglaat
 *   1+ → het getal, met enkelvoud en meervoud uit elkaar gehouden
 *
 * ── Eén verzoek, geen tweede poller ─────────────────────────────────────────
 *
 * De rail pollt /api/studio/counts al elke 30s. Deze kop leest hetzelfde
 * antwoord ÉÉN keer (useStudioCounts met poll: false) — de server cachet het
 * een minuut per (org, gebruiker), dus meestal heeft de rail er al voor
 * betaald.
 *
 * ── "Bouwen met AI" staat hier nu wél ───────────────────────────────────────
 *
 * Tot H4 stond op deze plek een plaatshouder: een gestippelde kaart die zei
 * wat het zou worden en dat het er nog niet was. De reden daarvoor is niet
 * vervallen maar INGELOST — een knop die niets doet is erger dan geen knop, en
 * een tekstvak waar je niet in kunt typen is een kapot bedieningselement, dus
 * kwam er pas iets klikbaars toen er iets achter zat. Dat is er nu:
 * studioAi/DescribeItPanel (variant 'inline') praat met POST
 * /api/studio/ai/route en brengt de lezer daarna naar de BESTAANDE bouwer van
 * de gekozen soort. Het paneel krijgt dezelfde `sections` als de rest van dit
 * scherm, zodat een soort die deze lezer niet mag maken ook daar een bordje
 * blijft in plaats van een deur te worden.
 *
 * ÉÉN paneel op dit scherm, niet twee. De AI-regel van het "Nieuw"-menu krijgt
 * daarom een eigen `onAi` die naar DIT paneel brengt (in beeld, cursor in het
 * veld) in plaats van een tweede exemplaar in een dialoog te openen. Dat is
 * meteen wat die regel van de Automations-terugval verlost: met een eigen `onAi`
 * volgt hij deze kop en is hij niet langer gelockt precies wanneer Automatiseringen
 * dat zijn (zie AI_FALLBACK_SECTION in NewMenu.jsx).
 *
 * Wat het paneel NIET doet — meerdere soorten in één keer aanmaken — staat in
 * studioAi/DescribeItPanel zelf: dat is H4b en wacht op K8.
 *
 * ── Het "Nieuw"-menu ────────────────────────────────────────────────────────
 *
 * De split-knop uit NewMenu.jsx, hier voor het eerst gemonteerd ("Track H
 * places it in the Studio header"). Hij krijgt dezelfde `sections` als de rest
 * van dit scherm — de al gegate rijen — zodat een gelockte soort in het menu
 * staat met de hint die de rail ook toont, in plaats van te verdwijnen.
 */

/** De ene regel onder "Start": wie hier bouwt, of anders waar je bent. */
function MetaLine({ t, orgName, makers }) {
    const makersPhrase = makers === null
        ? null
        : (makers === 0
            ? t('studio.makers_none', 'Nothing you can see here yet')
            : nOf(t, 'studio.makers', makers, '{count} maker', '{count} makers'));

    if (!orgName && !makersPhrase) {
        // Nog niets te melden: de kop blijft één zin, niet een kaal woord.
        return (
            <p className="mt-1 text-[13px] text-[var(--text-tertiary)]" data-testid="studio-home-desc">
                {t('studio.start.desc', 'Everything you build, in one place')}
            </p>
        );
    }
    return (
        <p className="mt-1 text-[13px] text-[var(--text-tertiary)]" data-testid="studio-home-meta">
            {orgName && <span data-testid="studio-home-org">{orgName}</span>}
            {orgName && makersPhrase && <span aria-hidden="true"> · </span>}
            {makersPhrase && (
                <span
                    data-testid="studio-home-makers"
                    // Wat er precies geteld is. De kop zegt "makers"; dit zegt
                    // welke makers, en dat is smaller dan de hele organisatie.
                    title={t('studio.makers_hint', 'Everyone who owns something you can see in Studio.')}
                >
                    {makersPhrase}
                </span>
            )}
        </p>
    );
}

export default function StudioHomeHeader({
    user = null, sections = null, onNavigate = null, makers: makersProp,
}) {
    const { t } = useTranslation();
    // `undefined` = niemand boven ons bezit het getal, dus lezen we het zelf:
    // één keer, geen timer (de rail pollt dit endpoint al — zie de hook). Geeft
    // de ouder het wél mee, dan is er ÉÉN lezing op dit scherm in plaats van
    // twee die uiteen kunnen lopen; `null` van de ouder is een antwoord
    // ("onbekend"), en dat is iets anders dan geen prop.
    const ownsMakers = makersProp === undefined;
    const { makers: fetched } = useStudioCounts({ enabled: ownsMakers, poll: false });
    const makers = ownsMakers ? fetched : makersProp;

    const rawOrgName = user?.organization?.name;
    const orgName = typeof rawOrgName === 'string' && rawOrgName.trim() ? rawOrgName.trim() : null;

    // De AI-regel van het "Nieuw"-menu landt op het paneel dat hier al staat:
    // in beeld brengen en de cursor in het veld zetten. Geen tweede exemplaar
    // van hetzelfde paneel, en dus ook geen tweede antwoord op één scherm.
    const aiRef = useRef(null);
    const focusAi = () => {
        const host = aiRef.current;
        if (!host) return;
        // Niet elke omgeving kent scrollIntoView (jsdom bijvoorbeeld); het is
        // de begeleiding, niet de handeling, dus het mag ontbreken.
        if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
        const field = host.querySelector('textarea, input');
        if (field && typeof field.focus === 'function') field.focus();
    };

    return (
        <header data-testid="studio-home-header">
            <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                    <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">
                        {t('studio.start.title', 'Start')}
                    </h1>
                    <MetaLine t={t} orgName={orgName} makers={makers} />
                </div>
                <div className="flex-shrink-0 pt-1">
                    <NewMenuButton sections={sections} onNavigate={onNavigate} user={user} onAi={focusAi} />
                </div>
            </div>
            <div className="mt-4" ref={aiRef}>
                <DescribeItPanel sections={sections} onNavigate={onNavigate} user={user} variant="inline" />
            </div>
        </header>
    );
}
