#!/usr/bin/env node
/**
 * One-time migration: Dutch translations for the personal-account Privacy
 * Shield surfaces added for BFSF-289 — the privacy step in the consumer signup
 * wizard and the guard-status / secure-default labels in the personal Privacy
 * settings panel.
 *
 * Merges into the existing i18n_gui_nl config without overwriting any
 * translations that already exist. Idempotent — safe to re-run. Auto-runs from
 * server boot (server/index.js). Manual usage:
 *   node server/migrations/add-nl-personal-privacy-shield-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Signup wizard: privacystap voor persoonlijke accounts ──
    'signup.shield_enable_desc_personal': 'Scan je berichten op persoonsgegevens en vervang deze voordat ze de AI bereiken. Aanbevolen — je kunt dit later aanpassen in de instellingen.',
    'signup.privacy_tune_later_personal': 'Je kunt deze instellingen later verfijnen in Instellingen → Privacy.',
    'pii.action_block_help_personal': 'Weiger het bericht voordat het je apparaat verlaat. Je wordt gevraagd het te herformuleren zonder gevoelige gegevens.',

    // ── Persoonlijk Privacy-paneel: standaardwaarden & guard-status ──
    'privacy.implicit_default_badge': 'Standaard actief',
    'privacy.implicit_default_note': 'Deze instellingen gelden nu al met de veilige standaardwaarden. Sla op om ze vast te leggen.',
    'privacy.guard_status_unavailable': 'PII-detectie niet beschikbaar',
    'privacy.guard_status_unavailable_desc': 'De PII Guard-service is niet geconfigureerd op deze server. Je Privacy Shield-instellingen zijn opgeslagen maar er wordt niets gedetecteerd. Neem contact op met je beheerder.',

    // ── Transparantiepaneel ──
    'privacy.scanned_no_findings': 'Gescand op persoonsgegevens — niets gevonden.',
    'privacy.badge_scanned': 'gescand',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-personal-privacy-shield-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
