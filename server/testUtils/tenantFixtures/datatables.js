// @typecheck strict
/**
 * Tenant-isolation fixtures: a data table of org B (the datatables module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'datatable',
        mount: '/api/datatables',
        router: () => require('../../routes/datatables'),
        create: async ({ orgId, userId, index }) => {
            const datatableStore = require('../../stores/datatableStore');
            const t = await datatableStore.createDatatable({
                scope: datatableStore.orgScope(orgId), ownerUserId: userId, key: `matrix_${index}`, name: `Table ${index}`,
                fields: [{ key: 'label', name: 'Label', type: 'text' }],
            });
            return t.id;
        },
        routes: [
            'GET /api/datatables/:id', 'GET /api/datatables/:id/rows', 'DELETE /api/datatables/:id',
            // The other routes under the table's id. A member of org A gets the table's 404 on each; the owner gets
            // past it (a 200, the 400 of an empty body, or the 403 of a permission a plain member does not hold).
            'PATCH /api/datatables/:id', 'POST /api/datatables/:id/aggregate', 'DELETE /api/datatables/:id/answers/columns/:fieldId',
            'POST /api/datatables/:id/answers/release', 'GET /api/datatables/:id/grants', 'POST /api/datatables/:id/grants',
            'DELETE /api/datatables/:id/grants/:grantId', 'GET /api/datatables/:id/health', 'PUT /api/datatables/:id/nextcloud',
            'PUT /api/datatables/:id/nextcloud/relations', 'POST /api/datatables/:id/nextcloud/relink', 'POST /api/datatables/:id/repair',
            'POST /api/datatables/:id/rows', 'GET /api/datatables/:id/rows.csv', 'DELETE /api/datatables/:id/rows/:rowId',
            'GET /api/datatables/:id/rows/:rowId', 'PUT /api/datatables/:id/rows/:rowId', 'POST /api/datatables/:id/rows/bulk',
            'POST /api/datatables/:id/rows/bulk-delete', 'GET /api/datatables/:id/schema', 'PUT /api/datatables/:id/schema',
            'PUT /api/datatables/:id/sharing', 'PUT /api/datatables/:id/source', 'PUT /api/datatables/:id/source/relations',
            'POST /api/datatables/:id/source/relink', 'GET /api/datatables/:id/usage',
            'GET /api/datatables/:id/answers/summary', 'GET /api/datatables/:id/nextcloud', 'GET /api/datatables/:id/nextcloud/pulse',
            'GET /api/datatables/:id/source', 'GET /api/datatables/:id/source/pulse', 'POST /api/datatables/:id/nextcloud/refresh',
            'POST /api/datatables/:id/source/refresh',
        ],
    },
];

module.exports = { FIXTURES };
