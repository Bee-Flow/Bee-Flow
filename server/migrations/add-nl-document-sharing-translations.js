'use strict';

const NL_TRANSLATIONS = Object.freeze({
    'documents.sharing.title': '{name} delen',
    'documents.sharing.read_access': 'Ontvangers kunnen dit document lezen. Bestaande bewerkrechten via projecten blijven gelden.',
    'documents.sharing.loading': 'Deelinstellingen laden…',
    'documents.sharing.audience': 'Wie heeft toegang',
    'documents.sharing.private': 'Privé',
    'documents.sharing.organisation': 'Hele organisatie',
    'documents.sharing.restricted': 'Specifieke gebruikers en groepen',
    'documents.sharing.search': 'Gebruikers en groepen zoeken',
    'documents.sharing.loading_people': 'Gebruikers en groepen laden…',
    'documents.sharing.groups': 'Groepen',
    'documents.sharing.users': 'Gebruikers',
    'documents.sharing.unavailable': 'Niet beschikbaar ({id})',
    'documents.sharing.selected': 'Geselecteerd ({count})',
    'documents.sharing.clear_selection': 'Selectie wissen',
    'documents.sharing.more_selected': '+{count} meer',
    'documents.sharing.remove': '{name} verwijderen',
    'documents.sharing.recipient_type': 'Type ontvanger',
    'documents.sharing.result_range': '{from}–{to} van {count}',
    'documents.sharing.previous_page': 'Vorige pagina',
    'documents.sharing.next_page': 'Volgende pagina',
    'documents.sharing.no_results': 'Geen ontvangers gevonden.',
    'documents.sharing.no_selected_results': 'Geen geselecteerde ontvangers gevonden voor deze zoekopdracht.',
    'documents.sharing.choose_recipient': 'Selecteer minimaal één gebruiker of groep.',
    'documents.sharing.encryption': 'Als encryptie aanstaat, gebruikt gedeelde inhoud organisatie-encryptie zodat ontvangers het document kunnen openen.',
});

async function up({ languageStore = require('../stores/languageStore') } = {}) {
    return languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
}

module.exports = { up, NL_TRANSLATIONS };
