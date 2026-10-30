#!/usr/bin/env node
// @typecheck strict
/**
 * Migration: Dutch translations for the Firebird database integration card.
 *
 * The Firebird connect card in Settings → Integrations (and its row in the named
 * connections panel) ships English defaults; these are the NL values behind
 * those keys, so a Dutch user does not get an English block in an otherwise
 * Dutch settings page.
 *
 * Idempotent — only inserts keys that don't already have a NL value.
 *
 * Manual usage (NOT part of npm run db:migrate):
 *   node server/migrations/add-nl-firebird-translations.js
 */

const NL_TRANSLATIONS = {
    'integ.firebird_connected': 'AI kan je Firebird-database lezen (alleen SELECT)',
    'integ.firebird_desc': 'Verbind om AI een Firebird-database zoals Syntess Atrium te laten lezen (alleen SELECT)',
    'integ.firebird_step1': 'Bee Flow leest alleen (SELECT) in alleen-lezen transacties en schrijft nooit. Een alleen-lezen databaseaccount wordt aanbevolen; gebruik je eigen account, niet SYSDBA.',
    'integ.firebird_step2': 'Vul de naam of het adres in van de server waarop Firebird draait, en de database zoals die server hem kent (een alias of een bestandspad).',
    'integ.firebird_step3': 'Typisch gebruik: Syntess Atrium. Zie je vreemde tekens in teksten, probeer dan een andere tekenset zoals WIN1252 of NONE.',
    'integ.firebird_host_placeholder': 'Servernaam of -adres',
    'integ.firebird_port_label': 'Poort',
    'integ.firebird_database_placeholder': 'Database-alias of pad op de server',
    'integ.firebird_user_label': 'Gebruiker',
    'integ.firebird_user_placeholder': 'Databasegebruiker',
    'integ.firebird_password_label': 'Wachtwoord',
    'integ.firebird_password_placeholder': 'Databasewachtwoord',
    'integ.firebird_charset_label': 'Tekenset',
    'integ.firebird_test': 'Verbinding testen',
    'integ.firebird_test_ok': 'Verbonden: Firebird {version}, {tables} tabellen',
    'integ.firebird_test_failed': 'Verbinding mislukt',
    'integ.firebird_need_all': 'Vul server, database, gebruiker en wachtwoord in om te verbinden.',
    'integ.firebird_readonly_note': 'Alleen-lezen: Bee Flow voert alleen SELECT-opdrachten uit en schrijft nooit naar je database.',
    'connections.field_firebird_port': 'Poort (standaard 3050)',
    'connections.field_firebird_database': 'Database (alias of pad)',
    'connections.field_firebird_user': 'Gebruiker',
    'connections.field_firebird_password': 'Wachtwoord',
    'connections.field_firebird_charset': 'Tekenset (standaard UTF8)',
    'settings.integrations.firebird_help': 'Firebird-hulp:',
    'settings.integrations.firebird_link': 'Firebird-documentatie',
    'settings.integrations.firebird_plan': '(typisch gebruik: Syntess Atrium)',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-firebird-translations applied (+${added} keys)`);
    }
}

// Keys whose Dutch is the English word (declared, not copied).
const SAME_AS_ENGLISH = ['integ.firebird_host_label', 'integ.firebird_port_placeholder', 'integ.firebird_database_label', 'connections.field_firebird_host'];

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
