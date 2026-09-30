/**
 * Every declarative spec, by the runtime step type it edits. The three
 * Privacy Shield types share one spec, as they share one editor on the web.
 */

import type { EditorSpec } from '../spec';
import { CALL_BLOCK, CALL_LAYER } from './calls';
import { DATETIME } from './datetime';
import { FILL_DOCUMENT, GENERATE_DOCUMENT } from './documents';
import { LAYER_OUTPUT, RETURN_TO_APP, STOP_ERROR } from './end';
import { DATA_EXTRACTION } from './extraction';
import { INTEGRATION_ACTION } from './integration';
import { KNOWLEDGE_WRITE } from './knowledge';
import { AGGREGATE, DEDUPE, LIMIT, SUMMARIZE } from './lists';
import { NOTE } from './note';
import { NOTIFICATION, WAIT } from './pause';
import { PRESENTATION } from './presentation';
import { PRIVACY } from './privacy';
import { SLIDE } from './slide';

const ALL: readonly EditorSpec[] = [
    WAIT, NOTIFICATION, LIMIT, DEDUPE, AGGREGATE, SUMMARIZE, DATETIME, STOP_ERROR, RETURN_TO_APP, LAYER_OUTPUT,
    KNOWLEDGE_WRITE, DATA_EXTRACTION, GENERATE_DOCUMENT, FILL_DOCUMENT, SLIDE, PRESENTATION, CALL_BLOCK, CALL_LAYER,
    NOTE, INTEGRATION_ACTION,
];

export const SPECS: Readonly<Record<string, EditorSpec>> = {
    ...Object.fromEntries(ALL.map((s) => [s.type, s])),
    guard: PRIVACY,
    tokenize: { ...PRIVACY, type: 'tokenize' },
    untokenize: { ...PRIVACY, type: 'untokenize' },
};

export function specFor(type: string | null | undefined): EditorSpec | null {
    const key = String(type ?? '');
    return Object.prototype.hasOwnProperty.call(SPECS, key) ? (SPECS[key] as EditorSpec) : null;
}

export const hasSpec = (type: string | null | undefined): boolean => specFor(type) !== null;

export { droppedEdgesOnModeChange, PII_CATEGORY_KEYS, PRIVACY_MODE_WORDS, categoriesOn, categoriesPatch } from './privacy';
export { findActionAndSiblings, switchOperation } from './integration';
export { layerContract, blockContract } from './calls';
export { NOTE_COLORS } from './note';
export { CHART_TYPES, SLIDE_LAYOUTS, SLIDE_VISUALS } from './slide';
export { DECK_FONTS } from './presentation';
export { FALLBACK_STRATEGIES } from './knowledge';
