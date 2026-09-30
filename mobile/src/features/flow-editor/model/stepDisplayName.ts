/**
 * The display identity of the two nodes renamed away from their runtime type
 * names, and their search keywords — a port of the web builder's
 * flow/stepDisplayName.js, pinned by labels.lockstep.test.ts.
 *
 * Each keyword list keeps the words the node was ONCE called, so someone who
 * knows the old name (or the n8n one) still finds it.
 */

import { NODE_DEFS } from './nodeDefs';

/** "Edit data" (runtime type `set`). */
export const SET_STEP_NAME = NODE_DEFS.set?.defaultLabel as string;
export const SET_STEP_DESC = NODE_DEFS.set?.desc as string;

/** The unified deciding step (runtime types condition / switch / filter). */
export const ROUTE_STEP_NAME = NODE_DEFS.condition?.defaultLabel as string;
export const ROUTE_STEP_DESC = NODE_DEFS.condition?.desc as string;

export const ROUTE_STEP_KEYWORDS = 'if condition switch case filter route branch keep drop guard where match else multiway split';
export const SET_STEP_KEYWORDS = 'set edit fields data table rows columns assign rename restructure mapping group id number sort parse json extract path body response';
