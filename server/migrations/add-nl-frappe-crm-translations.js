#!/usr/bin/env node
// @typecheck strict
/**
 * Migration: Dutch translations for the Frappe CRM integration card.
 *
 * The Frappe CRM connect card in Settings > Integrations (and its row in the
 * named connections panel) ships English defaults; these are the NL values
 * behind those keys, so a Dutch user does not get an English block in an
 * otherwise Dutch settings page.
 *
 * Idempotent: only inserts keys that don't already have a NL value.
 *
 * Manual usage (NOT part of npm run db:migrate):
 *   node server/migrations/add-nl-frappe-crm-translations.js
 */

const NL_TRANSLATIONS = {
    'integ.frappe_crm_connected': 'AI kan je Frappe CRM lezen en bijwerken',
    'integ.frappe_crm_desc': 'Verbind om AI leads, deals, contactpersonen, taken en notities in Frappe CRM te laten lezen en bijwerken',
    'integ.frappe_crm_step1': 'Open in Frappe de gebruiker namens wie Bee Flow werkt (een aparte API-gebruiker wordt aanbevolen), ga naar Settings en kies API Access, daarna Generate Keys.',
    'integ.frappe_crm_step2': 'Kopieer de API-sleutel en het API-geheim. Frappe toont het geheim maar één keer.',
    'integ.frappe_crm_step3': 'Vul hieronder het adres van je site in (Frappe Cloud of je eigen server), met de sleutel en het geheim.',
    'integ.frappe_crm_url_label': 'Siteadres',
    'integ.frappe_crm_url_placeholder': 'https://jouwbedrijf.frappe.cloud',
    'integ.frappe_crm_key_label': 'API-sleutel',
    'integ.frappe_crm_key_placeholder': 'API-sleutel',
    'integ.frappe_crm_secret_label': 'API-geheim',
    'integ.frappe_crm_secret_placeholder': 'API-geheim',
    'integ.frappe_crm_test': 'Verbinding testen',
    'integ.frappe_crm_test_ok': 'Verbonden als {user}',
    'integ.frappe_crm_test_failed': 'Verbinding mislukt',
    'integ.frappe_crm_need_all': 'Vul het siteadres, de API-sleutel en het API-geheim in om te verbinden.',
    'integ.frappe_crm_scope_note': 'Bee Flow werkt als deze Frappe-gebruiker: het ziet en wijzigt alleen wat die gebruiker mag, en verwijdert nooit records.',
    'integ.frappe_crm_help': 'Hulp bij Frappe:',
    'integ.frappe_crm_link': 'API-sleutels in Frappe',
    'connections.field_frappe_crm_url': 'Siteadres',
    'connections.field_frappe_crm_api_key': 'API-sleutel',
    'connections.field_frappe_crm_api_secret': 'API-geheim',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-frappe-crm-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
