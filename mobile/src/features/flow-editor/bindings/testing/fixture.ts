/**
 * Test-only: the shared definition + catalog fixture (flow.fixture.json),
 * wired as one straight chain so every step sees every step before it.
 */

import raw from './flow.fixture.json';
import type { Catalog, FlowDefinition, FlowNode } from '../types';

export const CATALOG = raw.catalog as unknown as Catalog;

/** A fresh copy of the fixture definition, trigger → step 1 → … → last. */
export function chainDefinition(): FlowDefinition {
    const def = JSON.parse(JSON.stringify(raw.definition)) as FlowDefinition;
    const ids = [(def.trigger as FlowNode).id, ...(def.steps || []).map((s) => s.id)];
    def.edges = ids.slice(1).map((to, i) => ({ from: ids[i] as string, to }));
    return def;
}

