/**
 * The last auto-map pass for a step that already runs once per item: the
 * item's OWN id for the input that asks for it (`orderId` while the step runs
 * per order, `messageId` per mail), required inputs only, once.
 *
 * Without it, an attachment's `messageId` inside the item looked like the
 * only source and moved "mark as read" into the attachments. With it, but
 * without asking whether the key names the item, a per-mail Slack post got
 * channelId = the mail's id and a per-mail Jira issue projectId = the mail's
 * id: confident values that fail at run time or, worse, hit the wrong
 * resource. Left empty, the author is asked (what the item IS:
 * autoMapEntity.ts). An id the item carries for something else
 * (`project.id`) is matched by name and schema before this.
 *
 * Pure. Mirrored by the phone's bindings/autoMapOwnItem.ts.
 */
import { pathKeys } from '@shared/expr/path.mjs';
import { namesRecord, recordIdOf } from './autoMapEntity';
import { idAffinityBase, sampleType, typeCompatible } from './autoMapIteration';
import { pathInUse, usedPathsIn } from './boundPaths';
import { groupValueFields } from './deepFields';
import type { UpstreamGroup } from './deepFields';
import { isEmptyBinding } from './partitionInputs';

interface Schema { properties?: Record<string, { type?: unknown } | undefined>; required?: string[] }
type Binding = { kind: 'ref'; path: string };

/**
 * Does another id input (`labelId`, `id`) already hold the item's id, as a ref
 * or inside a template? Then the item's id role is taken: "add label" never
 * gets the message id a second time as its labelId. Text that merely mentions
 * the id (a note) does not count.
 */
function idRoleTaken(idPath: string, inputs: Record<string, unknown>): boolean {
    return Object.entries(inputs).some(([k, b]) => /id$/i.test(k) && pathInUse(idPath, usedPathsIn({ inputs: { [k]: b } })));
}

/** Add the item's own id to `patch` for the one required input that names the item, if any. */
export function ownItemIdPatch(
    { keys, schema, existing, groups }: { keys: string[]; schema: Schema | null | undefined; existing: Record<string, unknown>; groups: UpstreamGroup[] | null | undefined },
    patch: Record<string, Binding>,
): void {
    const own = [...(groups || [])].reverse().find(g => g.ownItem && !String(g.id || '').includes('__parent_'));
    if (!own) return;
    // What the item is: its name (`loop.order` → order) and its record.
    const itemVar = (pathKeys(String(own.basePath || '')) || [])[1];
    const id = recordIdOf(groupValueFields(own), String(own.basePath || ''), own.sample, typeof itemVar === 'string' ? [itemVar] : []);
    if (!id || idRoleTaken(id.field.path, { ...existing, ...patch })) return;
    const required = new Set(schema?.required || []);
    const key = keys.find(k => required.has(k) && !patch[k] && isEmptyBinding(existing[k]) && namesRecord(idAffinityBase(k), id.words)
        && typeCompatible(schema?.properties?.[k]?.type, sampleType(id.field.sample)));
    if (key) patch[key] = { kind: 'ref', path: id.field.path };
}
