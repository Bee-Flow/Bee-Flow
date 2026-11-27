// @typecheck strict
/**
 * Tenant-isolation fixtures: a spreadsheet of org B (routes/studioDocuments.js). Its cells sit in a
 * data table, so the kind needs module "datatables". What a fixture is and how the matrix drives it
 * is in testUtils/tenantFixtures.js, which finds this file in testUtils/tenantFixtures/ and puts its
 * kinds in the matrix's order. The other Studio document kinds: studioDocuments.js.
 */

'use strict';

const NO_TEXT = 'Text that must not land here.';

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A spreadsheet of org B: its cells sit in a sheet table of the owner, the document is its door.
        kind: 'studioSheet',
        mount: '/api/studio-documents',
        router: () => require('../../routes/studioDocuments'),
        create: async ({ orgId, userId, index }) => {
            const cells = require('../../core/documents/sheetCells');
            const documentStore = require('../../stores/documentStore');
            const name = `Sheet ${index}`;
            const table = await cells.createSheetTable({ ownerUserId: userId, name });
            const doc = await documentStore.createDocument({
                userId, organizationId: orgId, name, docType: 'spreadsheet', kind: 'document', visibility: 'private', sheetTableId: table.id,
            });
            return doc.id;
        },
        routes: [
            'GET /api/studio-documents/:id/sheet', 'PATCH /api/studio-documents/:id/sheet',
            'GET /api/studio-documents/:id/sheet.csv', 'GET /api/studio-documents/:id/sheet.xlsx',
            'POST /api/studio-documents/:id/sheet/tabs', 'PATCH /api/studio-documents/:id/sheet/tabs/:tabId',
            'DELETE /api/studio-documents/:id/sheet/tabs/:tabId', 'POST /api/studio-documents/:id/sheet/assistant',
        ],
        bodies: {
            'PATCH /api/studio-documents/:id/sheet': { cells: { A1: NO_TEXT } },
            'PATCH /api/studio-documents/:id/sheet/tabs/:tabId': { name: 'Matrix tab' },
            'POST /api/studio-documents/:id/sheet/assistant': { message: 'A change that must not land here.' },
        },
    },
];

module.exports = { FIXTURES };
