/**
 * WAT ER UIT DIT TRANSCRIPT KWAM — de pure helft van het zijpaneel
 * (Meeting Notes artboard 1b, plan M4 stap 2).
 *
 * Stap 1 gaf elke regel een popover: van hier wordt een zin een actie, een
 * besluit, een kennisregel, een tabelrij. Dit paneel is de andere kant van die
 * knop — wat er inmiddels úít deze vergadering is gehaald, naast het
 * transcript waar het uit komt.
 *
 * ── NIETS HIER TELT IETS DAT AL GETELD WORDT ────────────────────────
 * De actiepunten, besluiten en open vragen komen uit `buildFollowUpStats`
 * (lib/insightsMetrics.js) — dezelfde functie die de Inzichten-tab voedt. De
 * sprekers komen uit `buildInsightsModel().people`, precies de data die
 * PeopleTab tekent. Dit bestand voegt daar twéé dingen aan toe die nergens
 * anders bestaan, en verder niets:
 *
 *   1. welke kennisbanken regels uit dit transcript bevatten, uit de
 *      usage-rijen die de server al levert;
 *   2. of het aantal herkende sprekers achterblijft bij de aanwezigenlijst.
 *
 * ── "LEEG" EN "ONLEESBAAR" ZIJN TWEE ANTWOORDEN ─────────────────────
 * Beide functies hieronder hebben een expliciete onbekend-toestand, en die
 * versmalt altijd. Een kb-scan die niet kon draaien mag nooit lezen als "er
 * staat niets van deze vergadering in een kennisbank", en een vraag stellen
 * over een sprekerlijst die niet geladen is ("was Marijke erbij?") is erger
 * dan geen vraag stellen: hij noemt een naam op grond van niets.
 *
 * ── DE GATE ZIT IN HET MODEL, NIET IN DE OPMAAK ─────────────────────
 * `buildInsightsModel` bouwt `people` helemaal niet als de organisatie
 * per-persoonsstatistiek uit heeft staan. Dit paneel leest dat model en gaat
 * er niet omheen: `buildSpeakerCheck` krijgt de gate mee en noemt met de gate
 * dicht géén naam — alleen twee aantallen, dezelfde versmalling die
 * `topics.blocks` al doet (duur blijft, toeschrijving verdwijnt).
 */

import { buildSilentAttendees } from './insightsMetrics';

/** De drie antwoorden op "hebben we iedereen herkend?". */
export const SPEAKER_CHECK = Object.freeze({
    /** Een van de twee lijsten kon niet gelezen worden — niets vragen. */
    UNKNOWN: 'unknown',
    /** Even veel sprekers als aanwezigen, of geen aanwezigenlijst om mee te vergelijken. */
    COMPLETE: 'complete',
    /** Minder herkende sprekers dan aanwezigen — hier hoort de vraag. */
    GAP: 'gap',
});

/** De vier antwoorden op "welke kennisbanken hebben regels hiervan?". */
export const KNOWLEDGE_LINES = Object.freeze({
    /** De usage-fetch loopt nog. */
    LOADING: 'loading',
    /** De scan kon niet draaien én leverde niets op — we weten het niet. */
    UNKNOWN: 'unknown',
    /** Een antwoord. `partial` zegt of er iets ongecontroleerd bleef. */
    READY: 'ready',
});

