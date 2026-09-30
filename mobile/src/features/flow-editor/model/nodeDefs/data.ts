/**
 * The data family, records and stores: edit data, dates, the retired Parse
 * JSON, the two steps whose effect outlives the run.
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `routines.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const DATA_DEFS: Record<string, NodeDefSource> = {
    set: {
        family: 'data',
        typeLabel: 'Edit data',
        defaultLabel: 'Edit data',
        desc: 'Add, rename and organise fields — for one record or a whole table',
        help: 'Builds the exact set of fields the next step needs — adding, renaming and reorganising what came before.',
        sectionKeys: ['fields', 'table', 'advanced'],
        simpleSections: ['fields', 'table'],
        issueSections: {
            fallback: 'fields',
            map: {
                label: FLAT,
                fields: 'fields',
                inputs: 'fields',
                forEach: 'advanced',
                arrayRef: 'advanced',
                maxItems: 'advanced',
                operations: 'table',
            },
        },
        labelFallback: 'Edit data',
    },
    datetime: {
        family: 'data',
        typeLabel: 'Date & time',
        defaultLabel: 'Date & time',
        desc: 'Get today’s date, reformat one, add days, or compare two',
        help: 'Works with dates and times: today’s date, reading one out of text, reformatting it, shifting it, or measuring the gap between two.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: {
                label: FLAT,
                op: 'config',
                input: 'config',
                input2: 'config',
                amount: 'config',
                format: 'config',
                part: 'config',
                unit: 'config',
            },
        },
        labelFallback: 'Date & time',
    },
    parse_json: {
        family: 'data',
        typeLabel: 'Parse JSON',
        defaultLabel: 'Parse JSON',
        help: 'Pulls named fields out of a block of JSON text. Retired — Edit data does this now.',
        sectionKeys: ['source', 'fields', 'options'],
        simpleSections: ['source', 'fields'],
        issueSections: {
            fallback: 'fields',
            map: { label: FLAT, sourceRef: 'source', itemsRef: 'source', mode: 'fields', fields: 'fields' },
        },
    },
    datatable: {
        family: 'data',
        typeLabel: 'Datatable',
        defaultLabel: 'Datatable',
        desc: 'Keep rows that outlast the run — and share them with other routines',
        help: 'Reads and writes rows in a table that stays put after the run ends, so this routine can pick up where it left off and other routines can use the same data.',
        sectionKeys: ['table', 'match', 'values', 'advanced'],
        simpleSections: ['table', 'match', 'values'],
        issueSections: {
            fallback: 'table',
            map: {
                label: FLAT,
                datatableId: 'table',
                op: 'table',
                where: 'match',
                matchColumn: 'match',
                sort: 'match',
                limit: 'match',
                values: 'values',
                forEach: 'advanced',
            },
        },
        labelFallback: 'Datatable',
    },
    knowledge_write: {
        family: 'data',
        typeLabel: 'To knowledge base',
        defaultLabel: 'To knowledge base',
        desc: 'Save text where an agent can find it later',
        help: 'Stores text in a knowledge base, so your agents can answer from it afterwards — a resolved ticket as an article, a meeting\'s decisions, last night\'s summary. Give it a source reference and each run replaces its own entry instead of leaving a new one behind.',
        sectionKeys: ['destination', 'content', 'advanced'],
        simpleSections: ['destination', 'content'],
        issueSections: {
            fallback: 'content',
            map: {
                label: FLAT,
                knowledgeBaseId: 'destination',
                content: 'content',
                'title': 'content',
                sourceUri: 'content',
                nearDuplicateStrategy: 'advanced',
                forEach: 'advanced',
            },
        },
        labelFallback: 'To knowledge base',
    },
};
