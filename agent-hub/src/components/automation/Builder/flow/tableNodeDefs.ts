/**
 * The presentation records of the two spreadsheet steps (and the KB query log step), in the shape of
 * nodeDefs.js's NODE_DEFS (which spreads them in). Their own file keeps the
 * shared registry under its size ceiling. Presentation only, like the rest.
 */

// `null` in an issue map = a flat, always-visible field with no section to open (nodeDefs.FLAT).
const FLAT = null;

export const TABLE_NODE_DEFS = {
    read_table: {
        family: 'data',
        typeLabel: 'Read table', defaultLabel: 'Read table',
        label: 'Read table', desc: 'Open a spreadsheet or CSV file as a table, one table for each sheet.',
        help: 'Opens a spreadsheet or CSV file that someone uploaded, or that an earlier step made, and turns each sheet into a table the next steps can work on.',
        sectionKeys: ['config', 'advanced'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: {
                label: FLAT, source: 'config', sheets: 'config', headerRow: 'config',
                provenanceSheet: 'advanced', format: 'advanced', delimiter: 'advanced', skipHiddenSheets: 'advanced',
                expiresInDays: 'advanced', forEach: 'advanced',
            },
        },
    },
    table: {
        family: 'data',
        typeLabel: 'Edit table', defaultLabel: 'Edit table',
        label: 'Edit table', desc: 'Join, filter, calculate, group or summarise a table, step by step, with a preview.',
        help: 'Works on a table from an earlier step without code: combine it with another table, keep some rows, add calculated columns, group and count, or replace names by codes. The original table stays as it was.',
        sectionKeys: ['config', 'output', 'advanced'],
        simpleSections: ['config', 'output'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, source: 'config', ops: 'config', name: 'output', expiresInDays: 'output', forEach: 'advanced' },
        },
    },
    kb_query_log: {
        family: 'data',
        typeLabel: 'Knowledge base query log', defaultLabel: 'Knowledge base query log',
        label: 'Knowledge base query log', desc: 'Read what people asked a knowledge base, or mark an entry as reviewed',
        help: 'Reads the query log of a knowledge base (what people asked, what it found and answered) or sets the review status of one entry. Enterprise only, and the automation\'s owner must manage the knowledge base.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: {
                label: FLAT,
                op: 'config', knowledgeBaseId: 'config', filters: 'config', limit: 'config', resultDetail: 'config',
                entryId: 'config', status: 'config', note: 'config',
            },
        },
    },
};
