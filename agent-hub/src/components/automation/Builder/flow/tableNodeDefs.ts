/**
 * The presentation records of the two spreadsheet steps, in the shape of
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
};
