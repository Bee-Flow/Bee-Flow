'use strict';
const NL_TRANSLATIONS = {
    'azure.identity_admin_title': 'Microsoft-identiteiten en directorysynchronisatie',
    'azure.identity_admin_help': 'Controleer de persoon en diens tenant voordat je een identiteit koppelt. Alleen hetzelfde e-mailadres is onvoldoende.',
    'azure.identity_local_user': 'Lokaal gebruikers-ID',
    'azure.identity_confirm': 'Identiteitskoppeling bevestigen',
    'azure.sync_target_organization': 'Organisatie-ID voor directorysynchronisatie',
    'azure.sync_target_tenant': 'Tenant-GUID voor directorysynchronisatie',
    'azure.sync_confirm_binding': 'Directorykoppeling opslaan',
    'azure.identity_disconnect_user': 'Microsoft-identiteit ontkoppelen voor lokaal gebruikers-ID',
    'azure.identity_disconnect_confirm': 'Ik bevestig dat dit account de huidige Microsoft-identiteit niet meer mag accepteren.',
    'azure.identity_disconnect': 'Identiteit ontkoppelen',
    'login.sso_link_required': 'Een platformbeheerder moet je Microsoft-identiteit aan je bestaande account koppelen. Er is geen nieuw account aangemaakt.',
};
async function up() {
    return require('../stores/languageStore').addMissingGUITranslations('nl', NL_TRANSLATIONS);
}
module.exports = { up };
