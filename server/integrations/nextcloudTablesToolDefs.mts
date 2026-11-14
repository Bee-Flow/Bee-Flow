/**
 * Tool definitions (OpenAI function-calling format) of the Nextcloud Tables tools.
 * Pure data: the executor is nextcloudTablesTools.js.
 */

// A table with tens of thousands of rows would blow the model's context and
// the run-log budget. Reads are capped and report whether they truncated.
export const MAX_ROWS = 500;
export const DEFAULT_ROWS = 100;

export const NEXTCLOUD_TABLES_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_list',
            description: 'List the Nextcloud Tables the user can access, with id, title, emoji, ownership and row/column counts. Call this first to find a table id.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_create',
            description: 'Create a new Nextcloud Table. Returns the new table id.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Title of the new table.' },
                    emoji: { type: 'string', description: 'Optional single emoji used as the table icon.' },
                    template: { type: 'string', description: 'Optional starter template, e.g. "todo", "members", "weight". Omit for an empty table.' }
                },
                required: ['title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_update',
            description: 'Rename a table, change its emoji, or archive/unarchive it.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' },
                    title: { type: 'string', description: 'New title.' },
                    emoji: { type: 'string', description: 'New emoji icon.' },
                    archived: { type: 'boolean', description: 'true archives the table, false restores it.' }
                },
                required: ['tableId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_delete',
            description: 'Permanently delete a table and every row in it. Destructive — prefer archiving via nextcloud_tables_update.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' }
                },
                required: ['tableId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_list_columns',
            description: 'List a table\'s columns with their numeric ids, titles and types. Needed to interpret row values, and to build a filter for nextcloud_tables_list_rows.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' }
                },
                required: ['tableId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_create_column',
            description: 'Add a column to a table.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' },
                    title: { type: 'string', description: 'Column title.' },
                    type: { type: 'string', description: 'Column type: "text", "number", "datetime", "selection" or "usergroup". Defaults to "text".' },
                    subtype: { type: 'string', description: 'Optional subtype, e.g. "line" or "long" for text, "date" for datetime, "check" for selection.' },
                    mandatory: { type: 'boolean', description: 'Whether the column is required.' },
                    description: { type: 'string', description: 'Optional column description.' },
                    selectionOptions: { type: 'array', items: { type: 'string' }, description: 'For "selection" columns: the list of allowed option labels. Rows are then written and read by label.' },
                    numberDecimals: { type: 'integer', description: 'For "number" columns: how many decimals are kept (default 0, so 3.5 is stored as 3). Set 2 for amounts.' },
                    numberPrefix: { type: 'string', description: 'For "number" columns: optional prefix such as a currency symbol.' },
                    numberSuffix: { type: 'string', description: 'For "number" columns: optional suffix such as a unit.' }
                },
                required: ['tableId', 'title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_delete_column',
            description: 'Delete a column and all of its values.',
            parameters: {
                type: 'object',
                properties: {
                    columnId: { type: 'integer', description: 'Column id (from nextcloud_tables_list_columns).' }
                },
                required: ['columnId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_list_rows',
            description: 'Read rows from a table. Values are returned keyed by column TITLE so they are readable and can be bound in an automation. Optionally filter with a simple field/operator/value match.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' },
                    limit: { type: 'integer', description: `Max rows (default ${DEFAULT_ROWS}, max ${MAX_ROWS}).` },
                    offset: { type: 'integer', description: 'Rows to skip, for paging through a large table.' },
                    filterColumn: { type: 'string', description: 'Optional column title to filter on.' },
                    filterOperator: { type: 'string', description: 'One of "equals", "not_equals", "contains", "greater_than", "less_than", "is_empty", "is_not_empty". Defaults to "equals".' },
                    filterValue: { type: 'string', description: 'Value to compare against. Not needed for is_empty / is_not_empty.' }
                },
                required: ['tableId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_create_row',
            description: 'Append a row to a table — tableId is the table id or its exact title (e.g. "Facturen"). Pass values keyed by column title, e.g. {"Company": "Acme BV", "Status": "new"}.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' },
                    values: { type: 'object', description: 'Object mapping column TITLE to value. Unknown titles are reported as an error rather than silently dropped.' }
                },
                required: ['tableId', 'values']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_update_row',
            description: 'Update values on an existing row. Only the columns you pass are changed.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: ['integer', 'string'], description: 'Table id (from nextcloud_tables_list) — or the exact table title, e.g. "Facturen", when the id is unknown.' },
                    rowId: { type: 'integer', description: 'Row id (from nextcloud_tables_list_rows).' },
                    values: { type: 'object', description: 'Object mapping column TITLE to the new value.' }
                },
                required: ['tableId', 'rowId', 'values']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tables_delete_row',
            description: 'Delete a single row from a table.',
            parameters: {
                type: 'object',
                properties: {
                    rowId: { type: 'integer', description: 'Row id to delete.' }
                },
                required: ['rowId']
            }
        }
    }
];
