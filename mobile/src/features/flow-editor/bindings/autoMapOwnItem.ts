/**
 * The last auto-map pass for a step that already runs once per item: the
 * item's OWN id for the input that asks for it (`orderId` per order,
 * `messageId` per mail), required inputs only, once — and only for a key that
 * names the item (what the item IS: autoMapEntity.ts). A per-mail Slack
 * post's channelId is not the mail's id; left empty, the author is asked.
 * Port of agent-hub `Builder/mapping/autoMapOwnItem.ts`; pinned by
 * autoMap.lockstep.test.ts.
 */

import { pathKeys } from '@/shared/expr';

import { namesRecord, recordIdOf } from './autoMapEntity';
import { idAffinityBase, sampleType, typeCompatible } from './autoMapIteration';
import { pathInUse, usedPathsIn } from './boundPaths';
import { groupValueFields } from './deepFields';
import { isEmptyBinding } from './partitionInputs';
import type { Binding, JsonSchema, VariableGroup } from './types';

/** Does another id input (`labelId`, `id`) already hold the item's id, as a ref or inside a template? */
function idRoleTaken(idPath: string, inputs: Record<string, unknown>): boolean {
    return Object.entries(inputs).some(([k, b]) => /id$/i.test(k) && pathInUse(idPath, usedPathsIn({ inputs: { [k]: b } })));
}

/** Add the item's own id to `patch` for the one required input that names the item, if any. */
export function ownItemIdPatch(
    { keys, schema, existing, groups }: { keys: string[]; schema: JsonSchema | null | undefined; existing: Record<string, unknown>; groups: VariableGroup[] | null | undefined },
    patch: Record<string, Binding>,
): void {
    const own = [...(groups || [])].reverse().find((g) => (g as VariableGroup & { ownItem?: boolean }).ownItem && !String(g.id || '').includes('__parent_'));
    if (!own) return;
    // What the item is: its name (`loop.order` → order) and its record.
    const itemVar = (pathKeys(String(own.basePath || '')) || [])[1];
    const id = recordIdOf(groupValueFields(own), String(own.basePath || ''), own.sample, typeof itemVar === 'string' ? [itemVar] : []);
    if (!id || idRoleTaken(id.field.path, { ...existing, ...patch })) return;
    const required = new Set(schema?.required || []);
    const key = keys.find((k) => required.has(k) && !patch[k] && isEmptyBinding(existing[k]) && namesRecord(idAffinityBase(k), id.words)
        && typeCompatible((schema?.properties?.[k] as { type?: unknown } | undefined)?.type, sampleType(id.field.sample)));
    if (key) patch[key] = { kind: 'ref', path: id.field.path };
}
