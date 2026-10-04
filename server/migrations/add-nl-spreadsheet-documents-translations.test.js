/**
 * The Dutch for spreadsheets in Documents: the type in the library
 * (`documents.sheet.*`) and the grid editor (`spreadsheet.*`). The rules
 * themselves live in testUtils/nlCatalogueChecks.js.
 *
 * Run: node --test migrations/add-nl-spreadsheet-documents-translations.test.js
 */

const { registerNlCatalogueChecks } = require('../testUtils/nlCatalogueChecks');
const catalogue = require('./add-nl-spreadsheet-documents-translations');

registerNlCatalogueChecks({
    name: 'add-nl-spreadsheet-documents-translations',
    catalogue,
    mayHold: ['documents.sheet.', 'documents.type.spreadsheet', 'spreadsheet.'],
    // The families this round created: a key added to them later without
    // Dutch turns this red.
    mustCover: ['documents.sheet.', 'spreadsheet.'],
    declaredFor: {
        'documents.sheet.new': 'Spreadsheet',
        'documents.sheet.type_filter': 'Spreadsheets',
        'documents.type.spreadsheet': 'Spreadsheet',
        'spreadsheet.grid_label': 'Spreadsheet',
    },
});
