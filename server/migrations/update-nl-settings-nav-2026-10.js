#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the settings menu clean-up (Oct 2026).
 *
 * The settings screens were regrouped and relabelled, and copy that sends
 * people to a settings page now names the page that exists:
 *   - "Instellingen → Integraties" becomes "Instellingen → Koppelingen": the
 *     personal page where you connect your own accounts is called Koppelingen
 *     (Connections); "Integraties" is the organisation page.
 *   - "Organisatie-instellingen → ..." becomes "Instellingen → Organisatie → ...",
 *     the path the menu actually has.
 *   - The organisation row "Context in lange gesprekken" also holds memory, AI
 *     in team chats and co-editing, so it is called "AI & samenwerking".
 *   - The sidebar header above the personal rows is "Persoonlijk".
 *   - The personal page itself is "Koppelingen" everywhere. Workspaces that
 *     date from before the public history still carry the page's older Dutch
 *     name "Verbindingen" (see the header of add-nl-connections-translations),
 *     which no longer matched the copy that points to the page, and now
 *     collides with the "Benoemde verbindingen" block on it.
 *
 * Two kinds of key:
 *   NL_TRANSLATIONS  keys with no shipped Dutch yet; written when a workspace
 *                    does not have them, so a workspace's own wording is kept.
 *   NL_REWORDED      keys whose English changed; replaced only while the
 *                    workspace still has one of the OLD shipped Dutch texts
 *                    (`was`, every variant an earlier catalogue shipped), so an
 *                    admin's own wording stays.
 *
 * Idempotent. Auto-runs from server boot (boot/bootMigrations.js), after the
 * catalogues whose Dutch it rewords. Manual:
 *   node server/migrations/update-nl-settings-nav-2026-10.js
 */

const NL_TRANSLATIONS = Object.freeze({
    "settings.personal_section": "Persoonlijk",
    "common.refresh": "Vernieuwen",
    "settings.integrations.afas_link": "App connector & token aanmaken",
    "settings.integrations.nmbrs_link": "API-token aanmaken",
    "settings.role_admin": "Beheerder",
    "org.checkout_cancelled": "Afrekenen is geannuleerd. Er is niets gewijzigd.",
    "org.subscription_activated": "Abonnement geactiveerd!",
    "org.activation_delayed": "Betaling ontvangen, maar het activeren duurt langer dan verwacht. Vernieuw de pagina over een minuut of mail naar info@beeflow.nl.",
    "org.checkout_failed": "Afrekenen starten mislukt",
    "org.payment_service_unreachable": "Geen verbinding met de betaaldienst",
    "org.change_preview_failed": "Kon deze wijziging niet vooraf berekenen",
    "org.change_card_declined": "Je kaart is geweigerd. Werk je betaalmethode bij via \"Facturatie beheren\".",
    "org.change_interval_mismatch": "Overstappen tussen maandelijkse en jaarlijkse facturering kan hier niet. Neem contact op met info@beeflow.nl.",
    "org.change_failed": "Abonnement wijzigen mislukt",
    "org.cancel_downgrade_failed": "Kon de geplande wijziging niet annuleren",
    "org.cancel_failed": "Opzeggen mislukt",
    "org.reactivate_failed": "Heractiveren mislukt",
    "org.reactivated_msg": "Je abonnement loopt door.",
    "org.billing_portal_failed": "Facturatieportaal openen mislukt",
    "org.billing_portal_unreachable": "Geen verbinding met het facturatieportaal",
    "org.logo_uploaded": "Logo geüpload",
    "org.logo_upload_failed": "Logo uploaden mislukt",
    "org.logo_removed": "Logo verwijderd",
    "org.logo_remove_failed": "Logo verwijderen mislukt",
    "org.custom_plan": "Maatwerk",
    "org.domain_invalid": "Ongeldig domeinformaat: \"{domain}\"",
    "org.domain_duplicate": "Domein \"{domain}\" is al toegevoegd",
    "org.add_domain_placeholder": "Domein toevoegen...",
    "org.add_domain": "Domein toevoegen",
    "org.remove_domain": "{domain} verwijderen",
    "settings.integrations.signrequest_subdomain_placeholder": "jouw-team (team-subdomein)",
    "settings.consumer_privacy.enable_desc": "Schakel privacybescherming in voor je account",
    "settings.n8n.tab_connection": "Koppeling",
    "settings.n8n.tab_permissions": "Rechten",
    "settings.n8n.status_connected_one": "Verbonden · 1 actieve webhook-workflow",
    "settings.n8n.status_connected_many": "Verbonden · {count} actieve webhook-workflows",
    "settings.n8n.status_failed": "Koppeling mislukt",
    "settings.n8n.status_configured": "Ingesteld — klik op Testen om te controleren",
    "settings.n8n.status_not_configured": "Niet ingesteld",
    "settings.n8n.save_connection": "Koppeling opslaan",
    "settings.n8n.test_connection": "Koppeling testen",
    "settings.n8n.testing": "Testen...",
    "org.integ_access_subtitle": "Geef een integratie aan je hele organisatie of aan een specifieke groep. Dit zijn de integraties die je abonnement bevat.",
});

