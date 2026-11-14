/**
 * app_remove_dataset { datasetId }: delete one of the app's datasets. Like app_remove_table it
 * refuses while the definition still uses the dataset (a dataset binding on a component, a
 * dataset_query step, anything that carries its datasetId) and names those places. The dataset
 * row and its cache go through the store's own delete, scoped to this app and its owner.
 */

import { createRequire } from 'node:module';
import { pickClosestId } from '../../utils/closestId.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Node = Obj & { id?: string; children?: Node[] };
type Def = Obj & { screens?: (Obj & { sections?: (Obj & { children?: Node[] })[] })[]; actions?: Record<string, unknown> };
type DatasetEntry = { id: string; name?: string } | string;
type Draft = { def: Def; appId?: string | null; userId: string; datasetIds?: DatasetEntry[] } & Obj;
type Result = Obj & { error?: string; _fixHint?: string };

export type RemoveDatasetDeps = { deleteDataset: (id: string, appId: string, userId: string) => Promise<boolean> };

const MAX_LISTED = 8;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const idOf = (d: DatasetEntry): string => (typeof d === 'string' ? d : d?.id);

function defaultDeps(): RemoveDatasetDeps {
    return { deleteDataset: (id, appId, userId) => nodeRequire('../../stores/studioAppDataStore').deleteDataset(id, appId, userId) };
}

/** True when `value` holds an object whose datasetId is `id`. */
function carries(value: unknown, id: string): boolean {
    if (Array.isArray(value)) return value.some((v) => carries(v, id));
    if (!isObject(value)) return false;
    if (value.datasetId === id) return true;
    return Object.values(value).some((v) => carries(v, id));
}

/** Every place of the definition that uses dataset `id`. */
export function findDatasetRefs(def: Def, id: string): string[] {
    const out: string[] = [];
    const walk = (nodes: Node[] | undefined): void => {
        for (const n of Array.isArray(nodes) ? nodes : []) {
            const { children, ...own } = n;
            if (carries(own, id)) out.push(`component ${String(n.id)}`);
            walk(children);
        }
    };
    for (const screen of Array.isArray(def.screens) ? def.screens : []) {
        for (const sec of screen.sections || []) walk(sec.children);
    }
    for (const [actionId, action] of Object.entries(def.actions || {})) if (carries(action, id)) out.push(`action ${actionId}`);
    for (const [key, value] of Object.entries(def)) if (key !== 'screens' && key !== 'actions' && carries(value, id)) out.push(key);
    return out;
}

export async function applyRemoveDataset(draftWrap: Draft, args: unknown, deps: RemoveDatasetDeps = defaultDeps()): Promise<Result> {
    const datasetId = isObject(args) && typeof args.datasetId === 'string' ? args.datasetId : '';
    const known = (Array.isArray(draftWrap.datasetIds) ? draftWrap.datasetIds : []).filter(Boolean);
    const entry = known.find((d) => idOf(d) === datasetId);
    if (!entry || !draftWrap.appId) {
        const ids = known.map(idOf);
        const suggestion = pickClosestId(datasetId, ids);
        return { error: `Unknown datasetId ${JSON.stringify(isObject(args) ? args.datasetId ?? null : null)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, _fixHint: `The app's datasets: ${ids.join(', ') || '(none)'}.` };
    }
    const refs = findDatasetRefs(draftWrap.def, datasetId);
    if (refs.length) {
        return {
            error: `Cannot remove ${datasetId} — the definition still uses it: ${refs.slice(0, MAX_LISTED).join(', ')}${refs.length > MAX_LISTED ? ` and ${refs.length - MAX_LISTED} more` : ''}.`,
            _fixHint: 'Re-bind or remove those components and steps first, then remove the dataset.',
        };
    }
    let removed = false;
    try {
        removed = await deps.deleteDataset(datasetId, draftWrap.appId, draftWrap.userId);
    } catch (e) {
        return { error: `Could not remove the dataset: ${(e as Error).message}` };
    }
    if (!removed) return { error: `The dataset ${datasetId} could not be removed: it is not one of this app's datasets that you own.`, _fixHint: 'Ask the app owner to remove it.' };
    draftWrap.datasetIds = known.filter((d) => idOf(d) !== datasetId);
    return { removed: datasetId, ...(typeof entry === 'object' && entry.name ? { name: entry.name } : {}), datasets: draftWrap.datasetIds.length };
}
