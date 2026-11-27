// @typecheck strict
/**
 * Tenant-isolation fixtures: a Studio document and a library folder
 * (routes/studioDocuments.js and the routers it mounts). A spreadsheet keeps
 * its cells in a data table (module "datatables"): studioDocuments.datatables.js.
 * What a fixture is and how the matrix drives it is in
 * testUtils/tenantFixtures.js, which puts these in its list.
 *
 * Every read of a document checks ownership or same-organisation sharing in
 * SQL (documentStore accessSql), so a member of org A gets the document's 404;
 * the owner gets past it (a 200, the 400 of a body or of a document that is not
 * a presentation, or the 404 of a section, suggestion, version or tab that does
 * not exist: the matrix fills every parameter with the document's id).
 */

'use strict';

const NO_TEXT = 'Text that must not land here.';

/**
 * A letter of org B, shared with the whole of org B for editing: the reader's
 * organisation is what keeps org A out.
 * @param {{ orgId: string, userId: string, index: number }} ctx
 */
async function createSharedDocument({ orgId, userId, index }) {
    const documentStore = require('../../stores/documentStore');
    const doc = await documentStore.createDocument({
        userId, organizationId: orgId, name: `Document ${index}`, docType: 'letter',
        bodyHtml: '<section data-doc-section="intro"><p>Matrix fixture.</p></section>',
    });
    await require('../../stores/lib/documentSharing').setSharing('document', doc.id, userId, { audience: 'organisation', access: 'edit' });
    return doc.id;
}

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'studioDocument',
        mount: '/api/studio-documents',
        router: () => require('../../routes/studioDocuments'),
        create: createSharedDocument,
        routes: [
            'GET /api/studio-documents/:id', 'PATCH /api/studio-documents/:id', 'DELETE /api/studio-documents/:id',
            'GET /api/studio-documents/:id/contract', 'GET /api/studio-documents/:id/pdf', 'GET /api/studio-documents/:id/pptx',
            'GET /api/studio-documents/:id/preview', 'POST /api/studio-documents/:id/preview',
            'GET /api/studio-documents/:id/sections/:sectionId', 'POST /api/studio-documents/:id/sections/:sectionId/save',
            'GET /api/studio-documents/:id/updates', 'POST /api/studio-documents/:id/review-update',
            'POST /api/studio-documents/:id/preview-changes', 'POST /api/studio-documents/:id/ai-proposal',
            'POST /api/studio-documents/:id/validate', 'POST /api/studio-documents/:id/duplicate',
            // The live event stream: the owner's request stays open (an SSE stream), a member of org A gets the 404.
            'GET /api/studio-documents/:id/stream', 'POST /api/studio-documents/:id/presence',
            'GET /api/studio-documents/:id/sharing', 'GET /api/studio-documents/:id/sharing/principals',
            'PUT /api/studio-documents/:id/sharing',
            // The chat's form for a filled-in template: the owner's empty save is a 200.
            'PUT /api/studio-documents/:id/values',
            // The document as a .bftemplate file.
            'GET /api/studio-documents/:id/export',
            // Asking colleagues in a project for a filled-in template's fields, and closing that request.
            'POST /api/studio-documents/:id/value-requests', 'POST /api/studio-documents/:id/value-requests/:requestId/close',
            // The assistant's final check of what is filled in, and the notes people leave each other at the fields.
            'POST /api/studio-documents/:id/values/review',
            // The document with its values, as the fill-in form shows it next to the fields.
            'GET /api/studio-documents/:id/values/preview',
            'POST /api/studio-documents/:id/field-notes', 'DELETE /api/studio-documents/:id/field-notes/:noteId',
            'GET /api/studio-documents/:id/suggestions', 'POST /api/studio-documents/:id/suggestions/:sid/accept',
            'POST /api/studio-documents/:id/suggestions/:sid/reject', 'POST /api/studio-documents/:id/suggestions/batch/:batchId/accept',
            'POST /api/studio-documents/:id/suggestions/batch/:batchId/reject',
            'GET /api/studio-documents/:id/versions', 'POST /api/studio-documents/:id/versions',
            'GET /api/studio-documents/:id/versions/:ref', 'PUT /api/studio-documents/:id/versions/:ref/name',
        ],
        // The revision is `current`: reading one reads the document and the revision in one query, so for an
        // unknown revision the owner's 404 would be org A's; for `current` the owner gets a 200.
        params: { ref: 'current', requestId: 'matrix-request', noteId: 'matrix-note' },
        // The routes whose schema runs before the document is looked up, with a body it accepts.
        bodies: {
            'POST /api/studio-documents/:id/ai-proposal': { message: 'A change that must not land here.' },
            'POST /api/studio-documents/:id/presence': { clientId: 'matrix-client-1', state: 'viewing' },
            'PUT /api/studio-documents/:id/sharing': { audience: 'private' },
            'POST /api/studio-documents/:id/versions': { name: 'Matrix version' },
            'PUT /api/studio-documents/:id/versions/:ref/name': { name: 'Matrix version' },
            'PATCH /api/studio-documents/:id': { name: NO_TEXT },
            'PUT /api/studio-documents/:id/values': { values: { title: NO_TEXT } },
            'POST /api/studio-documents/:id/value-requests': { fields: ['title'], assigneeIds: ['matrix-colleague'] },
            'POST /api/studio-documents/:id/field-notes': { text: NO_TEXT },
        },
    },
    {
        // Restoring a revision: `current` is refused before any lookup, so here the revision is the document's
        // id (unknown). The document is read first: org A gets its 404, the owner the revision's. The history
        // list leads, for the owner's 200.
        kind: 'studioDocumentRestore',
        mount: '/api/studio-documents',
        router: () => require('../../routes/studioDocuments'),
        create: createSharedDocument,
        routes: ['GET /api/studio-documents/:id/versions', 'POST /api/studio-documents/:id/versions/:ref/restore'],
    },
    {
        // An archived document of org B: back from the archive is its owner's (documentStore.unarchiveDocument).
        kind: 'studioDocumentArchived',
        mount: '/api/studio-documents',
        router: () => require('../../routes/studioDocuments'),
        create: async ({ orgId, userId, index }) => {
            const documentStore = require('../../stores/documentStore');
            const doc = await documentStore.createDocument({ userId, organizationId: orgId, name: `Archived document ${index}`, docType: 'letter' });
            await documentStore.deleteDocument(doc.id, { userId, isAdmin: false });
            return doc.id;
        },
        routes: ['POST /api/studio-documents/:id/unarchive'],
    },
    {
        // A library folder of user B: folders are their owner's, so a member of org A deletes nothing.
        kind: 'studioDocumentFolder',
        mount: '/api/studio-documents',
        router: () => require('../../routes/studioDocuments'),
        create: async ({ userId, index }) => {
            const documentStore = require('../../stores/documentStore');
            const folder = await documentStore.createFolder(userId, `Folder ${index}`, null);
            return folder.id;
        },
        routes: ['DELETE /api/studio-documents/folders/:folderId'],
    },
];

module.exports = { FIXTURES };
