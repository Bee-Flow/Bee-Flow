/**
 * Nodes the canvas draws that are not steps with a family colour: the note,
 * and the canvas-only synthetic types (SYNTHETIC_TYPES in ./index.ts).
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `routines.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const CANVAS_DEFS: Record<string, NodeDefSource> = {
    note: {
        family: null,
        typeLabel: 'Note',
        defaultLabel: 'Note',
        desc: 'A sticky note for context — never runs',
        help: 'A free-floating annotation you can drop anywhere on the canvas to explain why a branch exists or leave a to-do. It never runs and is never wired to anything else.',
        sectionKeys: ['content'],
        simpleSections: ['content'],
        issueSections: { fallback: 'content', map: { label: FLAT, text: 'content', color: 'content', size: 'content' } },
        labelFallback: 'Note',
    },
    loop_item: {
        family: 'loop',
        typeLabel: 'Each item',
        help: 'Where every step inside the loop starts. One item of the list at a time, available to those steps as loop.item.',
    },
    ai_tool: {
        family: 'ai',
        typeLabel: 'Tool',
        help: 'Something the AI step above is allowed to use on its own — it decides whether to, and with what.',
    },
    row_label: {
        family: null,
        typeLabel: 'Row',
        help: 'The label above a row of a wrapped canvas, naming the row and the steps it holds. Drawn from where the cards sit; it is not a step and is never saved.',
    },
    ghost_step: {
        family: null,
        typeLabel: 'Next step',
        help: 'Where the assistant\'s next step will land while it is building, with a line on what it is working on. It is not a step and is never saved.',
    },
};
