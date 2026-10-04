/**
 * The Dutch for notebooks as a document type: the notebook in the Documents
 * library (`documents.notebook.*`) and the notebook workspace's new keys. The
 * rules themselves live in testUtils/nlCatalogueChecks.js; this file says
 * which keys the catalogue answers for.
 *
 * Run: node --test migrations/add-nl-notebooks-as-documents-translations.test.js
 */

const { registerNlCatalogueChecks } = require('../testUtils/nlCatalogueChecks');
const catalogue = require('./add-nl-notebooks-as-documents-translations');

registerNlCatalogueChecks({
    name: 'add-nl-notebooks-as-documents-translations',
    catalogue,
    mayHold: ['documents.notebook.', 'documents.type.notebook', 'notebooks.'],
    // The family this round created from scratch: a key added to it later
    // without Dutch turns this red.
    mustCover: ['documents.notebook.', 'notebooks.add_opt_', 'notebooks.src_type_'],
    declaredFor: {
        'notebooks.add_opt_url': 'Website',
        'notebooks.src_type_pdf': 'PDF',
        'notebooks.src_type_word': 'Word',
        'notebooks.src_type_excel': 'Excel',
        'notebooks.src_type_csv': 'CSV',
        'notebooks.src_type_url': 'URL',
        'notebooks.src_type_drive': 'Drive',
        'notebooks.src_type_onedrive': 'OneDrive',
        'notebooks.url_placeholder': 'https://example.com/article',
    },
});
