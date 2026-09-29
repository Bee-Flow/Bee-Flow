/**
 * App Studio — een CLIËNT-VEILIGE weigering op het LEESPAD.
 *
 * `safe` is wat een router toestaat de boodschap letterlijk door te geven
 * (routes/studioAppData.js handleErr, routes/studioAppPublic.js handleErr, en
 * dataReadRunner.runBatch voor een per-lezing-status). Deze strings zijn dus
 * geschreven om gelezen te worden door iemand die de app niet gemaakt heeft:
 * geen interne paden, geen SQL, geen namen van andermans organisaties.
 *
 * Waarom een eigen bestandje: er zijn twee modules op het leespad die zo'n
 * weigering maken — dataReadRunner.js (de tabel bestaat niet / deze rol mag niet
 * lezen) en datatableSource.js (de gekoppelde Studio-tabel) — en de vlag hoort
 * op één plek gezet te worden. Twee kopieën van deze vier regels zijn twee
 * plekken waar iemand later `safe: true` op een interne foutmelding zet.
 *
 * Het SCHRIJFpad gebruikt dezelfde weigering: actionExecutor/records.js roept
 * datatableSource aan (met een schrijfactie in plaats van een lezing) en vertaalt
 * wat er uitkomt naar een stapfout. Er is dus één soort weigering voor allebei,
 * en de naam `readError` is inmiddels een understatement — hij dekt elke
 * cliënt-veilige weigering rond een tabel.
 *
 * ── LET OP DE STATUS ────────────────────────────────────────────────
 * De runtime-client degradeert een 404 naar "leeg": zie
 * agent-hub/.../runtime/useAppDataSource.js (`if (res.status === 404) return []`)
 * en runtime/dataBatchClient.js (`unwrapRead` geeft de notFoundValue terug).
 * Een weigering die 404 antwoordt, verschijnt op het scherm dus als een lege
 * lijst — en "leeg" en "onleesbaar" zijn verschillende antwoorden.
 *
 * Daarom is een weigering NOOIT een 404:
 *   403  je mag dit niet lezen
 *   422  de koppeling in het model deugt niet (de app wijst naar iets kapots)
 *   503  we konden het niet vaststellen (uitval, geen antwoord)
 * 404 blijft wat het altijd was: "die tabel bestaat niet in dit model".
 */

'use strict';

/** Een weigering met status + boodschap die de router letterlijk doorgeeft. */
function readError(status, message) {
    const err = new Error(message);
    err.status = status;
    err.safe = true;
    return err;
}

module.exports = { readError };
