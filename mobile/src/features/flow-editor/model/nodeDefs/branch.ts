/**
 * The branch family. condition / switch / filter are ONE node to the user
 * (../route/routeModel.ts) and share one editor layout; parallel is
 * engine-only.
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `routines.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const BRANCH_DEFS: Record<string, NodeDefSource> = {
    condition: {
        family: 'branch',
        typeLabel: 'Condition',
        defaultLabel: 'Condition',
        desc: 'Keep, split or branch — one rule or many',
        help: 'Asks a yes/no question about your data and sends the run out of the matching side.',
        sectionKeys: ['rules', 'advanced'],
        simpleSections: ['rules'],
        issueSections: {
            fallback: 'rules',
            map: {
                label: FLAT,
                expr: 'rules',
                cases: 'rules',
                arrayRef: 'advanced',
                maxItems: 'advanced',
                defaultBranch: 'advanced',
            },
        },
        labelFallback: 'Condition',
    },
    switch: {
        family: 'branch',
        typeLabel: 'Condition',
        defaultLabel: 'Condition',
        help: 'Asks a yes/no question about your data and sends the run out of the matching side.',
        sectionKeys: ['rules', 'advanced'],
        simpleSections: ['rules'],
        issueSections: {
            fallback: 'rules',
            map: {
                label: FLAT,
                expr: 'rules',
                cases: 'rules',
                arrayRef: 'advanced',
                maxItems: 'advanced',
                defaultBranch: 'advanced',
                matchMode: 'advanced',
            },
        },
    },
    filter: {
        family: 'branch',
        typeLabel: 'Condition',
        defaultLabel: 'Condition',
        help: 'Asks a yes/no question about your data and sends the run out of the matching side.',
        sectionKeys: ['rules', 'advanced'],
        simpleSections: ['rules'],
        issueSections: {
            fallback: 'rules',
            map: { label: FLAT, expr: 'rules', arrayRef: 'advanced', maxItems: 'advanced' },
        },
    },
    parallel: {
        family: 'branch',
        typeLabel: 'Parallel',
        defaultLabel: 'Parallel',
        help: 'Runs several branches at the same time and continues once they have all finished.',
        sectionKeys: ['config'],
        issueSections: { fallback: 'config', map: { label: FLAT, branches: 'config' } },
    },
};