/** Namen uit een lijst, of `null` als het geen lijst is (onleesbaar ≠ leeg). */
function readNames(value) {
    if (!Array.isArray(value)) return null;
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

/**
 * "2 kennisregels → Sales" — welke kennisbanken stukken van dit transcript
 * bevatten.
 *
 * Leest de rijen van de ENE usage-fetch die MeetingDetail al doet
 * (`useUsage('meeting', id)`), niet een tweede request: de balk onder de tags,
 * de Gebruikt-door-tab, de verwijderbevestiging en dit paneel horen hetzelfde
 * te zeggen over dezelfde vergadering. De server telt de gefileerde regels per
 * kennisbank (`lineCount`, core/meetingNotes/meetingUsage.js); hier wordt niets
 * hergeteld.
 *
 * `lineCount` is óók wat een gefileerde regel onderscheidt van een kb die deze
 * vergadering via een TAG verzamelt. Die tweede is een andere bewering — "alles
 * met dit label komt hier terecht" — en hoort in de outputs-balk, niet in
 * "hieruit gehaald".
 *
 * @param {Array|null|undefined} usage rijen uit useUsage; `null` = nog niet geladen
 * @param {{unchecked?: string[], error?: any}} [opts]
 * @returns {{state: string, partial: boolean, rows: Array, total: number}}
 */
export function buildKnowledgeLines(usage, { unchecked = [], error = null } = {}) {
    if (usage === null || usage === undefined) {
        return { state: KNOWLEDGE_LINES.LOADING, partial: false, rows: [], total: 0 };
    }
    const rows = (Array.isArray(usage) ? usage : []).filter(
        (r) => r && r.kind === 'kb' && Number.isInteger(r.lineCount) && r.lineCount > 0,
    );
    const total = rows.reduce((n, r) => n + r.lineCount, 0);
    // De kb-scan kon niet (volledig) draaien. Met rijen erbij is dat "minstens
    // dit"; zonder rijen is het geen nul maar een onbekende.
    const blind = !!error || (Array.isArray(unchecked) && unchecked.includes('kb'));
    if (blind && rows.length === 0) {
        return { state: KNOWLEDGE_LINES.UNKNOWN, partial: true, rows: [], total: 0 };
    }
    return { state: KNOWLEDGE_LINES.READY, partial: blind, rows, total };
}

/**
 * "Tweede spreker niet herkend — was X aanwezig?"
 *
 * DRIE toestanden, en de derde is de reden dat dit een functie is en geen
 * `speakers.length < attendees.length` in de opmaak. Minder sprekers dan
 * aanwezigen kan namelijk ook betekenen dat er helemaal geen diarisatie te
 * lezen viel — een notitie zonder segmenten, een provider die geen sprekers
 * levert, een mislukte pass. Dan is er geen tekort maar een gat in wat we
 * weten, en een vraag die iemands naam noemt is daar het slechtste antwoord op.
 *
 * De sprekerslijst is `model.talk.speakers`: wie er in de SEGMENTEN aan het
 * woord is. Bewust niet de opgeslagen `meeting.speakers`-roster — daar kan een
 * naam in staan die in het transcript nergens iets zegt, en die zou dan een
 * echte niet-herkende spreker wegstrepen.
 *
 * @param {object} meeting detail-payload (alleen `attendees` wordt gelezen)
 * @param {object|null} model resultaat van buildInsightsModel (null = te weinig spraak)
 * @param {{perPersonEnabled?: boolean}} [opts]
 * @returns {{state: string, speakerCount: number|null, attendeeCount: number|null,
 *            names: string[]|null}} `names` is null zodra er geen naam genoemd
 *          mag worden — met de gate dicht, of buiten de GAP-toestand.
 */
export function buildSpeakerCheck(meeting, model, { perPersonEnabled = true } = {}) {
    const attendees = readNames(meeting?.attendees);
    const recognised = model?.talk?.speakers;
    const speakerCount = Array.isArray(recognised) ? recognised.length : null;
    const attendeeCount = attendees === null ? null : attendees.length;

    // Onbekend versmalt: zonder leesbare diarisatie, of zonder leesbare
    // aanwezigenlijst, wordt er niets gevraagd en niets beweerd.
    if (!speakerCount || attendees === null) {
        return { state: SPEAKER_CHECK.UNKNOWN, speakerCount, attendeeCount, names: null };
    }
    if (attendeeCount === 0 || speakerCount >= attendeeCount) {
        return { state: SPEAKER_CHECK.COMPLETE, speakerCount, attendeeCount, names: null };
    }
    return {
        state: SPEAKER_CHECK.GAP,
        speakerCount,
        attendeeCount,
        // PER-PERSOON. `buildSilentAttendees` is dezelfde voorzichtige
        // naamvergelijking die de Inzichten-tab gebruikt (twijfel telt als
        // aanwezig), en hij draait alleen als de organisatie dat toestaat —
        // met de gate dicht blijven alleen de twee aantallen over.
        names: perPersonEnabled ? buildSilentAttendees(attendees, recognised) : null,
    };
}
