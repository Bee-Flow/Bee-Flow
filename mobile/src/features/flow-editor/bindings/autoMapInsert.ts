/**
 * Auto-map for a step just added — BuildTab's addStepAt after its insert:
 * a step wired from a source has its inputs mapped from what comes before it,
 * with the last test run's real outputs; not while the author's "auto-map when
 * connecting" preference is off; and QUEUED (`awaitingCatalog`) when the
 * catalog has not answered yet, since auto-map never overwrites a binding and
 * can run late.
 */

import { applyAutoMapToStep } from './autoMapStep';
import type { Catalog } from './types';
import type { InsertResult } from '../model/outline/insert';

export interface InsertMapOptions {
    catalog?: Catalog | null;
    /** What each step really produced (realOutputs.ts), so fields only a run knows are seen. */
    realOutputById?: Map<string, unknown> | null;
    /** The "Auto-map step inputs when connecting" preference. */
    autoMap?: boolean;
}

export interface MappedInsert extends InsertResult {
    /** How many inputs auto-map filled (for the toast). Auto-map never switches a per-item run on. */
    mapped: number;
    awaitingCatalog: boolean;
}

export function autoMapInserted(result: InsertResult, { catalog = null, realOutputById = null, autoMap = true }: InsertMapOptions = {}): MappedInsert {
    const plain: MappedInsert = { ...result, mapped: 0, awaitingCatalog: false };
    if (!result.wired || !autoMap || !result.addedId) return plain;
    if (!catalog) return { ...plain, awaitingCatalog: true };
    const { definition, mappedKeys } = applyAutoMapToStep(result.definition, result.addedId, catalog, { realOutputById });
    return { ...plain, definition, mapped: mappedKeys.length };
}
