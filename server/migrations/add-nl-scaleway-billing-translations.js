#!/usr/bin/env node
/**
 * Dutch for the Scaleway Billing integration (2026-10-06): the connect card in
 * Settings → Integrations (what it does, the four setup steps, the two fields)
 * and its row in the named connections panel.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-scaleway-billing-translations.js
 */

const NL_TRANSLATIONS = {
    'integ.scaleway_billing_connected': 'Automatiseringen kunnen je Scaleway-facturen ophalen',
    'integ.scaleway_billing_desc': 'Verbind om in automatiseringen Scaleway-facturen (PDF) op te halen en ze in Nextcloud of Google Drive op te slaan',
    'integ.scaleway_billing_step1': 'Open in de Scaleway-console Identity and Access Management (IAM) en maak een applicatie aan, bijvoorbeeld "Bee Flow facturen".',
    'integ.scaleway_billing_step2': 'Geef die applicatie een policy met de permission set BillingReadOnly, voor de hele Organization.',
    'integ.scaleway_billing_step3': 'Maak een API-sleutel voor de applicatie aan en kopieer de secret key. Scaleway toont die maar één keer.',
    'integ.scaleway_billing_step4': 'Plak hieronder de secret key. Het Organization ID is optioneel; je vindt het onder Organization settings. Bee Flow leest alleen facturen en wijzigt nooit iets.',
    'integ.scaleway_billing_key_placeholder': 'Secret key (een UUID)',
    'integ.scaleway_billing_org_placeholder': 'Organization ID (optioneel)',
};

// Scaleway's own console names, which the Dutch console keeps in English too.
const SAME_AS_ENGLISH = [
    'integ.scaleway_billing_key_label',
    'integ.scaleway_billing_org_label',
    'connections.field_scaleway_billing_key',
    'connections.field_scaleway_billing_org',
];

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-scaleway-billing-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-scaleway-billing-translations failed:', e.message);
        process.exit(1);
    });
}
