/**
 * Auto-map for a step just added — BuildTab's addStepAt after its insert:
 * a step wired from a source has its inputs mapped from what comes before it,
 * with the last test run's real outputs; not while the author's "auto-map when
 * connecting" preference is off; and QUEUED (`awaitingCatalog`) when the
 * catalog has not answered yet, since auto-map never overwrites a binding and
 * can run late.
 *
 * Then, auto-map or not, the route is followed (shared routeFollow.mjs): a
 * Condition put between a list and the step reading it makes that step read
 * what the Condition keeps, and a step added after a Condition's output reads
 * that output — in the same edit, so one undo takes both back.
 */

import { followRouteAround, parsePath } from '@/shared/expr';

import { applyAutoMapToStep } from './autoMapStep';
import type { Catalog } from './types';
import type { InsertResult } from '../model/outline/insert';

type Definition = InsertResult['definition'];

export interface InsertMapOptions {
    catalog?: Catalog | null;
    /** What each step really produced (realOutputs.ts), so fields only a run knows are seen. */
    realOutputById?: Map<string, unknown> | null;
    /** The "Auto-map step inputs when connecting" preference. */
    autoMap?: boolean;
}

/** One step re-pointed at a Condition's output: it read `from`, it now reads `to`. */
export interface Rebound {
    stepId: string;
    from: string;
    to: string;
}

export interface MappedInsert extends InsertResult {
    /** How many inputs auto-map filled (for the toast). */
    mapped: number;
    /** Auto-map switched on "for each item". */
    forEach: boolean;
    awaitingCatalog: boolean;
    /** The steps now reading what a Condition keeps (for the toast). */
    rebound: Rebound[];
}

/** The definition with the route around `stepId` followed, and who was re-pointed. */
export function followAround(definition: Definition, stepId: string): { definition: Definition; rebound: Rebound[] } {
    const out = followRouteAround(definition, stepId);
    return { definition: out.definition as Definition, rebound: out.rebound };
}

/** The Condition a re-pointed step now reads: the step id in `steps.<id>.output…`. */
export function reboundRouteId(r: Rebound): string | null {
    const tokens = parsePath(r.to);
    const id = tokens?.[0]?.type === 'prop' && tokens[0].key === 'steps' ? tokens[1] : null;
    return id && id.type === 'prop' ? String(id.key) : null;
}

export function autoMapInserted(result: InsertResult, { catalog = null, realOutputById = null, autoMap = true }: InsertMapOptions = {}): MappedInsert {
    const plain: MappedInsert = { ...result, mapped: 0, forEach: false, awaitingCatalog: false, rebound: [] };
    if (!result.wired || !result.addedId) return plain;
    if (!autoMap || !catalog) {
        const followed = followAround(result.definition, result.addedId);
        return { ...plain, ...followed, awaitingCatalog: autoMap && !catalog };
    }
    const { definition, mappedKeys, forEachEnabled } = applyAutoMapToStep(result.definition, result.addedId, catalog, { realOutputById });
    const followed = followAround(definition, result.addedId);
    return { ...plain, ...followed, mapped: mappedKeys.length, forEach: forEachEnabled };
}
