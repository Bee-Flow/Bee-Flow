/**
 * The form-pick sources registry — what an `app_pick` question can pick from,
 * and the structured `sampleData` a picked record carries. Port of agent-hub
 * `Builder/flow/pickSourceCatalog.js` minus its fetch: the web module loads
 * GET /api/automation/catalog/form-pick-sources itself, while here the api
 * layer hands the answer in through `setPickSources`. Before it has, samples
 * simply have no `data` rows — fewer rows, never wrong ones.
 */

export interface PickSource {
    id: string;
    app?: string;
    sampleData?: Record<string, unknown>;
    [key: string]: unknown;
}

let cache: PickSource[] | null = null;

export function setPickSources(sources: unknown): void {
    cache = Array.isArray(sources) ? (sources as PickSource[]) : [];
}

export function pickSourcesSync(): PickSource[] {
    return cache || [];
}

export function pickSourceById(id: unknown): PickSource | null {
    return pickSourcesSync().find((s) => s.id === id) || null;
}

/** Test seam, as on the web. */
export function resetPickSources(): void {
    cache = null;
}
