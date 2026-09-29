#!/usr/bin/env node
/**
 * Migration: Dutch translations for the voice-profile (pyannoteAI voiceprint)
 * strings — personal enrollment UI + the Art. 9 biometric consent label.
 *
 * Idempotent — only inserts keys that don't already have a NL value.
 *
 * Manual usage (NOT part of npm run db:migrate):
 *   node server/migrations/add-nl-voiceprint-translations.js
 */

const NL_TRANSLATIONS = {
    'consent.voiceprint_label': 'Ik ga ermee akkoord dat er een stemprofiel (biometrische gegevens) van mijn stem wordt bewaard, zodat ik automatisch herkend kan worden in de vergadernotities van mijn organisatie. Als ik deze toestemming intrek, wordt het stemprofiel direct verwijderd.',

    'voiceprint.title': 'Stemprofiel',
    'voiceprint.desc': 'Neem je stem één keer op en je naam komt automatisch bij je eigen bijdragen te staan in vergaderingen die iemand in je organisatie opneemt. Alleen jij kunt je eigen stemprofiel opnemen.',
    'voiceprint.row_active': 'Je stemprofiel is actief',
    'voiceprint.row_none': 'Nog geen stemprofiel',
    'voiceprint.row_none_desc': 'Kost ongeveer een halve minuut: je leest een korte tekst hardop voor.',
    'voiceprint.recorded_on': 'Opgenomen op {date}',
    'voiceprint.recognised_recently': 'Onlangs herkend in een vergadering',
    'voiceprint.status_ready': 'Actief',
    'voiceprint.coverage_title': 'In jouw organisatie',
    'voiceprint.coverage': '{enrolled} van de {members} collega’s hebben een stemprofiel. Hoe meer er zijn, hoe beter sprekers worden herkend.',
    'voiceprint.record': 'Stemprofiel opnemen',
    'voiceprint.rerecord': 'Opnieuw opnemen',
    'voiceprint.delete': 'Verwijderen',
    'voiceprint.delete_confirm': 'Je stemprofiel verwijderen? Je naam wordt dan niet meer automatisch herkend.',
    'voiceprint.delete_confirm_yes': 'Verwijderen',
    'voiceprint.delete_confirm_no': 'Annuleren',
    'voiceprint.modal_title': 'Neem je stemprofiel op',
    'voiceprint.modal_desc': 'Lees de tekst hieronder hardop voor in je normale tempo. De opname stopt vanzelf.',
    'voiceprint.start': 'Opname starten',
    'voiceprint.stop': 'Opname stoppen',
    'voiceprint.discard': 'Weggooien',
    'voiceprint.cancel': 'Annuleren',
    'voiceprint.state_processing': 'Je stemprofiel wordt aangemaakt…',
    'voiceprint.hint_can_stop': 'Je mag nu stoppen',
    'voiceprint.hint_keep_reading': 'Lees rustig verder…',
    'voiceprint.hint_ready': 'Tik op de microfoon en begin met lezen',
    'voiceprint.consent_label': 'Ik ga ermee akkoord dat er een stemprofiel van mijn stem wordt aangemaakt en bewaard.',
    'voiceprint.consent_detail': 'Dit zijn biometrische gegevens. Ze worden alleen gebruikt om mij te herkennen in de vergadernotities van mijn eigen organisatie, de opname zelf wordt niet bewaard, en ik kan mijn stemprofiel op elk moment verwijderen.',
    'voiceprint.error_mic_denied': 'Toegang tot de microfoon is geweigerd. Sta dit toe in je browserinstellingen en probeer het opnieuw.',
    'voiceprint.error_mic': 'Kon de microfoon niet gebruiken.',
    'voiceprint.error_multiple_speakers': 'Er was meer dan één stem te horen. Neem opnieuw op op een rustige plek, waar alleen jij spreekt.',
    'voiceprint.error_too_short': 'De opname was te kort. Lees de hele tekst hardop voor en probeer het opnieuw.',
    'voiceprint.error_too_long': 'De opname was te lang. Probeer het opnieuw — de opname stopt vanzelf.',
    'voiceprint.error_too_quiet': 'Er was nauwelijks spraak te horen. Controleer je microfoon en lees de tekst hardop voor.',
    'voiceprint.error_voiceprint_too_large': 'Het stemprofiel kon niet worden opgeslagen. Probeer het opnieuw.',
    'voiceprint.error_not_configured': 'Stemprofielen zijn niet ingesteld op deze server. Vraag je beheerder.',
    'voiceprint.error_rate_limited': 'Te veel pogingen. Probeer het later opnieuw.',
    'voiceprint.error_timeout': 'Het aanmaken van het stemprofiel duurde te lang. Probeer het opnieuw.',
    'voiceprint.error_consent_required': 'Vink eerst de toestemming aan.',
    'voiceprint.error_undecryptable': 'Je stemprofiel kan niet meer gelezen worden. Neem het opnieuw op.',
    'voiceprint.error_enroll_failed': 'Het opnemen van je stemprofiel is mislukt. Probeer het opnieuw.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-voiceprint-translations applied (+${added} keys)`);
    }
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
