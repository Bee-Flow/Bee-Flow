/**
 * The trigger. Its label, description and type label are per KIND and live in
 * ../triggerLabels.ts; only the editor sections and issue map are here.
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `automations.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const TRIGGER_DEFS: Record<string, NodeDefSource> = {
    trigger: {
        family: 'trigger',
        typeLabel: 'Trigger',
        defaultLabel: 'Trigger',
        help: 'What starts this automation. Every automation has exactly one.',
        sectionKeys: ['inputs', 'config'],
        simpleSections: ['inputs', 'config'],
        issueSections: {
            fallback: 'config',
            map: {
                label: FLAT,
                kind: FLAT,
                params: 'config',
                appEvent: 'config',
                scheduleCron: 'config',
                scheduleTz: 'config',
            },
        },
    },
};
