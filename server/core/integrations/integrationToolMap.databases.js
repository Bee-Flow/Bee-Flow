// @typecheck strict
'use strict';

/**
 * Per-tool overrides of INTEGRATION_TOOL_MAP for the Firebird and vPlan tools
 * (split out of integrationToolMap.js to keep that file under its size ceiling).
 * @type {Record<string, { integration: string, label: string, serverFn: () => string | null, direction: string, dataCategories: string }>}
 */
module.exports = {
    // ── Firebird database (read-only SQL) ────────────────────
    // Rows come straight from the customer's ERP database: business data and
    // very likely personal data. The structure reads carry no row data.
    firebird_whoami: { integration: 'firebird', label: 'Firebird database', serverFn: () => null, direction: 'received', dataCategories: 'metadata' },
    firebird_list_tables: { integration: 'firebird', label: 'Firebird database', serverFn: () => null, direction: 'received', dataCategories: 'metadata' },
    firebird_describe_table: { integration: 'firebird', label: 'Firebird database', serverFn: () => null, direction: 'received', dataCategories: 'metadata' },
    firebird_sample_rows: { integration: 'firebird', label: 'Firebird database', serverFn: () => null, direction: 'received', dataCategories: 'business_data, pii' },
    firebird_query: { integration: 'firebird', label: 'Firebird database', serverFn: () => null, direction: 'received', dataCategories: 'business_data, pii' },

    // ── vPlan (read-only planning) ───────────────────────────
    // Planning data is business data, but a few endpoints carry people: the
    // resource/user lists are named employees, and time tracking ties named
    // people to hours. Tag those separately from the plain planning reads.
    vplan_whoami: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'account_metadata',
    },
    vplan_list_resources: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'planning_data, hr, pii',
    },
    vplan_get_resource_availability: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'planning_data, hr, absence',
    },
    vplan_list_time_tracking: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'planning_data, hr, pii',
    },
    vplan_time_tracking_summary: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'planning_data, hr',
    },
    vplan_list_master_data: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'planning_data, crm, pii',
    },
};
