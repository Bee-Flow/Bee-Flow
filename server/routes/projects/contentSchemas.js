'use strict';
/**
 * What the project content routes (routes/projects/content.js) accept.
 *
 * Closed, like every schema under /api/projects: a key a route does not read
 * is refused by name, and every refusal is a sentence.
 */

const { z, worded, bodyOf } = require('../../core/http/schemaParts');

const NAME_TEXT = 'name is the title, from 1 to 200 characters.';
const name = worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(200, NAME_TEXT);

// Read from the store when a request arrives, not at load: the list is the
// store's, and loading this file must not load the store.
const docTypes = () => require('../../stores/documentStore').DOC_TYPES || [];
const DOC_TYPE_TEXT = 'docType is a document type, like document, letter, report or presentation.';

/** POST /:id/documents — a new document, owned by the caller, filed in the project. */
const NewDocumentBody = bodyOf({
    name,
    docType: worded(DOC_TYPE_TEXT).refine((v) => docTypes().includes(v), DOC_TYPE_TEXT).optional(),
    starterId: worded('starterId is the id of a document starter.').trim().min(1, 'starterId is the id of a document starter.')
        .max(100, 'starterId is the id of a document starter.').optional(),
    locale: worded('locale is a language code, like en or nl.').trim().min(2, 'locale is a language code, like en or nl.')
        .max(20, 'locale is a language code, like en or nl.').optional(),
}, 'A new project document');

const DESCRIPTION_TEXT = 'description is text of at most 1000 characters.';

/** POST /:id/notebooks — a new notebook, owned by the caller, filed in the project. */
const NewNotebookBody = bodyOf({
    name,
    description: worded(DESCRIPTION_TEXT).max(1000, DESCRIPTION_TEXT).optional(),
}, 'A new project notebook');

module.exports = { z, NewDocumentBody, NewNotebookBody };
