#!/usr/bin/env node
/**
 * One-time migration: Add Dutch translations for the AI-usage sharing
 * toggle, the Change-plan picker, and the customer-view monitoring
 * breakdowns.
 *
 * Auto-runs from server boot (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-usage-sharing-translations.js
 *
 * Merges into the existing i18n_gui_nl config without overwriting
 * any translations that already exist.
 */

const NL_TRANSLATIONS = {
    // ── Organisatie-info: AI usage sharing toggle ──────────────
    'org.share_usage': 'AI-verbruik delen',
    'org.share_usage_desc': 'Kies of je team één AI-budget deelt, of dat elke gebruiker zijn eigen deel krijgt.',
    'org.share_usage_label': 'AI-verbruik delen binnen de organisatie',
    'org.share_usage_explainer': 'Aan: alle gebruikers delen het kostenbudget van het abonnement. Uit: het budget wordt gelijk verdeeld over actieve gebruikers — iedereen krijgt zijn eigen deel voor deze periode.',
    'org.share_usage_on': 'Gedeeld binnen de organisatie',
    'org.share_usage_off': 'Elke gebruiker heeft een eigen budget',

    // ── License & Usage: Change plan picker ─────────────────────
    'org.change_plan': 'Plan wijzigen',
    'org.change_plan_close': 'Sluiten',
    'org.change_plan_hint': 'Een planwijziging is direct van kracht. Stripe verrekent het verschil pro rata op je volgende factuur.',
    'org.switch_to': 'Overschakelen',

    // ── Gebruik & Monitoring: customer-view breakdowns ─────────
    'usage.top_users_by_cost': 'Topgebruikers op kosten',
    'usage.by_app_area': 'Per app-gebied',
    'usage.no_usage_recorded': 'Nog geen verbruik geregistreerd',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-usage-sharing-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-usage-sharing-translations failed:', e.message);
        process.exit(1);
    });
}
