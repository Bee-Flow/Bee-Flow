#!/usr/bin/env node
/**
 * Migration: Dutch translations for the vPlan integration card.
 *
 * The vPlan connect card in Settings → Integrations (and its row in the named
 * connections panel) ships English defaults; these are the NL values behind
 * those keys, so a Dutch user does not get an English block in an otherwise
 * Dutch settings page.
 *
 * Idempotent — only inserts keys that don't already have a NL value.
 *
 * Manual usage (NOT part of npm run db:migrate):
 *   node server/migrations/add-nl-vplan-translations.js
 */

const NL_TRANSLATIONS = {
    'integ.vplan_connected': 'AI kan je vPlan-planning, capaciteit en urenregistratie lezen (alleen-lezen)',
    'integ.vplan_desc': 'Verbind om AI je vPlan-planning te laten lezen (alleen-lezen)',
    'integ.vplan_step1': 'Open in vPlan Instellingen → Developers en klik op het plusje naast API keys.',
    'integ.vplan_step2': 'Geef de sleutel een naam en sla op. vPlan toont daarna eenmalig zowel de API key als de API env — kopieer beide.',
    'integ.vplan_step3': 'Plak hieronder de omgeving en de sleutel. Bee Flow leest alleen uit vPlan en maakt of wijzigt er nooit iets.',
    'integ.vplan_env_label': 'API-omgeving',
    'integ.vplan_env_placeholder': 'API env uit vPlan',
    'integ.vplan_key_placeholder': 'API key uit vPlan',
    'integ.vplan_need_both': 'Vul zowel de API key als de API env in om te verbinden.',
    'connections.field_vplan_key': 'API-sleutel',
    'connections.field_vplan_env': 'API-omgeving',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-vplan-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
