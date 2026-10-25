// @typecheck strict

const REQUEST_TIMEOUT_MS = 20000;

const DEFAULT_TAKE = 25;

const MAX_TAKE = 100;

const MAX_RESPONSE_CHARS = 30000;

const MAX_CONNECTOR_LIST = 200;

const MAX_ERROR_MESSAGE_CHARS = 300;

// Environment type → URL subdomain. Fixed map: the raw envType value must never
// reach the hostname.
/** @type {Record<string, string>} */
const ENV_SUBDOMAIN = {
    production: 'rest',
    test: 'resttest',
    accept: 'restaccept',
};

// Friendly operator names → AFAS operatortypes codes.
/** @type {Record<string, number>} */
const OPERATORS = {
    equals: 1,
    greater_or_equal: 2,
    less_or_equal: 3,
    greater_than: 4,
    less_than: 5,
    contains: 6,
    not_equals: 7,
    empty: 8,
    not_empty: 9,
    starts_with: 10,
    ends_with: 13,
};

const CONNECTOR_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const FIELD_RE = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,127}$/;

const MEMBER_NUMBER_RE = /^\d{1,10}$/;

/**
 * Tool definitions in OpenAI function-calling format.
 */
const AFAS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'afas_list_connectors',
            description: 'List the AFAS Profit GetConnectors (data views) available in this environment. ALWAYS call this first to discover connector IDs before describing or querying — GetConnectors are customer-defined, so never guess their names.',
            parameters: {
                type: 'object',
                properties: {},
                required: /** @type {string[]} */ ([])
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'afas_describe_connector',
            description: 'Get the field schema of an AFAS Profit GetConnector: field IDs, labels, data types and lengths. Use connector IDs from afas_list_connectors. Call this before afas_query so you filter and sort on real field IDs.',
            parameters: {
                type: 'object',
                properties: {
                    connectorId: {
                        type: 'string',
                        description: 'The GetConnector ID from afas_list_connectors'
                    }
                },
                required: ['connectorId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'afas_query',
            description: 'Query rows from an AFAS Profit GetConnector (read-only). Workflow: afas_list_connectors → afas_describe_connector → afas_query. Filters combine with AND. Operators: equals, not_equals, contains, starts_with, ends_with, greater_than, less_than, greater_or_equal, less_or_equal, empty, not_empty. Use skip/take for pagination and filters to keep results small.',
            parameters: {
                type: 'object',
                properties: {
                    connectorId: {
                        type: 'string',
                        description: 'The GetConnector ID from afas_list_connectors'
                    },
                    filters: {
                        type: 'array',
                        description: 'Optional filters, combined with AND. Field IDs must come from afas_describe_connector. Values may not contain "," or ";".',
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string', description: 'Field ID to filter on' },
                                operator: { type: 'string', description: 'One of: equals, not_equals, contains, starts_with, ends_with, greater_than, less_than, greater_or_equal, less_or_equal, empty, not_empty (default: equals)' },
                                value: { type: 'string', description: 'Value to compare against (omit for empty/not_empty)' }
                            },
                            required: ['field']
                        }
                    },
                    orderBy: {
                        type: 'array',
                        description: 'Optional sort order.',
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string', description: 'Field ID to sort on' },
                                direction: { type: 'string', description: '"asc" (default) or "desc"' }
                            },
                            required: ['field']
                        }
                    },
                    skip: {
                        type: 'integer',
                        description: 'Pagination offset (default 0)'
                    },
                    take: {
                        type: 'integer',
                        description: `Maximum number of rows (1-${MAX_TAKE}, default ${DEFAULT_TAKE})`
                    }
                },
                required: ['connectorId']
            }
        }
    }
];

/**
 * Build the Profit REST base URL. The member number forms the subdomain, so it
 * is strictly digits-only — this validation is the SSRF guard.
 * @param {unknown} memberNumber
 * @param {unknown} envType
 */
function buildBaseUrl(memberNumber, envType) {
    const nr = String(memberNumber || '').trim();
    if (!MEMBER_NUMBER_RE.test(nr)) {
        throw new Error('Invalid AFAS member number — must be digits only.');
    }
    const sub = ENV_SUBDOMAIN[String(envType || 'production').trim().toLowerCase()];
    if (!sub) {
        throw new Error('Invalid AFAS environment type — use production, test or accept.');
    }
    return `https://${nr}.${sub}.afas.online/profitrestservices`;
}

/** @type {Record<number, string>} */
const STATUS_REASONS = {
    400: 'AFAS rejected the request (check connector ID, field IDs and filters)',
    401: 'AFAS token is invalid or has been revoked',
    403: 'the AppConnector user lacks rights to this connector',
    404: 'connector not found in this AFAS environment',
};

module.exports = { REQUEST_TIMEOUT_MS, DEFAULT_TAKE, MAX_TAKE, MAX_RESPONSE_CHARS, MAX_CONNECTOR_LIST, MAX_ERROR_MESSAGE_CHARS, OPERATORS, CONNECTOR_ID_RE, FIELD_RE, AFAS_TOOLS, buildBaseUrl, STATUS_REASONS };
