'use strict';

/**
 * Nederlandse teksten voor het ontgrendelen van versleuteling bij documenten.
 *
 * Draai handmatig met:
 *   node server/migrations/add-nl-document-encryption-translations.js
 */
const NL_TRANSLATIONS = {
    'documents.encryption.cancel': 'Annuleren',
    'documents.encryption.locked_title': 'Versleuteling ontgrendelen',
    'documents.encryption.locked_signin': 'Je versleutelingssleutel is in deze sessie niet geladen, dus dit document kan niet worden versleuteld. Log opnieuw in om te ontgrendelen en start het document daarna opnieuw.',
    'documents.encryption.sign_in_again': 'Opnieuw inloggen',
    'documents.encryption.key_unavailable': 'Je versleutelingssleutel is in deze sessie niet geladen. Log opnieuw in (of voer je versleutelings-PIN in) om te ontgrendelen en probeer het dan opnieuw.',
    'documents.encryption.decryption_failed': 'Dit document kon niet met je sleutel worden geopend. Log opnieuw in en probeer het nog eens; blijft het mislukken, vraag dan je beheerder.',
    'documents.encryption.invalid': 'Dit document gebruikt een versleutelingsindeling die deze versie niet herkent. Overleg met je beheerder voordat je iets wijzigt.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-document-encryption-translations applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
