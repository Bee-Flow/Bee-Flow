/**
 * The model behind the "Now running · last 24 hours" strip. The logic is the
 * web's `agent-hub/src/components/admin/Studio/Runs/nowRunning.ts`, generated
 * into mirror/ by scripts/gen-shared-mirror.mjs (npm run gen:shared; npm run
 * lint:shared-mirror fails on a stale copy). Change the web file, never the
 * mirror.
 *
 * The one phone-only part is here: the phone's `RunFacets` says "no rollup" as
 * `automations: null` and `automationsTotal: null`, the web's facets as an
 * absent key. Both mean the same to the mirrored code (it only asks
 * `Array.isArray` / `Number.isFinite`), so the adapters below turn null into
 * absent and nothing else.
 */

import type { RunFacets } from './types';
import {
    nowRunningLines as mirroredLines,
    readRollups as mirroredRollups,
    type NowRunningFacets,
    type NowRunningLine,
    type NowRunningRollup,
} from '../mirror/nowRunning';

export { NOW_RUNNING_LIMIT, NOW_RUNNING_TONES, toLine } from '../mirror/nowRunning';
export type { NowRunningLine, NowRunningTone } from '../mirror/nowRunning';

export interface NowRunningModel {
    lines: NowRunningLine[];
    total: number;
    hidden: number;
}

function webFacets(facets: RunFacets | null | undefined): NowRunningFacets | null | undefined {
    if (!facets) return facets;
    return { automations: facets.automations ?? undefined, automationsTotal: facets.automationsTotal ?? undefined };
}

/** The rollups, or null when there are none to read (the strip says nothing then). */
export function readRollups(facets: RunFacets | null | undefined): NowRunningRollup[] | null {
    return mirroredRollups(webFacets(facets));
}

/** The strip, or null when the rollup could not be read. */
export function nowRunningLines(facets: RunFacets | null | undefined, options: { limit?: number } = {}): NowRunningModel | null {
    return mirroredLines(webFacets(facets), options);
}
