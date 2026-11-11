/**
 * Per-tool overrides of INTEGRATION_TOOL_MAP for the Frappe CRM tools (kept
 * apart to hold integrationToolMap.js under its size ceiling, like
 * integrationToolMap.databases.js).
 *
 * The site is the customer's own (Frappe Cloud or self-hosted), so the server
 * is left to the probe-captured TLS name. CRM records are business data about
 * named people: leads, deals and contacts carry names, e-mail addresses and
 * phone numbers. The status lists carry no record data.
 */

interface ToolMapEntry {
    integration: string;
    label: string;
    serverFn: () => string | null;
    direction: string;
    dataCategories: string;
}

const READS = [
    'frappe_crm_list_leads', 'frappe_crm_get_lead', 'frappe_crm_list_deals', 'frappe_crm_get_deal',
    'frappe_crm_list_contacts', 'frappe_crm_get_contact', 'frappe_crm_list_organizations', 'frappe_crm_get_organization',
    'frappe_crm_list_tasks', 'frappe_crm_list_notes',
];
const WRITES = [
    'frappe_crm_create_lead', 'frappe_crm_update_lead', 'frappe_crm_create_deal', 'frappe_crm_update_deal',
    'frappe_crm_add_note', 'frappe_crm_create_task',
];

function entry(direction: string, dataCategories: string): ToolMapEntry {
    return { integration: 'frappe-crm', label: 'Frappe CRM', serverFn: () => null, direction, dataCategories };
}

export const FRAPPE_CRM_TOOL_MAP: Record<string, ToolMapEntry> = {
    ...Object.fromEntries(READS.map((name) => [name, entry('received', 'crm, business_data, pii')])),
    ...Object.fromEntries(WRITES.map((name) => [name, entry('sent', 'crm, business_data, pii')])),
    frappe_crm_list_statuses: entry('received', 'metadata'),
};
