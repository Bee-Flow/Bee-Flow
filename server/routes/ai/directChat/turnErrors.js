/**
 * Direct Chat — well-known upstream failures, said in words the user can act
 * on instead of a transport error. Anything unrecognised is passed through
 * unchanged, and the raw text still rides along on the SSE error event.
 * Moved verbatim out of streamTurn.js.
 */

function toFriendlyTurnError(raw) {
    if (/image dimensions exceed.*pixel/i.test(raw)) {
        return 'Eén van de afbeeldingen in deze chat is te groot voor het AI-model (>2000px). Verklein de afbeelding of verwijder oudere bijlagen en probeer opnieuw.';
    }
    if (/many-image requests/i.test(raw)) {
        return 'Te veel of te grote afbeeldingen in deze conversatie. Verwijder oudere bijlagen of start een nieuwe chat.';
    }
    if (/no low surrogate|invalid.*surrogate/i.test(raw)) {
        return 'De conversatie bevat ongeldige Unicode-tekens. Probeer een nieuw bericht; oudere berichten worden bij de volgende compactie opgeschoond.';
    }
    if (/API error 4\d\d/.test(raw)) {
        return `AI-provider gaf een fout terug: ${raw}`;
    }
    return raw;
}

module.exports = { toFriendlyTurnError };
