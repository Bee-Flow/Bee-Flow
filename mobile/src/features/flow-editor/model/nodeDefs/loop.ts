/**
 * The loop family: repeat for each item, and run a flowlet.
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `routines.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const LOOP_DEFS: Record<string, NodeDefSource> = {
    loop: {
        family: 'loop',
        typeLabel: 'Repeat',
        defaultLabel: 'Repeat for each',
        desc: 'Run the steps inside once for every item in a list',
        help: 'Takes a list and runs the steps inside it once per item. Each item is available to those steps as loop.item.',
        sectionKeys: ['loop', 'body'],
        simpleSections: ['loop', 'body'],
        issueSections: {
            fallback: 'loop',
            map: {
                label: FLAT,
                overRef: 'loop',
                itemVar: 'loop',
                maxIterations: 'loop',
                batchSize: 'loop',
                body: 'body',
            },
        },
        labelFallback: 'Repeat for each',
    },
    call_layer: {
        family: 'loop',
        typeLabel: 'Flowlet',
        defaultLabel: 'Flowlet',
        help: 'Runs a group of steps you built once and can reuse, then carries on with what it returns.',
        sectionKeys: ['flowlet', 'inputs', 'returns'],
        simpleSections: ['flowlet', 'inputs', 'returns'],
        issueSections: {
            fallback: 'inputs',
            map: { label: FLAT, layerKey: 'flowlet', layerId: 'flowlet', inputs: 'inputs' },
        },
    },
};
