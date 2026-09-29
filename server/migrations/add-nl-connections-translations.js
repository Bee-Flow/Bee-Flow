#!/usr/bin/env node
/**
 * Migration: Dutch translations for Settings → Verbindingen.
 *
 * The named-connections panel (ConnectionsManager.jsx) and the Nextcloud / MCP
 * cards shipped with hardcoded English, so a Dutch user saw an English
 * "CONNECTIONS / Add a connection / Set default" block inside an otherwise
 * Dutch settings page. The components now go through t(); these are the NL
 * values behind those keys.
 *
 * Idempotent — only inserts keys that don't already have a NL value.
 *
 * Manual usage (NOT part of npm run db:migrate):
 *   node server/migrations/add-nl-connections-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Connections panel ──
    'connections.title': 'Verbindingen',
    'connections.description': 'Bewaar meerdere benoemde inloggegevens per integratie en leen er één uit aan collega\'s. Ontvangers zonder geleende verbinding gebruiken hun eigen gegevens.',
    'connections.loading': 'Laden…',
    'connections.empty': 'Nog geen benoemde verbindingen.',
    'connections.load_failed': 'Kan je verbindingen niet laden',
    'connections.retry': 'Opnieuw proberen',
    'connections.add': 'Verbinding toevoegen',
    'connections.create': 'Verbinding aanmaken',
    'connections.create_failed': 'Aanmaken mislukt',
    'connections.cancel': 'Annuleren',
    'connections.save': 'Opslaan',
    'connections.rename': 'Hernoemen',
    'connections.rename_failed': 'Kan deze verbinding niet hernoemen',
    'connections.delete': 'Verwijderen',
    'connections.delete_failed': 'Kan deze verbinding niet verwijderen',
    'connections.confirm_delete': 'Deze verbinding verwijderen? Automatiseringen die hem gebruiken werken daarna niet meer.',
    'connections.confirm_delete_shared': 'Deze verbinding is gedeeld. Toch verwijderen en alle deelrechten intrekken?',
    'connections.default': 'Standaard',
    'connections.set_default': 'Als standaard instellen',
    'connections.set_default_failed': 'Kan dit niet als standaard instellen',
    'connections.share': 'Delen',
    'connections.share_count': '{count} gedeeld',
    'connections.share_failed': 'Delen mislukt',
    'connections.revoke': 'Intrekken',
    'connections.revoke_failed': 'Kan dit delen niet intrekken',
    'connections.lend_explainer': 'Uitlenen deelt deze verbinding met volledige delegatie — de runs van de ontvanger gebruiken jouw inloggegevens.',
    'connections.lend_http_warning': 'Delen leent de volledige inloggegevens uit — ontvangers kunnen er elke URL mee aanroepen.',
    'connections.lend_to_teammate': 'Uitlenen aan collega',
    'connections.lend_to_org': 'Uitlenen aan iedereen in mijn organisatie',
    'connections.teammate_email_placeholder': 'collega@bedrijf.nl',
    'connections.teammate_email_label': 'E-mailadres collega',
    'connections.grantee_org': 'Iedereen in organisatie',
    'connections.grantee_group': 'Groep',
    'connections.grantee_user': 'Gebruiker',
    'connections.expires_on': 'verloopt',
    'connections.expiry_label': 'Vervaldatum',
    'connections.expiry_none': 'Geen vervaldatum',
    'connections.expiry_7d': '7 dagen',
    'connections.expiry_30d': '30 dagen',
    'connections.expiry_90d': '90 dagen',
    'connections.provider_label': 'Aanbieder',
    'connections.auth_type_label': 'Authenticatietype',
    'connections.name_label': 'Naam verbinding',
    'connections.name_placeholder': 'Naam (bijv. "{provider} – Werk")',
    'connections.fill_required': 'Vul alle verplichte velden in',
    'connections.fill_credentials': 'Vul de inloggegevens in',
    'connections.http_bearer': 'Bearer-token',
    'connections.http_api_key': 'API-sleutel (eigen header)',
    'connections.http_basic': 'Basic-authenticatie',
    'connections.http_oauth2_cc': 'OAuth2 (client credentials)',
    'connections.field_token': 'Token',
    'connections.field_header_name': 'Headernaam (bijv. X-API-Key)',
    'connections.field_key_value': 'Sleutelwaarde',
    'connections.field_username': 'Gebruikersnaam',
    'connections.field_password': 'Wachtwoord',
    'connections.field_token_url': 'Token-URL',
    'connections.field_client_id': 'Client-ID',
    'connections.field_client_secret': 'Client secret',
    'connections.field_scopes': 'Scopes (gescheiden door spaties, optioneel)',
    'connections.field_api_key': 'API-sleutel',
    'connections.field_api_token': 'API-token',
    'connections.field_pat': 'Persoonlijk toegangstoken',
    'connections.field_instance_url': 'URL van de omgeving',
    'connections.field_permanent_token': 'Permanent token',
    'connections.field_subdomain': 'Subdomein',
    'connections.field_member_number': 'Lidnummer (cijfers, bijv. 12345)',
    'connections.field_afas_token': 'AppConnector-token (XML of code)',
    'connections.field_afas_env': 'Omgeving (productie / test / accept)',
    'connections.field_nmbrs_mode': 'API (soap / rest)',
    'connections.field_nmbrs_subdomain': 'Subdomein (bijv. mijnbedrijf)',
    'connections.field_nmbrs_email': 'Login-e-mailadres (alleen SOAP)',
    'connections.field_nmbrs_env': 'Omgeving (productie / sandbox)',

    // ── Nextcloud + MCP cards ──
    'integ.nextcloud_desc': 'Verbind Nextcloud voor bestands- en WebDAV-toegang in chat',
    'integ.nextcloud_connected': 'App-wachtwoord opgeslagen — bestanden & WebDAV beschikbaar voor agents',
    'integ.nextcloud_connector': 'Verbonden via de Bee Flow Nextcloud-connector — bestanden, agenda, mail en meer werken in chat zonder extra instellingen.',
    'integ.nextcloud_url_placeholder': 'Nextcloud-URL (bijv. https://cloud.voorbeeld.nl)',
    'integ.nextcloud_username_placeholder': 'Nextcloud-gebruikersnaam',
    'integ.nextcloud_password_placeholder': 'App-wachtwoord',
    'integ.nextcloud_hint': 'Aanmaken via Nextcloud → Instellingen → Beveiliging → Apparaten & sessies.',
    'integ.nextcloud_autocreate': 'Automatisch aanmaken vanuit OAuth-sessie (kortlopend)',
    'integ.nextcloud_autocreate_failed': 'Aanmaken van app-wachtwoord mislukt',
    'integ.mcp_enter_credential': 'Voer {label} in',
    'integ.mcp_configured': '✓ Ingesteld',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-connections-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
