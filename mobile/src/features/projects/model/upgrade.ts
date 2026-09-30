/**
 * Updating a Solution to a newer Blueprint: whether one exists, and what the
 * server's plan means — a port of the pure half of the web's
 * admin/Studio/Solutions/upgradeClient.jsx, held to it by
 * upgrade.lockstep.test.ts.
 *
 * The plan comes BEFORE the button. `plan.skip` means two different things
 * and the server puts both in one list: "we compared it and you changed it"
 * (possible only for the kinds the upgrade can hash, COMPARED_KINDS), and "we
 * never compared it" (a table or a knowledge base, which hold live data). A
 * row is claimed as the first only when BOTH signals say so; otherwise it
 * reads as undetermined — the side that promises too little.
 */

import type { BlueprintMeta, PlanRow, PlanRows, UpgradeReport } from './package';

/** Mirror of REPLACEABLE_KINDS in server/projects/packaging/upgrade.js. */
export const COMPARED_KINDS: ReadonlySet<string> = new Set(['automation', 'app', 'webpage', 'agent']);

/** The entity lists of a manifest. */
const ENTITY_LISTS = ['automations', 'apps', 'webpages', 'datatables', 'agents', 'knowledgeBases'] as const;

/** Equal versions are NOT an upgrade — the rule of isNewer in packaging/upgrade.js. */
export function isNewer(installedVersion: number | null, blueprintVersion: number | null): boolean {
    return Number.isInteger(blueprintVersion) && (blueprintVersion as number) > (installedVersion || 0);
}

export type Availability =
    | { state: 'none' | 'unknown'; blueprintId: null; installedVersion: null; latestVersion: null }
    | { state: 'available' | 'current'; blueprintId: string; installedVersion: number; latestVersion: number };

const NONE: Availability = { state: 'none', blueprintId: null, installedVersion: null, latestVersion: null };
const UNKNOWN: Availability = { state: 'unknown', blueprintId: null, installedVersion: null, latestVersion: null };

/**
 * May this reader be told about a newer version? The Blueprint is looked up
 * in the ORG-SCOPED gallery listing; not found (deleted, or another
 * organisation's) is `unknown`, never `available` — a banner promising an
 * update for a Blueprint you may not see would reveal that it exists. And a
 * missing installed version is `unknown` too: `|| 0` there would make every
 * v1 "newer".
 */
export function updateAvailability(input: {
    installedFromBlueprintId: string | null;
    installedVersion: number | null;
    blueprints: readonly BlueprintMeta[] | null | undefined;
}): Availability {
    const id = input.installedFromBlueprintId || null;
    if (!id) return NONE;
    if (!input.blueprints) return UNKNOWN;
    const found = input.blueprints.find((b) => b.id === id);
    if (!found) return UNKNOWN;
    const latest = Number.isInteger(found.version) && found.version > 0 ? found.version : null;
    const installed = Number.isFinite(input.installedVersion) ? Math.trunc(input.installedVersion as number) : null;
    if (latest === null || installed === null) return UNKNOWN;
    return {
        state: isNewer(installed, latest) ? 'available' : 'current',
        blueprintId: id,
        installedVersion: installed,
        latestVersion: latest,
    };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Ref → readable name, from the manifest the plan carries. */
export function nameIndex(manifest: unknown): Map<string, string> {
    const index = new Map<string, string>();
    const solution = isObject(manifest) ? manifest.solution : null;
    const entities = isObject(solution) ? solution.entities : null;
    if (!isObject(entities)) return index;
    for (const plural of ENTITY_LISTS) {
        for (const entity of list(entities[plural])) {
            if (!isObject(entity) || !str(entity.ref)) continue;
            const name = [entity.name, entity.title, entity.key].find((v) => typeof v === 'string' && v.trim());
            index.set(str(entity.ref), (typeof name === 'string' ? name : str(entity.ref)).trim());
        }
    }
    return index;
}

function rowOf(item: unknown, index: Map<string, string>): PlanRow {
    const ref = isObject(item) ? str(item.ref) : '';
    return { ref, kind: isObject(item) ? str(item.kind) : '', name: index.get(ref) || ref };
}

/** The four server lists (add, replace, skip, missing) as five named groups. */
export function planRows(body: unknown): PlanRows {
    const plan = isObject(body) && isObject(body.plan) ? body.plan : {};
    const index = nameIndex(isObject(body) ? body.manifest : null);
    const kept: PlanRow[] = [];
    const undetermined: PlanRow[] = [];
    for (const item of list(plan.skip)) {
        const row = rowOf(item, index);
        const saysEdited = isObject(item) && /\bedited\b/i.test(str(item.why));
        (COMPARED_KINDS.has(row.kind) && saysEdited ? kept : undetermined).push(row);
    }
    return {
        added: list(plan.add).map((i) => rowOf(i, index)),
        changed: list(plan.replace).map((i) => rowOf(i, index)),
        kept,
        undetermined,
        gone: list(plan.missing).map((i) => rowOf(i, index)),
    };
}

/** Does this plan change anything? Otherwise the confirmation is an empty act. */
export function planTouchesNothing(rows: PlanRows): boolean {
    return rows.added.length === 0 && rows.changed.length === 0;
}

/** The report, from an allow-list: counts, plus the server's own sentences. */
export function readReport(report: unknown): UpgradeReport {
    const r = isObject(report) ? report : {};
    const added = isObject(r.added) ? r.added : {};
    return {
        replaced: list(r.replaced).length,
        added: Object.values(added).reduce<number>((n, v) => n + list(v).length, 0),
        failed: list(r.failed)
            .filter(isObject)
            .map((f) => ({ ref: str(f.ref), why: str(f.why) })),
        warnings: list(r.warnings).filter((s): s is string => typeof s === 'string' && s.length > 0),
    };
}
