/**
 * The data family, whole-list operations.
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `automations.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const LIST_DEFS: Record<string, NodeDefSource> = {
    limit: {
        family: 'data',
        typeLabel: 'Shorten list',
        defaultLabel: 'Shorten list',
        desc: 'Keep only the first — or last — few items',
        help: 'Cuts a list down to the first or last few items and passes the shorter list on.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, arrayRef: 'config', count: 'config', mode: 'config', maxItems: 'config' },
        },
        labelFallback: 'Shorten list',
    },
    dedupe: {
        family: 'data',
        typeLabel: 'Remove duplicates',
        defaultLabel: 'Remove duplicates',
        desc: 'Keep one of each — matching the whole item, or one field',
        help: 'Keeps one of each item and drops the repeats. Match on one field, or on the whole item.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, arrayRef: 'config', field: 'config', keyField: 'config', maxItems: 'config' },
        },
        labelFallback: 'Remove duplicates',
    },
    aggregate: {
        family: 'data',
        typeLabel: 'Collect one field',
        defaultLabel: 'Collect one field',
        desc: 'Take the same field from every item — every email address, say',
        help: 'Reads one field from every item in a list and hands back a plain list of just those values.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, arrayRef: 'config', field: 'config', maxItems: 'config' },
        },
        labelFallback: 'Collect one field',
    },
    summarize: {
        family: 'data',
        typeLabel: 'Add up or count',
        defaultLabel: 'Add up or count',
        desc: 'Total, count, average, lowest or highest — across one field',
        help: 'Turns a list into a single number: the total, the count, the average, or the lowest or highest value of one field.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, arrayRef: 'config', field: 'config', op: 'config', maxItems: 'config' },
        },
        labelFallback: 'Add up or count',
    },
};
