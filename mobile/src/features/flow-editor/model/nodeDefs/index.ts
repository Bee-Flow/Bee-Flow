/**
 * One presentation record per RUNTIME STEP TYPE — a port of the web builder's
 * flow/nodeDefs.js, split by family (one file each beside this one).
 *
 * THE RULE, the web's: presentation only. If the runner or the validator
 * would need to read it, it does not belong here. The palette entry (id,
 * icon, keywords, payload) is a different axis and lives in ../palette.
 *
 * Pinned twice: nodeDefs.lockstep.test.ts requires the web module and
 * compares every record and the key order, and holds the type list to the
 * server's VALID_STEP_TYPES.
 */

import type { Translate } from '../types';
import { AI_DEFS } from './ai';
import { APP_DEFS } from './app';
import { BRANCH_DEFS } from './branch';
import { CANVAS_DEFS } from './canvas';
import { DATA_DEFS } from './data';
import { DOCUMENT_DEFS } from './documents';
import { END_DEFS } from './end';
import { GUARD_DEFS } from './guard';
import { LIST_DEFS } from './lists';
import { LOOP_DEFS } from './loop';
import { PAUSE_DEFS } from './pause';
import { TRIGGER_DEFS } from './trigger';
import type { NodeDef, NodeDefSource, NodeFamily } from './types';

export { FLAT, NODE_FAMILIES } from './types';
export type { IssueSections, NodeDef, NodeDefSource, NodeFamily } from './types';

const ALL: Record<string, NodeDefSource> = {
    ...TRIGGER_DEFS, ...AI_DEFS, ...APP_DEFS, ...BRANCH_DEFS, ...LOOP_DEFS, ...PAUSE_DEFS,
    ...GUARD_DEFS, ...DATA_DEFS, ...DOCUMENT_DEFS, ...LIST_DEFS, ...END_DEFS, ...CANVAS_DEFS,
};

/** A family file's record in the web's shape: `labelFallback` served as `label`. */
function served(source: NodeDefSource): NodeDef {
    const { labelFallback, ...rest } = source;
    return labelFallback === undefined ? rest : { ...rest, label: labelFallback };
}

/** The web's declaration order — observable through NODE_TYPE_KEYS. */
const ORDER = [
    'trigger', 'ai_step', 'data_extraction', 'integration_action', 'condition', 'switch', 'filter', 'loop',
    'wait', 'stop_error', 'return_to_app', 'notification', 'form_page', 'guard', 'tokenize', 'untokenize',
    'set', 'datetime', 'http_request', 'generate_document', 'slide', 'presentation', 'fill_document',
    'parse_json', 'code', 'limit', 'datatable', 'knowledge_write', 'dedupe', 'flatten', 'aggregate', 'summarize',
    'note', 'call_layer', 'call_block', 'layer_output', 'approval', 'parallel',
    'loop_item', 'ai_tool', 'row_label', 'ghost_step',
] as const;

export const NODE_DEFS: Readonly<Record<string, NodeDef>> = Object.fromEntries(
    ORDER.map((type) => [type, served(ALL[type] as NodeDefSource)]),
);

/** Every node type this app knows how to present, in the web's order. */
export const NODE_TYPE_KEYS: readonly string[] = Object.keys(NODE_DEFS);

/** Runtime types with NO palette entry, each with the reason. */
export const PALETTE_ABSENT: Readonly<Record<string, string>> = {
    switch: 'runtime shape of the Condition node (many rules)',
    filter: 'runtime shape of the Condition node (works through a list); "Filter a list" adds one under the Condition name',
    parse_json: 'retired — absorbed by Edit data',
    parallel: 'engine-only; drawn on the canvas, but nothing builds `branches` yet',
};

/** Node types the canvas draws that are not steps at all; never saved. */
export const SYNTHETIC_TYPES: Readonly<Record<string, string>> = {
    loop_item: 'the "Each item" pill at the head of an expanded loop; never part of a definition',
    ai_tool: 'one tool chip under an AI step, drawn from its tools[] array; never a step of its own',
    row_label: 'the "Row n · steps a–b" gutter label above a wrapped row, derived from positions; never saved',
    ghost_step: 'the dashed "next step" slot ahead of the AI\'s frontier while it builds, placed where the next card will land; never saved',
};

/** Types with `family: null` — drawn, but not as a step card. */
export const FAMILY_EXEMPT: Readonly<Record<string, string>> = {
    // Quoted: a step type, not a copy prop.
    'note': 'a movable annotation with its own colour swatches (NoteNode.jsx), not a step card',
    row_label: 'a gutter label above a wrapped row (RowLabelNode.jsx), not a step card',
    ghost_step: 'the dashed next-step slot ahead of the build frontier (GhostStepNode.jsx), not a step card',
};

const K = 'automations.node';
type TextField = 'typeLabel' | 'defaultLabel' | 'help' | 'label' | 'desc';

const own = (type: string) => (Object.prototype.hasOwnProperty.call(NODE_DEFS, type) ? NODE_DEFS[type] : undefined);

function read(type: string, field: TextField, t: Translate | null): string {
    const english = own(type)?.[field];
    if (!english) return '';
    return t ? t(`${K}.${type}.${field}`, english) : english;
}

/** What KIND of node this is — the node editor's heading. */
export const nodeTypeLabel = (type: string, t: Translate | null = null) => read(type, 'typeLabel', t);
/** The name a freshly dropped node of this type gets. */
export const nodeDefaultLabel = (type: string, t: Translate | null = null) => read(type, 'defaultLabel', t);
/** One or two plain sentences: what does this node do? */
export const nodeHelp = (type: string, t: Translate | null = null) => read(type, 'help', t);
/** The palette's invitation to pick this node (empty for types you cannot add). */
export const nodeLabel = (type: string, t: Translate | null = null) => read(type, 'label', t);
/** The palette's one-line description. */
export const nodeDesc = (type: string, t: Translate | null = null) => read(type, 'desc', t);

/** The visual family of a type — null for an exempt or unknown one. */
export function stepFamily(type: string | null | undefined): NodeFamily | null {
    if (!type) return null;
    return own(type)?.family ?? null;
}

/** The node's record, or undefined for a type this build does not know. */
export function nodeDef(type: string | null | undefined): NodeDef | undefined {
    return type ? own(type) : undefined;
}
