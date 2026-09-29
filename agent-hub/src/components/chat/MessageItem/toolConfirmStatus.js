/**
 * De stand van één vastgehouden call — ÉÉN lezing, voor de kaart én het spoor.
 *
 * `tool_confirm` zegt dat de agent iets wilde doen en het niet gedaan heeft.
 * Daarna kan er van twee kanten een beslissing bijkomen:
 *
 *   SERVER   een nieuw `tool_confirm` met `status: 'approved'|'declined'`. De
 *            beurt is dan al langs die call gekomen: approved betekent dat hij
 *            GEDRAAID HEEFT.
 *   SESSIE   de klik van deze gebruiker op de kaart, nog niet verstuurd. De
 *            beslissing reist mee met het VOLGENDE bericht en de call draait
 *            pas als het model hem opnieuw voorstelt. Approved betekent hier
 *            dus "gaat draaien", niet "heeft gedraaid".
 *
 * Die twee zijn in de UI door elkaar gelopen: de kaart zei "You approved this —
 * it ran" zodra er geklikt was, terwijl er nog niets gebeurd was. Vandaar dat
 * dit bestand niet alleen de STAND teruggeeft maar ook WIE hem zette. Een
 * paneel dat beweert dat iets gedraaid heeft terwijl het klaarstaat is precies
 * de geruststelling die een testchat hoort te vinden, niet te maken.
 *
 * ── ONBEKEND VERSMALT, EN VERSMALLEN IS HIER NIET 'PENDING' ────────────────
 *
 * Een status die we niet kennen mag geen 'pending' worden: 'pending' is zelf
 * een BEWERING ("dit heeft niet gedraaid"), en die kunnen we bij een onbekende
 * stand niet doen. Er is dus een vierde stand, `unknown`, en die zegt precies
 * dat: we weten het niet. Geen knoppen, geen groen, geen "het staat nog open".
 *
 * Zuiver: geen React, geen t(), geen DOM.
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/components/chat/MessageItem/toolConfirmStatus.test.js
 */

/** De gesloten lijst. Alles daarbuiten is `unknown`, nooit iets geruststellends. */
export const CONFIRM_STATUSES = Object.freeze(['pending', 'approved', 'declined', 'unknown']);

/** Wie de stand zette: de server (het is gebeurd) of deze sessie (het gaat gebeuren). */
export const DECISION_SOURCES = Object.freeze(['server', 'session']);

/**
 * Stand + herkomst van één vastgehouden call.
 *
 * ── DE SESSIE-AANTEKENING HANGT AAN DE KAART, NIET AAN DE ACTIE ───────────
 *
 * `decided` wordt bij voorkeur op `callId` gelezen en pas daarna op `argsKey`.
 * Dat is geen detail: `argsKey` is naam-plus-argumenten en dus voor élke
 * kaart van dezelfde actie hetzelfde, terwijl `callId` per ronde nieuw is.
 * Op argsKey lezen liet een kaart in beurt 5 "You declined this" zeggen op een
 * klik uit beurt 2 — inclusief het weghalen van de knoppen waarmee je dat had
 * kunnen herzien. De klik is een feit over ÉÉN kaart; een nieuwe kaart voor
 * dezelfde actie is een nieuwe vraag.
 *
 * @param {object} call     één regel uit `msg.pendingToolCalls`
 * @param {object} [decided] { [callId of argsKey]: 'approve'|'decline' } — wat
 *                           er in deze sessie geklikt is
 * @returns {{status: string, by: string|null}} `by` is null zolang er niets
 *          beslist is (status 'pending') of niemand het weet ('unknown').
 */
export function confirmDecisionOf(call, decided = {}) {
    if (!call || typeof call !== 'object') return { status: 'unknown', by: null };

    // De server heeft het laatste woord: hij weet of de call gedraaid heeft.
    const served = call.status;
    if (served && served !== 'pending') {
        return CONFIRM_STATUSES.includes(served)
            ? { status: served, by: served === 'unknown' ? null : 'server' }
            : { status: 'unknown', by: null };
    }

    const book = decided && typeof decided === 'object' ? decided : null;
    const callKey = typeof call.callId === 'string' && call.callId ? call.callId : null;
    const argsKey = typeof call.argsKey === 'string' && call.argsKey ? call.argsKey : null;
    // callId eerst — zie de kop. argsKey blijft als terugval voor een kaart
    // zonder callId (en voor de aanroeper die nog op argsKey boekhoudt).
    const mine = book
        ? (callKey && book[callKey] !== undefined ? book[callKey] : (argsKey ? book[argsKey] : null))
        : null;
    if (mine === 'approve') return { status: 'approved', by: 'session' };
    if (mine === 'decline') return { status: 'declined', by: 'session' };
    return { status: 'pending', by: null };
}

/** Alleen de stand, voor wie de herkomst niet nodig heeft. */
export function confirmStatusOf(call, decided = {}) {
    return confirmDecisionOf(call, decided).status;
}
