/**
 * The end family. stop_error and return_to_app are terminal
 * (../terminalSteps.ts); layer_output is not — a flowlet returns to its
 * caller.
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `routines.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const END_DEFS: Record<string, NodeDefSource> = {
    stop_error: {
        family: 'end',
        typeLabel: 'Stop',
        defaultLabel: 'Stop with an error',
        desc: 'End the run now and record why',
        help: 'Ends the run immediately and records your message as the reason. Nothing after this node ever runs.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: { fallback: 'config', map: { label: FLAT, 'message': 'config' } },
        labelFallback: 'Stop with an error',
    },
    return_to_app: {
        family: 'end',
        typeLabel: 'Back to the app',
        defaultLabel: 'Back to the app',
        desc: 'End the run and tell the app what to do next',
        help: 'Ends the run and hands the app a message, a screen to open and what to refresh. Nothing after this node ever runs.',
        sectionKeys: ['config', 'advanced'],
        simpleSections: ['config'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, navigateTo: 'config', toast: 'config', refresh: 'config', onError: 'advanced' },
        },
        labelFallback: 'Back to the app',
    },
    layer_output: {
        family: 'end',
        typeLabel: 'Return',
        defaultLabel: 'Return',
        desc: 'Return data from this flowlet to its caller',
        help: 'Ends a flowlet and hands the fields you name back to whatever called it.',
        sectionKeys: ['fields'],
        simpleSections: ['fields'],
        issueSections: { fallback: 'fields', map: { label: FLAT, fields: 'fields' } },
        labelFallback: 'Flowlet output',
    },
};
