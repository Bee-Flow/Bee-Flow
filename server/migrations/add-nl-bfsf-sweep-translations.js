#!/usr/bin/env node
/**
 * Migration: Dutch translations for the BFSF bug-sweep UI keys (2026-07).
 *
 * One consolidated NL seed for the strings introduced/reworded by the
 * BFSF-243/271/274/255/270/267/263/254/272/250/251/241 fixes, so ops runs a
 * single script at deploy time instead of one per issue.
 *
 * Idempotent — NL_TRANSLATIONS only inserts keys that don't already have a
 * NL value; NL_FORCE overwrites (used only where the EN source string
 * changed meaning, e.g. billing.recurring_notice no longer says "monthly",
 * so a stale NL translation would be factually wrong next to yearly plans).
 *
 * Manual usage (NOT part of npm run db:migrate):
 *   node server/migrations/add-nl-bfsf-sweep-translations.js
 */

const NL_TRANSLATIONS = {
    // BFSF-243 — recurring-billing disclosure at the subscribe CTA
    'billing.recurring_badge': 'Doorlopend · automatische incasso',

    // BFSF-250 — in-app invoice list/viewer (was hardcoded English)
    'billing.invoices': 'Facturen',
    'billing.no_invoices': 'Nog geen facturen.',
    'billing.invoices_load_failed': 'Facturen konden niet worden geladen',
    'billing.status_paid': 'Betaald',
    'billing.status_open': 'Openstaand',
    'billing.status_uncollectible': 'Oninbaar',
    'billing.status_void': 'Vervallen',
    'billing.invoice': 'Factuur',
    'billing.download': 'Downloaden',
    'billing.invoice_pdf_failed': 'De factuur-PDF kon niet worden geladen. Probeer het opnieuw.',
    'billing.retry': 'Opnieuw proberen',

    // BFSF-271 — read-only agent editor for non-editable agents
    'agent_studio.view_only': 'Alleen bekijken',
    'agent_studio.read_only_banner': 'Alleen-lezen — je hebt geen rechten om deze agent te bewerken.',

    // BFSF-274 — 2FA hardening: structured errors, drift warning, regen with
    // recovery codes, admin reset, lockout hint, setup steps + AI helper
    'mfa.secret_unreadable': 'Je authenticator kan op deze server niet meer worden geverifieerd. Gebruik een herstelcode, of vraag je beheerder om tweefactorauthenticatie te resetten.',
    'mfa.too_many_attempts': 'Te veel pogingen — wacht een paar minuten en probeer het opnieuw.',
    'mfa.request_failed': 'Verzoek mislukt. Probeer het opnieuw.',
    'mfa.time_drift_warning': 'De klok van je apparaat wijkt ongeveer {n} seconden af van de server — authenticatorcodes kunnen worden geweigerd. Zet automatische tijd aan op je apparaat.',
    'mfa.codes_low_warning': 'Je herstelcodes raken op. Genereer een nieuwe set zolang je er nog één hebt om mee te bevestigen.',
    'mfa.confirm_with_code_or_recovery': 'Voer een 6-cijferige code of een herstelcode in om te bevestigen',
    'mfa.code_placeholder': '000000 of a1b2-c3d4',
    'mfa.locked_out_hint': 'Buitengesloten? Gebruik een herstelcode of vraag je organisatiebeheerder om tweefactorauthenticatie voor je account te resetten.',
    'mfa.setup_step1': 'Installeer een authenticator-app op je telefoon — bijvoorbeeld Google Authenticator, Microsoft Authenticator, 1Password of Bitwarden (elke TOTP-app werkt).',
    'mfa.setup_step2': 'Kies in de app “QR-code scannen” en scan de code hieronder.',
    'mfa.setup_step3': 'Voer de 6-cijferige code uit de app in om te bevestigen.',
    'mfa.help_open': 'Vragen? Vraag het de AI-assistent',
    'mfa.help_title': '2FA-hulp',
    'mfa.help_intro': 'Stel je vraag over het instellen van tweefactorauthenticatie. De assistent kan je QR-code, geheime sleutel en codes niet zien.',
    'mfa.help_placeholder': 'bijv. Welke app heb ik nodig?',
    'mfa.help_send': 'Versturen',
    'mfa.help_error': 'De assistent is nu niet beschikbaar. Probeer het later opnieuw.',
    'admin.reset_mfa': '2FA resetten',
    'admin.reset_mfa_confirm': 'Tweefactorauthenticatie resetten voor {name}? De authenticator en herstelcodes werken direct niet meer; bij de volgende aanmelding wordt om nieuwe inschrijving gevraagd.',
    'admin.reset_mfa_done': 'Tweefactorauthenticatie is gereset.',
    'admin.reset_mfa_not_enabled': 'Deze gebruiker heeft geen tweefactorauthenticatie ingeschakeld.',

    // BFSF-251 — seat management UX on the Licentie & gebruik page (these
    // keys shipped EN-only in 9d5f8a5c, so the Dutch UI showed English)
    'org.add_user': 'Gebruiker toevoegen',
    'org.add_user_hint': 'Een gebruiker uitnodigen voegt een seat toe aan je abonnement. Extra seats worden per gebruiker per maand gefactureerd en naar rato berekend voor de huidige periode.',
    'org.seats_proration_note': 'Stripe verrekent het verschil naar rato op je volgende factuur.',
    'org.on_highest_plan': 'Je zit op het hoogste abonnement.',
    'org.for_custom_pricing': 'Neem contact op voor maatwerkprijzen.',
    'org.activating_subscription': 'Abonnement activeren…',
    'org.activating_subscription_hint': 'De betaling wordt verwerkt. Dit duurt meestal een paar seconden.',
    'org.cancel_scheduled': 'Abonnement stopt op',
    'org.cancel_keeps_access': 'Je houdt toegang tot die datum.',
    'org.keep_subscription': 'Abonnement behouden',

    // BFSF-241 — Manage Billing button label (was hardcoded English on the
    // consumer page)
    'license.manage_billing': 'Facturatie beheren',

    // BFSF-272 — category management in the Agent Designer
    'agent_wizard.builder.category_manage': 'Categorieën beheren',
    'agent_wizard.builder.category_rename': 'Hernoemen',
    'agent_wizard.builder.category_delete_confirm_title': 'Categorie verwijderen?',
    'agent_wizard.builder.category_delete_confirm_body': '"{name}" verwijderen? Agents blijven werken; de categorie verdwijnt uit de lijst.',
    'agent_wizard.builder.category_in_use': 'In gebruik door {n} agent(s). Wat moet er met ze gebeuren?',
    'agent_wizard.builder.category_delete_unassign': 'De categorie van deze agents verwijderen',
    'agent_wizard.builder.category_delete_move_to': 'Verplaats ze naar',
    'agent_wizard.builder.category_exists_selected': 'Categorie bestaat al — geselecteerd.',

    // BFSF-270 — Agent Designer file upload works for drafts + explains itself
    'agent_wizard.files.draft_notice': 'Bestanden worden direct in een kennisbank opgeslagen — sla de agent op om ze gekoppeld te houden.',

    // BFSF-255 — Google Workspace connector tile
    'settings.integrations_google_workspace': 'Google Workspace',
    'integ.google_desc': 'Verbind Gmail, Agenda en Drive zodat AI-tools met je Google-account kunnen werken',
    'integ.google_connected': 'Verbonden — Gmail, Agenda en Drive werken in chat en automatiseringen',
    'integ.google_connected_as': 'Verbonden als {email} — Gmail, Agenda en Drive werken in chat en automatiseringen',
    'integ.google_needs_reauth': 'Je Google-verbinding is verlopen — verbind opnieuw zodat tools en automatiseringen blijven werken',
    'integ.google_connect': 'Google Workspace verbinden',
    'integ.google_reconnect': 'Opnieuw verbinden',
    'integ.google_opening': 'Google openen…',
    'integ.google_not_configured': 'Google Workspace is niet geconfigureerd. Vraag je beheerder de Google Client ID en Secret in te stellen bij Beheer → Authenticatie.',
    'integ.google_disconnect_note': 'Bij het verbreken worden automatiseringen die Gmail, Agenda of Drive gebruiken gepauzeerd totdat je opnieuw verbindt. Je blijft ingelogd.',
    'integ.google_error': 'De Google-verbinding kon niet worden gestart. Probeer het opnieuw.',

    // Drive-by: keys shipped by the 2026-07-15 autosave/conflict refactor
    // without dictionary entries (caught by i18nGuard during this sweep)
    'agent_wizard.builder.updating': 'Bijwerken…',
    'agent_wizard.builder.refine_parse_error': 'De assistent gaf een onleesbaar antwoord. Probeer het opnieuw.',
    'agent_wizard.conflict.title': 'Deze agent is elders gewijzigd',
    'agent_wizard.conflict.body': 'Iemand (of een ander tabblad) heeft deze agent opgeslagen sinds je hem opende. Kies hoe je verdergaat:',
    'agent_wizard.conflict.load_latest_hint': 'Laatste versie laden — neem de andere versie over. Je niet-opgeslagen wijzigingen in dit tabblad gaan verloren.',
    'agent_wizard.conflict.overwrite_hint': 'Mijn versie behouden — overschrijf met jouw versie.',
    'agent_wizard.conflict.load_latest': 'Laatste versie laden',
    'agent_wizard.conflict.overwrite': 'Mijn versie behouden',
    'sidebar.apps': 'Apps',
};

// Keys whose EN source was reworded in the same sweep — a pre-existing NL
// value would carry the OLD meaning, so these overwrite.
const NL_FORCE = {
    // BFSF-243 — dropped the hardcoded "monthly" (plans can be yearly)
    'billing.recurring_notice': 'Dit is een doorlopend abonnement. Je gekozen betaalmethode wordt aan het begin van elke factureringsperiode automatisch belast (automatische incasso) totdat je opzegt.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Eén atomaire bewerking (advisory lock over replica's heen): toevoegen én
    // de bewuste herformuleringen doordrukken samen.
    let added = 0;
    let forced = 0;
    await languageStore.mutateGUITranslations('nl', (merged) => {
        added = 0; forced = 0; // de mutator kan opnieuw draaien — tel per poging
        for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
            if (!merged[key]) {
                merged[key] = value;
                added++;
            }
        }
        for (const [key, value] of Object.entries(NL_FORCE)) {
            if (merged[key] !== value) {
                merged[key] = value;
                forced++;
            }
        }
        return merged;
    });
    if (added > 0 || forced > 0) {
        console.log(`[Migration] add-nl-bfsf-sweep-translations applied (+${added} keys, ${forced} reworded)`);
    }
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
