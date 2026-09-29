/**
 * versionFacts — wat er in ÉÉN bewerking van een webpagina gebeurde, mechanisch
 * afgeleid, plus wie hem maakte.
 *
 * ── WAAROM DIT EEN EIGEN MODULE IS ──────────────────────────────────────────
 *
 * De rij in de geschiedenislijst wordt op drie plekken geschreven — de
 * handmatige save (routes/webpages.js, PUT /:id), de AI-beurt
 * (routes/ai/webpageChat.js) en het terugzetten (POST /:id/versions/:vid/
 * restore) — en op één plek gelezen (GET /:id/versions). Zonder een gedeelde
 * module zouden er drie manieren ontstaan om "hoeveel regels" en "hoe heet dit"
 * te berekenen, en dan gaat de lijst verschillende talen spreken over dezelfde
 * gebeurtenis.
 *
 * Alles hier is ZUIVER: geen database, geen opslag, geen require van een store.
 * De route levert de feiten aan (de bytes, de namen); deze module beslist wat
 * ervan te maken valt. Dat maakt hem toetsbaar zonder harnas.
 *
 * ── DE REGEL DIE DEZE MODULE BESCHERMT ──────────────────────────────────────
 *
 * ONBEKEND IS NIET NUL EN NIET JIJ.
 *
 *   - Een regelverschil dat we niet konden meten is `null`, nooit 0. "Er
 *     veranderde niets" is een uitspraak; "we hebben niet gekeken" is er geen.
 *   - Een `actor_user_id` die niet te lezen is (nooit vastgelegd, of een
 *     account dat niet meer bestaat) levert een maker die ONBEKEND is. Nooit
 *     de lezer zelf — dat zou de geschiedenis een bewering laten doen over wie
 *     iets deed, op grond van niets.
 *
 * ── DE SAMENVATTING WORDT AFGELEID, NOOIT GELEZEN ───────────────────────────
 *
 * De eenregelige samenvatting van een AI-beurt komt uit WAT ER GEBEURDE (welke
 * slots de gereedschappen schreven), niet uit de proza van het model. Dezelfde
 * regel die agent-hub/src/pages/webpages/webpageTurnFacts.js aan de clientkant
 * al aanhoudt: het model beschrijft zijn eigen werk niet altijd correct, de
 * gereedschapsgeschiedenis wel.
 */

'use strict';

/**
 * De drie slots met de namen die overal in het product gelden. Dezelfde
 * namen als agent-hub/src/pages/webpages/webpageCodeFiles.PRIMARY_SLOTS en als
 * stores/webpage/shared.js' sleutels — hier nodig omdat de samenvatting een
 * BESTANDSNAAM moet noemen en niet een slotletter.
 */
const SLOT_FILES = Object.freeze({
    html: 'index.html',
    css: 'style.css',
    js: 'script.js',
});

/** De vaste samenvatting van een handmatige bewerking in de Code-tab. */
const MANUAL_EDIT_SUMMARY = 'Edited in code';

/**
 * Aantal regels in een tekst.
 *
 * Niet `text.split('\n').length`: die telt een afsluitende newline als een
 * extra lege regel, waardoor "a\n" twee regels zou zijn en elke bewerking die
 * alleen de afsluiting toevoegt +1 zou opleveren.
 *
 * Een lege tekst heeft 0 regels — een leeg bestand is niet één lege regel.
 */
function countLines(text) {
    if (typeof text !== 'string' || text === '') return 0;
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return text.charCodeAt(text.length - 1) === 10 ? n : n + 1;
}

/**
 * Het NETTO regelverschil tussen twee versies van dezelfde tekst.
 *
 * Geeft `null` zodra één van beide kanten geen tekst is — dan is er niets
 * gemeten en mag er geen getal ontstaan.
 */
function lineDelta(before, after) {
    if (typeof before !== 'string' || typeof after !== 'string') return null;
    return countLines(after) - countLines(before);
}

