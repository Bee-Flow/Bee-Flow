/**
 * De 409-poort voor DELETE /:id — zie de uitleg hieronder.
 *
 * Eigen module omdat dit geen HTTP is maar een uitspraak: wat gebruikt deze
 * pagina nog, en welke deelvraag kon NIET worden beantwoord. De route
 * (./lifecycle.js) doet er alleen een status omheen.
 */

const webpageUsage = require('../../core/webpages/webpageUsage');
const log = require('../../telemetry/log');

/**
 * ── WAT ER STUKGAAT, VOORDAT HET STUKGAAT (W5 deel C) ───────────────
 *
 * Een webpagina is geen los ding. Ze ligt in een Oplossing die haar in een
 * scherm heeft opgenomen, een ROUTINE noemt haar bij naam in een
 * `webpage_db_exec`-stap, een gewone chat kan haar in het zijpaneel hebben, en
 * een agent kan haar als tool openen. Geen van die storingen NOEMT deze pagina
 * op het moment dat ze optreedt, en geen ervan is terug te draaien — dus
 * antwoordt de eerste DELETE met 409 en de lijst, en komt alleen een tweede
 * met `?confirm=1` erlangs. Letterlijk de twee-trap van de vergadernotitie
 * (routes/transcriptions/noteActions.js), de kennisbank en de tabel, met
 * dezelfde `code:'in_use'` + `usage` die shared/DangerZone.jsx leest.
 *
 * `unchecked` TELT ALS IN GEBRUIK. "Drie dingen gebruiken deze pagina" en "ik
 * kon de agents niet nakijken" komen allebei terug als 409 en leiden naar
 * dezelfde knop, maar het zijn niet dezelfde uitspraak: de eerste is een
 * lijst, de tweede is een gat. Wie ze samenvoegt, vertelt de lezer dat een
 * scan is geslaagd die niet liep. Vandaag zijn de agent- én de chat-deelvraag
 * principieel onbeantwoordbaar (zie de kop van core/webpages/webpageUsage.js),
 * dus staat elke pagina achter minstens één 409 — dat is de eerlijke stand, en
 * de ontsnappingsklep is een BEVESTIGDE tweede aanroep, nooit een stille retry.
 *
 * En de scan die ZELF omvalt is de gevaarlijkste van de drie: die zou als een
 * lege lijst terugkomen, en een lege lijst is precies de zin waarop iemand
 * doorklikt. Vandaar dat een omgevallen scan hier ALLE soorten als
 * niet-gecontroleerd meldt in plaats van als nul — onbekend versmalt.
 */
async function describeWebpageDeleteBlock(wp, userId) {
    let scan;
    try {
        scan = await webpageUsage.usageForWebpage(wp);
    } catch (err) {
        // `usageForWebpage` vangt elke deelvraag apart op, dus hier belanden
        // betekent dat er niets gecontroleerd is. Niet "niets gebruikt dit".
        log.warn(`[Webpages] Delete guard scan failed for ${wp?.id}:`, err.message);
        return {
            error: 'Could not check what uses this webpage',
            code: 'in_use',
            usage: [],
            unchecked: [...webpageUsage.KINDS],
            sources: Object.fromEntries(webpageUsage.KINDS.map(k => [k, {
                status: 'unavailable', found: null, reason: webpageUsage.REASONS.SCAN_FAILED,
            }])),
            complete: false,
        };
    }

    const { rows, partial, sources, complete } = scan;
    if (rows.length === 0 && partial.length === 0) return null;
    return {
        // Twee verschillende zinnen voor twee verschillende feiten. De client
        // kiest zijn eigen woorden (DangerZone toont zijn eigen kop), maar een
        // logregel of een curl mag hier niet het verkeerde verhaal lezen.
        error: rows.length > 0
            ? 'This webpage is still in use'
            : 'Could not check what uses this webpage',
        code: 'in_use',
        // Andermans Oplossing houdt soort en rol en verliest zijn naam —
        // dezelfde versmalling als GET /:id/usage, zodat het tabblad en deze
        // poort niet van elkaar kunnen gaan verschillen.
        usage: webpageUsage.redactForeign(rows, userId),
        unchecked: partial,
        sources,
        complete,
    };
}

module.exports = { describeWebpageDeleteBlock };
