/**
 * The named fields a Condition rule is built from — the web's
 * itemFieldOptions / upstreamFieldOptions (routeEditors.jsx), pure — and the
 * "current item" scope a per-item rule is written in: an `item` group, and a
 * sample root where `item.<field>` resolves, so datatypes infer and the
 * variable picker offers the row's fields.
 */

import { sampleToFields, type VariableGroup } from '@/features/flow-editor/bindings';
import { humanizeFieldKey } from '@/features/flow-editor/model';

export interface FieldOption {
    path: string;
    label: string;
    sample: unknown;
    group: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function flatten(fields: readonly { key: string; path: string; sample: unknown; children?: { key: string; path: string; sample: unknown }[] }[], group: string): FieldOption[] {
    const out: FieldOption[] = [];
    for (const f of fields) {
        out.push({ path: f.path, label: humanizeFieldKey(f.key), sample: f.sample, group });
        for (const c of f.children || []) {
            out.push({ path: c.path, label: `${humanizeFieldKey(f.key)} · ${humanizeFieldKey(c.key)}`, sample: c.sample, group });
        }
    }
    return out;
}

/** The fields of ONE item of the source list, one level deep ("Subject", "From · email"). */
export function itemFieldOptions(elementSample: unknown, group: string): FieldOption[] {
    if (!isObj(elementSample)) return [];
    return flatten(sampleToFields(elementSample, 'item'), group);
}

/** Every upstream step's fields, grouped by step — the options when deciding about the whole run. */
export function upstreamFieldOptions(groups: readonly VariableGroup[] | null | undefined): FieldOption[] {
    return (groups || []).flatMap((g) => flatten(g.fields || [], g.label));
}

/** The groups and sample root a per-item rule sees; null when the list has no sample yet. */
export function itemScope(
    elementSample: unknown,
    around: { groups: readonly VariableGroup[]; sampleRoot: unknown },
    label: string,
    extra: Obj = {},
): { groups: VariableGroup[]; sampleRoot: Obj } | null {
    const { groups, sampleRoot } = around;
    if (elementSample == null) return null;
    const itemGroup: VariableGroup = {
        id: '__route_item',
        label,
        kind: 'loop',
        basePath: 'item',
        sample: elementSample,
        fields: isObj(elementSample) ? sampleToFields(elementSample, 'item') : [],
    };
    return { groups: [itemGroup, ...groups], sampleRoot: { ...(isObj(sampleRoot) ? sampleRoot : {}), item: elementSample, ...extra } };
}