/**
 * Het netto regelverschil over een verzameling slots.
 *
 * `before` en `after` zijn objecten met slotsleutels ({ html, css, js }).
 * Slots waarvan één van beide kanten ontbreekt tellen niet mee — maar als
 * daardoor NIETS meetbaar overblijft is de uitkomst `null` en niet 0.
 */
function slotsLineDelta(before, after, slots) {
    const list = Array.from(slots || []);
    let total = 0;
    let measured = 0;
    for (const slot of list) {
        const d = lineDelta(before?.[slot], after?.[slot]);
        if (d === null) continue;
        total += d;
        measured++;
    }
    return measured === 0 ? null : total;
}

/** `index.html`, `index.html and style.css`, `a, b and c`. */
function joinFileNames(names) {
    const list = names.filter(Boolean);
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * De eenregelige samenvatting van één AI-beurt.
 *
 * Slots worden in de vaste volgorde html → css → js genoemd, niet in de
 * volgorde waarin de gereedschappen toevallig vuurden: twee identieke beurten
 * horen dezelfde regel op te leveren.
 *
 * Een beurt zonder herkenbaar slot valt terug op 'AI edit' — de tekst die deze
 * rijen vóór W4 allemaal droegen. Dat is geen mooie samenvatting, maar het is
 * de eerlijke: we weten alleen dát de AI iets deed.
 */
function aiTurnSummary(slots) {
    const known = Object.keys(SLOT_FILES).filter(slot => Array.from(slots || []).includes(slot));
    if (known.length === 0) return 'AI edit';
    return `AI edited ${joinFileNames(known.map(s => SLOT_FILES[s]))}`;
}

/**
 * De samenvatting van de momentopname die een TERUGZETTEN maakt.
 *
 * De rij bevat de stand van VÓÓR het terugzetten — hem terugzetten maakt het
 * terugzetten ongedaan. De tekst zegt dat dus letterlijk, in plaats van
 * "Restored v12", wat op een rij met de oude inhoud precies andersom leest.
 */
function restoreSummary(seq) {
    return Number.isFinite(seq) && seq > 0
        ? `Before restoring v${seq}`
        : 'Before restoring an earlier version';
}

/**
 * Wie de versie maakte, zoals de geschiedenislijst hem mag tonen.
 *
 * @param {string|null} actorUserId  de kolomwaarde
 * @param {object} opts
 * @param {string|null} opts.viewerId  wie er kijkt (voor `isYou`)
 * @param {Map|object|null} opts.names id → weergavenaam, door de route
 *        opgezocht. Een id dat er niet in staat is een account dat niet meer
 *        te lezen is.
 * @returns {null | { id: string, name: string|null, isYou: boolean }}
 *          `null` = nooit vastgelegd. `name: null` = vastgelegd maar niet te
 *          lezen. Beide gevallen tekent de UI als "onbekend"; het onderscheid
 *          blijft staan omdat alleen het tweede geval een spoor heeft om op
 *          door te zoeken.
 */
function actorOf(actorUserId, { viewerId = null, names = null } = {}) {
    const id = typeof actorUserId === 'string' && actorUserId.trim() ? actorUserId.trim() : null;
    if (!id) return null;
    let name = null;
    if (names && typeof names.get === 'function') name = names.get(id);
    else if (names && typeof names === 'object') name = names[id];
    return {
        id,
        name: (typeof name === 'string' && name.trim()) ? name.trim() : null,
        // Op het ID, niet op de naam: twee collega's mogen dezelfde
        // weergavenaam dragen zonder dat de een het werk van de ander erft.
        isYou: !!viewerId && id === viewerId,
    };
}

module.exports = {
    SLOT_FILES,
    MANUAL_EDIT_SUMMARY,
    countLines,
    lineDelta,
    slotsLineDelta,
    joinFileNames,
    aiTurnSummary,
    restoreSummary,
    actorOf,
};
