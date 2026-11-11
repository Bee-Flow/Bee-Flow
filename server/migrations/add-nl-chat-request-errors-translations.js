#!/usr/bin/env node
// @typecheck strict
/**
 * Migration: Dutch translations for the chat's request errors: a
 * message refused by HTTP status (too large for the connection, gateway
 * timeout, other status), the generic failure line, and the notice for an
 * attachment over the size cap.
 *
 * Idempotent: only inserts keys that have no NL value yet. Auto-runs from the
 * boot list (server/boot/bootMigrations.js).
 */

const NL_TRANSLATIONS = {
    'chat.error.generic': 'Fout bij het genereren van het antwoord.',
    'chat.error.request_too_large': 'Het bericht of de bijlagen zijn te groot voor de verbinding met Bee Flow. Probeer een kleiner bestand, of vraag je beheerder de uploadlimiet van de proxy vóór Bee Flow te verhogen.',
    'chat.error.gateway_timeout': 'Bee Flow antwoordde niet op tijd. Probeer het zo opnieuw.',
    'chat.error.http_status': 'Het bericht kon niet worden verstuurd (fout {status}).',
    'chat.attachment_too_large': '{name} is te groot om toe te voegen (maximaal {limit} MB).',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-chat-request-errors-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