/** English changed; `was` lists the Dutch that shipped for the old English, `now` the Dutch for the new. */
const NL_REWORDED = Object.freeze({
    "automations.trigger_editors.no_event_sources_are_available_to": {
        was: ["Er zijn nog geen gebeurtenisbronnen voor je beschikbaar. Koppel eerst een app (bijvoorbeeld Gmail of Nextcloud) via Instellingen → Integraties."],
        now: "Er zijn nog geen gebeurtenisbronnen voor je beschikbaar. Koppel eerst een app (bijvoorbeeld Gmail of Nextcloud) via Instellingen → Koppelingen.",
    },
    "connections.required_settings_link": {
        was: ["Instellingen → Integraties"],
        now: "Instellingen → Koppelingen",
    },
    "integ.git_hub_sync_connect_your_github_account_in": {
        was: ["Koppel eerst je GitHub-account via Instellingen → Integraties en kom daarna hier terug om synchronisatie in te stellen."],
        now: "Koppel eerst je GitHub-account via Instellingen → Koppelingen en kom daarna hier terug om synchronisatie in te stellen.",
    },
    "integ.services_set_linkedin_api_credentials_users_can": {
        was: ["Stel LinkedIn API-gegevens in. Gebruikers kunnen daarna hun LinkedIn-accounts koppelen via Instellingen → Integraties."],
        now: "Stel LinkedIn API-gegevens in. Gebruikers kunnen daarna hun LinkedIn-accounts koppelen via Instellingen → Koppelingen.",
    },
    "integ.services_set_withings_api_credentials_users_can": {
        was: ["Stel Withings API-gegevens in. Gebruikers kunnen daarna hun Health Mate-accounts koppelen via Instellingen → Integraties."],
        now: "Stel Withings API-gegevens in. Gebruikers kunnen daarna hun Health Mate-accounts koppelen via Instellingen → Koppelingen.",
    },
    "learn.cowork-run-as-agent.wrong.body": {
        was: ["Een gekoppeld item heeft foutsituaties die een item met gewone prompt niet heeft, en ze komen allemaal op dezelfde manier naar boven: als een mislukte uitvoering met de reden op de bovenste rij van **Wat er gebeurde**.\n\n- **De agent is verwijderd.** Elk Cowork-item dat ernaar wijst, mislukt, met een foutmelding dat de gekoppelde agent niet meer bestaat.\n- **De agent is niet meer van jou.** Een uitvoering mag alleen een agent gebruiken die van jou is; als het eigenaarschap elders heen gaat, stopt dat.\n- **De functie is uitgezet voor de organisatie.** Al geplande agentuitvoeringen stoppen, en de fout noemt agentautomatiseringen als reden.\n- **Een koppeling is verlopen.** Het statuswoord wordt **Aanmelden vereist**, en elk item van jou dat die aanbieder kan raken, wordt gepauzeerd totdat je de koppeling opnieuw maakt onder Instellingen → Integraties. Met een gekoppelde agent kan de kapotte koppeling er een zijn waar de agent naar grijpt in plaats van een die je opdracht noemt.\n\nEen terugkerend item behoudt na elk van deze zijn reeks; alleen een eenmalig item zet zichzelf uit."],
        now: "Een gekoppeld item heeft foutsituaties die een item met gewone prompt niet heeft, en ze komen allemaal op dezelfde manier naar boven: als een mislukte uitvoering met de reden op de bovenste rij van **Wat er gebeurde**.\n\n- **De agent is verwijderd.** Elk Cowork-item dat ernaar wijst, mislukt, met een foutmelding dat de gekoppelde agent niet meer bestaat.\n- **De agent is niet meer van jou.** Een uitvoering mag alleen een agent gebruiken die van jou is; als het eigenaarschap elders heen gaat, stopt dat.\n- **De functie is uitgezet voor de organisatie.** Al geplande agentuitvoeringen stoppen, en de fout noemt agentautomatiseringen als reden.\n- **Een koppeling is verlopen.** Het statuswoord wordt **Aanmelden vereist**, en elk item van jou dat die aanbieder kan raken, wordt gepauzeerd totdat je de koppeling opnieuw maakt onder Instellingen → Koppelingen. Met een gekoppelde agent kan de kapotte koppeling er een zijn waar de agent naar grijpt in plaats van een die je opdracht noemt.\n\nEen terugkerend item behoudt na elk van deze zijn reeks; alleen een eenmalig item zet zichzelf uit.",
    },
    "meetings.upcoming_settings_integrations": {
        was: ["Instellingen → Integraties"],
        now: "Instellingen → Koppelingen",
    },
    "solutions.install_grant_not_connected": {
        was: ["Niet gekoppeld aan jouw account — koppel hem in Instellingen → Integraties en ken hem daarna op de pagina toe.", "Niet gekoppeld aan je account. Koppel hem in Instellingen → Integraties en geef hem daarna toe op de webpagina."],
        now: "Niet gekoppeld aan je account. Koppel hem in Instellingen → Koppelingen en ken hem daarna toe op de webpagina.",
    },
    "studio_apps_bi.connectors.shared_outlook_note": {
        was: ["Je Microsoft-beheerder moet je toegang tot deze mailbox hebben gegeven en de koppeling heeft de machtiging voor gedeelde mailboxen nodig (koppel Microsoft opnieuw via Instellingen → Integraties als dat niet zo is)."],
        now: "Je Microsoft-beheerder moet je toegang tot deze mailbox hebben gegeven en de koppeling heeft de machtiging voor gedeelde mailboxen nodig (koppel Microsoft opnieuw via Instellingen → Koppelingen als dat niet zo is).",
    },
    "studio_apps_bi.connectors.test_connect_first": {
        was: ["Koppel eerst {app} aan je account (Instellingen → Integraties) en test dan opnieuw."],
        now: "Koppel eerst {app} aan je account (Instellingen → Koppelingen) en test dan opnieuw.",
    },
    "studio_apps_bi.picker.none_connected": {
        was: ["Er zijn nog geen apps aan je account gekoppeld. Koppel er een via Instellingen → Integraties."],
        now: "Er zijn nog geen apps aan je account gekoppeld. Koppel er een via Instellingen → Koppelingen.",
    },
    "studio_apps_bi.sync.err_connect": {
        was: ["Koppel eerst {app} aan je account (Instellingen → Integraties) en probeer het dan opnieuw."],
        now: "Koppel eerst {app} aan je account (Instellingen → Koppelingen) en probeer het dan opnieuw.",
    },
    "studio_apps_runtime.connector.not_connected": {
        was: ["Niet gekoppeld. Koppel {provider} onder Instellingen → Integraties en dit vult zichzelf."],
        now: "Niet gekoppeld. Koppel {provider} onder Instellingen → Koppelingen en dit vult zichzelf.",
    },
    "tests_studio.missing_github": {
        was: ["Koppel GitHub via Instellingen → Integraties om GitHub-bronnen te gebruiken."],
        now: "Koppel GitHub via Instellingen → Koppelingen om GitHub-bronnen te gebruiken.",
    },
    "tests_studio.missing_youtrack": {
        was: ["Koppel YouTrack via Instellingen → Integraties om YouTrack-bronnen te gebruiken."],
        now: "Koppel YouTrack via Instellingen → Koppelingen om YouTrack-bronnen te gebruiken.",
    },
    "webpages.apps.connect_in_settings": {
        was: ["Koppel hem via Instellingen → Integraties"],
        now: "Koppel hem via Instellingen → Koppelingen",
    },
    "signup.privacy_tune_later": {
        was: ["Je kunt deze instellingen later verfijnen in Organisatie-instellingen → Privacy Shield."],
        now: "Je kunt deze instellingen later verfijnen in Instellingen → Organisatie → Privacy Shield.",
    },
    "signup.privacy_tune_later_personal": {
        was: ["Je kunt deze instellingen later verfijnen in Instellingen → Privacy."],
        now: "Je kunt deze instellingen later verfijnen in Instellingen → Account → Privacy Shield.",
    },
    "support.access.no_groups": {
        was: ["Je organisatie heeft nog geen groepen. Maak groepen aan via Organisatie-instellingen → Gebruikers."],
        now: "Je organisatie heeft nog geen groepen. Maak groepen aan via Instellingen → Organisatie → Gebruikers & groepen.",
    },
    "settings.ai_context": {
        was: ["Context in lange gesprekken"],
        now: "AI & samenwerking",
    },
    "learn.connecting-integrations.named.body": {
        was: ["Boven die rijen staat een blok dat ook **Koppelingen** heet: *“Bewaar meerdere benoemde inloggegevens per integratie en leen een specifieke aan teamgenoten uit.”*\n\n**Verbinding toevoegen** vraagt om een aanbieder — GitHub, YouTrack, Gamma, AFAS Profit, vPlan, NMBRS en nog een paar, plus *HTTP API (aangepast)* — daarna een naam en dezelfde velden voor inloggegevens. Geef hem een naam die je over drie maanden nog herkent, zoals “YouTrack – Inkoop”, want daarna is de naam alles wat je ziet.\n\nWaarom de moeite, als de rij hieronder al werkt? Twee redenen: je kunt meer dan één inlogset voor dezelfde aanbieder hebben, en alleen een benoemde koppeling kan aan een collega worden uitgeleend.\n\nDe eerste die je voor een aanbieder maakt wordt automatisch de **Standaard**, en de Standaard is degene waar een uitvoering naar grijpt; met **Als standaard instellen** verplaats je de ster naar een andere rij.\n\nHoe dan ook is het geheim versleuteld en komt het nooit meer naar buiten: het scherm vertelt je alleen dat een veld is ingevuld."],
        now: "Boven die rijen staat een blok dat **Benoemde verbindingen** heet: *“Bewaar meerdere benoemde inloggegevens per integratie en leen een specifieke aan teamgenoten uit.”*\n\n**Verbinding toevoegen** vraagt om een aanbieder — GitHub, YouTrack, Gamma, AFAS Profit, vPlan, NMBRS en nog een paar, plus *HTTP API (aangepast)* — daarna een naam en dezelfde velden voor inloggegevens. Geef hem een naam die je over drie maanden nog herkent, zoals “YouTrack – Inkoop”, want daarna is de naam alles wat je ziet.\n\nWaarom de moeite, als de rij hieronder al werkt? Twee redenen: je kunt meer dan één inlogset voor dezelfde aanbieder hebben, en alleen een benoemde verbinding kan aan een collega worden uitgeleend.\n\nDe eerste die je voor een aanbieder maakt wordt automatisch de **Standaard**, en de Standaard is degene waar een uitvoering naar grijpt; met **Als standaard instellen** verplaats je de ster naar een andere rij.\n\nHoe dan ook is het geheim versleuteld en komt het nooit meer naar buiten: het scherm vertelt je alleen dat een veld is ingevuld.",
    },
    "connections.title": {
        was: ["Verbindingen"],
        now: "Benoemde verbindingen",
    },
    "settings.connections": {
        was: ["Verbindingen"],
        now: "Koppelingen",
    },
    "compliance.conn_connection_hint": {
        was: ["Maak eerst een koppeling \"{provider}\" aan bij Integraties. Het secret blijft in de versleutelde kluis."],
        now: "Maak eerst een verbinding \"{provider}\" aan in Instellingen → Koppelingen. Het secret blijft in de versleutelde kluis.",
    },
});

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {{ [x: string]: string; }} merged
 */
function applyNl(merged) {
    let added = 0;
    let reworded = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        // Missing -> write the current text; present and still an old shipped
        // text -> replace; anything else is the workspace's own wording and stays.
        if (!merged[key] || was.includes(merged[key])) {
            if (merged[key] !== now) reworded++;
            merged[key] = now;
        }
    }
    return { merged, added, reworded };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    let reworded = 0;
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        added = result.added;
        reworded = result.reworded;
        return result.merged;
    });
    if (added > 0 || reworded > 0) {
        console.log(`[Migration] update-nl-settings-nav-2026-10 applied (+${added} keys, ${reworded} reworded)`);
    }
    return { added, reworded };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, NL_REWORDED };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
