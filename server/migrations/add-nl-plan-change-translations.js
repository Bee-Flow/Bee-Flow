#!/usr/bin/env node
/**
 * One-time migration: Dutch translations for the production subscription work —
 * in-app plan change (upgrade/downgrade with cost preview), the scheduled-
 * downgrade banner, the free→paid checkout section, the context-aware
 * "Subscription & Usage" heading, the relocated usage-sharing toggle, and the
 * agent plan-limit warning.
 *
 * Auto-runs from server boot (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-plan-change-translations.js
 *
 * Merges into the existing i18n_gui_nl config without overwriting any
 * translations that already exist.
 */

const NL_TRANSLATIONS = {
    // ── Heading + usage (License/Subscription & Usage page) ──────
    'org.subscription_usage': 'Abonnement & Gebruik',
    'org.ai_usage': 'AI-verbruik',
    'org.ai_usage_of_cap': 'AI-verbruik van limiet deze periode',

    // ── Change plan (upgrade + downgrade) ────────────────────────
    'org.change_plan': 'Abonnement wijzigen',
    'org.change_plan_close': 'Sluiten',
    'org.change_plan_hint': 'Upgrades gaan direct in (naar rato). Downgrades gaan in aan het einde van uw huidige factureringsperiode.',
    'org.upgrade': 'Upgrade',
    'org.downgrade': 'Downgrade',
    'org.upgrade_button': 'Upgraden',

    // ── Change-plan confirmation modal ───────────────────────────
    'org.confirm_upgrade': 'Upgrade bevestigen',
    'org.confirm_downgrade': 'Downgrade bevestigen',
    'org.takes_effect': 'Gaat in op',
    'org.charge_today': 'Kosten vandaag',
    'org.prorated_charge_today': 'Kosten naar rato vandaag',
    'org.then': 'Daarna',
    'org.billed_per_seat': 'per seat gefactureerd',
    'org.cancel': 'Annuleren',
    'org.confirm': 'Bevestigen',

    // ── Cancel-subscription confirmation modal ───────────────────
    'org.cancel_confirm_body': 'Uw abonnement opzeggen aan het einde van de huidige factureringsperiode? U behoudt tot dan volledige toegang en er worden geen verdere betalingen gedaan.',
    'org.cancel_subscription_confirm': 'Abonnement opzeggen',
    'org.cancel_scheduled_msg': 'Opzegging gepland.',

    // ── Scheduled-downgrade banner ───────────────────────────────
    'org.downgrade_scheduled': 'Downgrade naar',
    'org.downgrade_scheduled_on': 'op',
    'org.a_lower_plan': 'een lager abonnement',
    'org.period_end': 'het einde van deze periode',
    'org.downgrade_keeps_access': 'U behoudt uw huidige abonnement tot dan.',
    'org.keep_current_plan': 'Huidig abonnement behouden',

    // ── Toast messages ───────────────────────────────────────────
    'org.upgrade_done_msg': 'Abonnement geüpgraded. Stripe heeft het verschil naar rato gefactureerd.',
    'org.downgrade_scheduled_msg': 'Downgrade gepland voor het einde van deze periode.',
    'org.downgrade_cancelled_msg': 'Geplande downgrade geannuleerd — u blijft op uw huidige abonnement.',

    // ── Free → paid checkout (non-Stripe org) ────────────────────
    'org.upgrade_to_paid': 'Upgraden naar een betaald abonnement',
    'org.upgrade_to_paid_hint': 'U zit op een gratis abonnement. Abonneer u voor meer gebruik en functies — u wordt naar de beveiligde Stripe-checkout geleid.',

    // ── Usage-sharing toggle (now on the License & Usage page) ───
    'org.share_usage': 'AI-gebruik delen',
    'org.share_usage_desc': 'Kies of uw team één AI-gebruiksbudget deelt, of dat elke gebruiker een eigen deel krijgt.',
    'org.share_usage_label': 'AI-gebruik delen binnen de organisatie',
    'org.share_usage_explainer': 'Wanneer ingeschakeld, delen alle gebruikers het kostenbudget van het abonnement. Wanneer uitgeschakeld, wordt het budget gelijkmatig verdeeld over actieve gebruikers, zodat elke gebruiker een eigen deel heeft voor de periode.',
    'org.share_usage_on': 'Gedeeld binnen de organisatie',
    'org.share_usage_off': 'Elke gebruiker heeft een eigen budget',

    // ── Usage page (customer breakdowns shown as %) ──────────────
    'usage.of_personal_cap': 'van persoonlijke limiet',

    // ── Agent builder plan-limit warning ─────────────────────────
    'agent_wizard.limit_reached_title': 'Abonnementslimiet bereikt',
    'agent_wizard.view_plans': 'Abonnementen bekijken & upgraden',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-plan-change-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-plan-change-translations failed:', e.message);
        process.exit(1);
    });
}
