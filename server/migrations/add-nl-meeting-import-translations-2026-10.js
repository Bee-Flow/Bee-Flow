#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the outcome of a background meeting import (Teams, Google Meet):
 * the progress line and one sentence per stable failure code on the import job.
 *
 * Idempotent: only fills keys that are missing. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-meeting-import-translations-2026-10.js
 */

const NL_TRANSLATIONS = Object.freeze({
    'meetings.import_error_access_disabled': 'Je organisatie staat toegang tot deze opname niet toe.',
    'meetings.import_error_already_imported': 'Iemand anders heeft deze vergadering al geïmporteerd. Vraag of die de vergadernotitie met je deelt.',
    'meetings.import_error_empty': 'De opname bevatte geen spraak om te transcriberen.',
    'meetings.import_error_failed': 'De import is mislukt. Probeer het zo meteen opnieuw.',
    'meetings.import_error_needs_reauth': 'De toegang is verlopen. Koppel je account opnieuw en probeer het nog eens.',
    'meetings.import_error_needs_scopes': 'Er is geen toegang tot vergaderingen verleend. Koppel je account opnieuw om die toe te voegen.',
    'meetings.import_error_no_recording': 'Deze vergadering heeft geen opname of transcript.',
    'meetings.import_error_not_connected': 'Je account is niet meer gekoppeld. Koppel het opnieuw en probeer het nog eens.',
    'meetings.import_error_not_organizer': 'Alleen de organisator van een vergadering kan die importeren.',
    'meetings.import_error_provider_not_allowed': 'Die transcriptie-engine is niet ingeschakeld voor deze werkruimte.',
    'meetings.import_error_timeout': 'De import duurde te lang. Bekijk de vergadernotities later, of probeer het opnieuw.',
    'meetings.import_error_too_large': 'De opname is te groot om te importeren.',
    // 2026-11: Teams failures with their own cause. Only missing keys are filled, so a re-run keeps own wording.
    'meetings.import_error_access_policy': 'Het Teams-toepassingstoegangsbeleid van je organisatie staat Bee Flow niet toe voor dit account.',
    'meetings.import_error_calendar_forbidden': 'Microsoft weigert de toegang tot je agenda.',
    'meetings.import_error_download_failed': 'De opname kon niet bij Microsoft worden gedownload. Probeer het opnieuw.',
    'meetings.import_error_graph_forbidden': 'Microsoft weigert de toegang tot deze vergadering. Een recht, licentie of Teams-beleid houdt het tegen. Je beheerder kan de Teams-test uitvoeren.',
    'meetings.import_error_graph_unavailable': 'Microsoft Graph gaf geen goed antwoord. Probeer het over een paar minuten opnieuw.',
    'meetings.import_error_meeting_not_available': 'Microsoft heeft geen onlinevergadering bij deze agenda-afspraak. Mogelijk is die verlopen.',
    'meetings.import_error_speaker_attribution_off': 'Je Teams-beheerder staat geen sprekersnamen in transcripten toe, dus dit transcript kan niet worden geïmporteerd. Een opname zou wel werken.',
    'meetings.import_error_throttled': 'Microsoft beperkt op dit moment het aantal verzoeken. Probeer het over een paar minuten opnieuw.',
    'meetings.import_error_too_many': 'Er lopen te veel imports. Wacht tot er een klaar is.',
    'meetings.import_error_transcript_api_off': 'Je Teams-beheerder heeft de API-toegang tot vergadertranscripten uitgezet.',
    'meetings.import_running': 'De vergadering wordt geïmporteerd. Dit kan enkele minuten duren…',
});

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
function applyNl(merged) {
    let added = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    return { merged, added };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    await languageStore.mutateGUITranslations('nl', (current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-meeting-import-translations-2026-10 applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
