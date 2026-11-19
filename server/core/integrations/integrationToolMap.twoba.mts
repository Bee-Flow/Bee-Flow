/**
 * Per-tool overrides of INTEGRATION_TOOL_MAP for the 2BA tools (kept apart to
 * hold integrationToolMap.js under its size ceiling, like integrationToolMap.crm.mts).
 *
 * The host is fixed (api.2ba.nl). What goes out is article data: a supplier
 * GLN, article numbers, GTINs, quantities and a project number; what comes
 * back is article data and the company's own purchase prices. The upload sends
 * the company's condition file (its discount agreements with a supplier). No
 * tool sends or receives data about a person.
 */

interface ToolMapEntry {
    integration: string;
    label: string;
    server: string;
    direction: string;
    dataCategories: string;
}

function entry(direction: string, dataCategories: string): ToolMapEntry {
    return { integration: 'twoba', label: '2BA', server: 'api.2ba.nl', direction, dataCategories };
}

export const TWOBA_TOOL_MAP: Record<string, ToolMapEntry> = {
    twoba_find_trade_items: entry('received', 'product_data, business_data'),
    twoba_net_price: entry('received', 'product_data, business_data'),
    twoba_list_condition_databases: entry('received', 'metadata'),
    twoba_upload_conditions: entry('sent', 'business_data'),
};
