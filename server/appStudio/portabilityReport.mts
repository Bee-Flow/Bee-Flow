/**
 * App Studio: what a copy of an app (a template, a template file, an app archive, a Blueprint)
 * says about the parts that live outside its screens, so the person installing it is told:
 *
 *   assets        uploaded files carried, and the ones that were left out (portableAssets.mts)
 *   triggers      `definition.triggers` travel as written, but a copy never ARMS one: only a
 *                 publish or a Solution stage deploy does (triggers/triggerSync.mts). A webhook's
 *                 address and secret are not part of the definition and never travel; the next
 *                 publish makes new ones (triggers/webhook/webhookEndpoints.mts).
 *   columnRights  a field's `access` that names a role the copy's data model does not declare:
 *                 the list is kept as written (it then gives that role nothing) and named here,
 *                 never dropped in silence.
 *
 * Emit-when-present: a copy that holds none of these has no summary (null) and no extra
 * warning, so its report is what it was before.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface PortableSummary {
    assets?: { carried: number; left: number };
    triggers?: { count: number; webhooks: number; armed: false };
    columnRights?: { unknownRoles: string[] };
}

/** The triggers of a definition: how many, and how many are webhooks. */
export function triggerCounts(definition: unknown): { count: number; webhooks: number } {
    const list = isObject(definition) && Array.isArray(definition.triggers) ? definition.triggers.filter(isObject) : [];
    return { count: list.length, webhooks: list.filter((t) => t.kind === 'webhook').length };
}

/** "<table> field "<key>" names the role "<role>"…" for every field access list naming a role the model lacks. */
export function unknownAccessRoles(model: unknown): string[] {
    if (!isObject(model) || !Array.isArray(model.tables)) return [];
    const { tableColumnRightsFindings } = nodeRequire('../core/dataEngine/columnRightsSave.mts') as {
        tableColumnRightsFindings: (t: unknown, at: string, roles: unknown) => { warnings: string[] };
    };
    const out: string[] = [];
    for (const table of model.tables.filter(isObject)) {
        out.push(...tableColumnRightsFindings(table, `Table "${String(table.key ?? table.id ?? '')}"`, model.roles).warnings);
    }
    return out;
}

/**
 * The summary and the sentences for a copy's report. `assets` is what the copy carried and what
 * it had to leave out (null when the copy was not asked to carry files).
 */
export function portabilityReport(definition: unknown, model: unknown, assets: { carried: number; left: string[] } | null): { summary: PortableSummary | null; warnings: string[] } {
    const summary: PortableSummary = {};
    const warnings: string[] = [];
    if (assets && (assets.carried || assets.left.length)) {
        summary.assets = { carried: assets.carried, left: assets.left.length };
        for (const why of assets.left.slice(0, 5)) warnings.push(`Uploaded file left out: ${why}.`);
        if (assets.left.length > 5) warnings.push(`…and ${assets.left.length - 5} more uploaded file(s) left out.`);
    }
    // Not a warning: nothing went wrong. The import dialog says it from the summary, in the reader's language.
    const { count, webhooks } = triggerCounts(definition);
    if (count) summary.triggers = { count, webhooks, armed: false };
    const unknownRoles = unknownAccessRoles(model);
    if (unknownRoles.length) {
        summary.columnRights = { unknownRoles };
        for (const line of unknownRoles.slice(0, 5)) warnings.push(`Column rights: ${line}; that role gets nothing until the app has it.`);
    }
    return { summary: Object.keys(summary).length ? summary : null, warnings };
}
