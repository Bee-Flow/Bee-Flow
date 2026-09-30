/**
 * The Privacy Shield family: find, hide and restore personal data.
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `routines.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const GUARD_DEFS: Record<string, NodeDefSource> = {
    guard: {
        family: 'guard',
        typeLabel: 'Personal data check',
        defaultLabel: 'Find personal data',
        desc: 'Scan a value and branch on whether it holds personal data',
        help: 'Looks through a value for names, addresses, ID numbers and the like, then sends the run out of the "personal data" or "clean" side.',
        sectionKeys: ['config', 'advanced'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: {
                label: FLAT,
                sourceRef: 'config',
                onFound: 'config',
                categories: 'advanced',
                confidence: 'advanced',
                forEach: 'advanced',
            },
        },
        labelFallback: 'Find personal data',
    },
    tokenize: {
        family: 'guard',
        typeLabel: 'Hide personal data',
        defaultLabel: 'Hide personal data',
        desc: 'Swap personal data for placeholders; the real values come back on their own',
        help: 'Replaces personal data with placeholders before the value travels on — to an AI model, say. The real values are put back automatically wherever the run uses them again.',
        sectionKeys: ['config', 'advanced'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: {
                label: FLAT,
                sourceRef: 'config',
                categories: 'advanced',
                confidence: 'advanced',
                forEach: 'advanced',
            },
        },
        labelFallback: 'Hide personal data',
    },
    untokenize: {
        family: 'guard',
        typeLabel: 'Show real values',
        defaultLabel: 'Show real values again',
        desc: 'Put the real values back where a step still holds placeholders',
        help: 'Puts the real values back in place of any placeholders left in a value. Only needed where they did not already come back on their own.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: { fallback: 'config', map: { label: FLAT, sourceRef: 'config' } },
        labelFallback: 'Show real values again',
    },
};
