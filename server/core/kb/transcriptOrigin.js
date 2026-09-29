// @typecheck
'use strict';
const log = require('../../telemetry/log');

/**
 * ── HET ID IS EEN BEWERING OVER EEN VERGADERING (M4) ────────────────
 *
 * `config.metadata.transcriptionId` op een `text`-bron laat die regel LANDEN
 * op de tijdlijn van die vergadering: de balk onder de tagrij, het
 * Gebruikt-door-tabblad en "Uit dit transcript gehaald" lezen hem alle drie
 * terug, en de verwijderpoort van de notitie telt hem mee
 * (core/meetingNotes/meetingUsage.js `scanKb`).
 *
 * Beheerdersrecht op de KENNISBANK is daar geen antwoord op — op je eigen
 * kennisbank ben je altijd beheerder. Zonder deze poort kan dus iedereen een
 * id verzinnen (of meekopiëren) en een onware, niet te weerleggen en niet te
 * verwijderen regel op de vergadering van een ander plakken.
 *
 * ── ÉÉN POORT, TWEE SCHRIJVERS ──────────────────────────────────────
 * De poort stond in `POST /api/kb/:id/sources`, en dat was precies één van de
 * twee wegen waarlangs zo'n bewering ontstaat: `POST /api/kb/:id/duplicate
 * ?withSources=1` kopieert elke niet-upload bron letterlijk — inclusief de
 * metadata — naar een nieuwe kennisbank van de aanroeper, en kwam er niet
 * langs. Vandaar dit bestand: de vraag hoort één keer te bestaan, buiten de
 * routes, zodat een derde schrijver hem niet opnieuw hoeft te bedenken.
 *
 * ── HIJ DRAAIT ALS DE SCHRIJVER, EN ONBEKEND VERSMALT ───────────────
 * De context komt van `askerContext` (de MAKER), niet van de eigenaar van de
 * kennisbank, en BEWUST zonder `isSuperAdmin`: die vlag laat
 * `canReadTranscription` elk id doorlaten, en dan controleert de poort niets
 * meer. Een vergadering die de schrijver niet mag zien geeft exact hetzelfde
 * antwoord als een vergadering die niet bestaat — anders is deze route een
 * orakel voor welke vergadering-ids bestaan. Een probe die omvalt is GEEN
 * toestemming.
 */

/**
 * Mag `userId` een regel op de tijdlijn van deze vergadering plakken?
 *
 * @param {string} transcriptionId  het id uit `config.metadata`
 * @param {string} userId           de SCHRIJVER, niet de eigenaar van de KB
 * @returns {Promise<{ok: true} | {ok: false, status: number, code: string, error: string}>}
 *   `ok:false` met status 400 (`transcription_not_visible`) als hij hem niet
 *   mag zien, of 502 (`transcription_probe_failed`) als we het niet kónden
 *   vaststellen. Twee codes, want "nee" en "ik weet het niet" zijn twee
 *   verschillende zinnen — alleen bij de eerste weet de schrijver dat hij het
 *   niet mag, bij de tweede kan hij het straks opnieuw proberen.
 */
async function checkTranscriptOriginVisible(transcriptionId, userId) {
    if (!transcriptionId) return { ok: true };   // geen bewering, niets te controleren
    const { askerContext } = require('./askerContext');
    const asker = await askerContext(userId);
    try {
        const visible = await require('../../stores/transcriptionStore').canReadTranscription(
            transcriptionId,
            userId,
            // Geen `isSuperAdmin`. Zie de kop: die vlag zou de poort openen in
            // plaats van hem te stellen.
            { orgIds: [...asker.orgIds], userGroupIds: asker.userGroups },
        );
        if (!visible) {
            return {
                ok: false, status: 400,
                code: 'transcription_not_visible',
                error: 'That meeting is not available to you.',
            };
        }
        return { ok: true };
    } catch (e) {
        log.warn('[KB] transcript origin probe failed:', e.message);
        return {
            ok: false, status: 502,
            code: 'transcription_probe_failed',
            error: 'Could not check that meeting right now.',
        };
    }
}

/**
 * Dezelfde vraag, voor een pad dat niet mag falen: geef de config terug
 * ZONDER de bewering zodra die niet houdbaar is.
 *
 * Het duplicaat-pad is per bron best-effort — de kopie bestaat al tegen de
 * tijd dat dit draait — dus daar is 'weigeren' geen optie en 'de bewering
 * laten vallen' het juiste antwoord: de bron zelf is gewone inhoud van een
 * kennisbank die de aanroeper mag lezen, alleen de claim op andermans
 * vergadering is dat niet. Een probe die omvalt laat de claim óók vallen.
 *
 * @param {object|null|undefined} config  de config van de bron die gekopieerd wordt
 * @param {string} userId                 de SCHRIJVER van de kopie
 * @returns {Promise<object>} een config die veilig geschreven kan worden
 */
async function stripUnauthorizedTranscriptOrigin(config, userId) {
    const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    const claimed = cfg.metadata && typeof cfg.metadata === 'object' && !Array.isArray(cfg.metadata)
        ? cfg.metadata.transcriptionId
        : null;
    if (typeof claimed !== 'string' || !claimed.trim()) return cfg;

    const verdict = await checkTranscriptOriginVisible(claimed.trim(), userId);
    if (verdict.ok) return cfg;
    // Allow-list, geen delete-keys: bouw de kopie op uit wat er mag blijven.
    // Zo rijdt een veld dat volgend jaar aan `metadata` wordt toegevoegd niet
    // vanzelf mee als deze regel ooit uitsluitend een sleutel zou verwijderen.
    const { metadata, ...rest } = cfg;
    log.warn(`[KB] Duplicate: transcript origin ${claimed} dropped — the copier may not see that meeting (${/** @type {{code: string}} */ (verdict).code})`);
    return rest;
}

module.exports = { checkTranscriptOriginVisible, stripUnauthorizedTranscriptOrigin };
