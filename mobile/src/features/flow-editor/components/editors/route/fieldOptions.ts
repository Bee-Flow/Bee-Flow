/**
 * The named fields a Condition rule is built from — the web's
 * ruleFieldMenu / upstreamFieldOptions (routeEditors.jsx), pure — and the
 * "current item" scope a per-item rule is written in: an `item` group, and a
 * sample root where `item.<field>` resolves, so datatypes infer and the
 * variable picker offers the row's fields.
 */

import type { TranslateFn } from '@/core/i18n';
import { fieldLabelText, sampleToFields, type VariableGroup } from '@/features/flow-editor/bindings';
import { humanizeFieldKey } from '@/features/flow-editor/model';
import { ruleFieldOptions } from '@/shared/expr';

export interface FieldOption {
    path: string;
    label: string;
    sample: unknown;
    group: string;
    /** A column of a list inside the item: the row asks "any / every / no …" first. */
    quantified?: true;
    /** A list of records ("has at least one / has none"), or the virtual File type field. */
    kind?: 'records' | 'fileType';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

type Named = { key: string; path: string; sample: unknown; label?: string; labelKey?: string };

const english: TranslateFn = (_key, fallback) => fallback;

function flatten(fields: readonly (Named & { children?: Named[] })[], group: string, t: TranslateFn): FieldOption[] {
    // A field's own label where its key is internal (a Condition's `matchesByCase.<name>`), else the key in words.
    const nameOf = (f: Named): string => fieldLabelText(f, t) || humanizeFieldKey(f.key);
    const out: FieldOption[] = [];
    for (const f of fields) {
        out.push({ path: f.path, label: nameOf(f), sample: f.sample, group });
        for (const c of f.children || []) {
            out.push({ path: c.path, label: `${nameOf(f)} · ${nameOf(c)}`, sample: c.sample, group });
        }
    }
    return out;
}

/**
 * The rule menu in list mode (R1), from the shared ruleFieldOptions: the
 * item's own fields ("Fields of each message"), a list of records once
 * ("Attachments": has at least one / has none), then per list of records
 * a group ("Attachments of each message") with File type first and its
 * columns, which the row asks a quantifier for. A list column is never a
 * plain field.
 */
export function itemFieldOptions(elementSample: unknown, itemName: string, t: TranslateFn): FieldOption[] {
    if (!isObj(elementSample)) return [];
    const group = (kind: 'item' | 'inner' | 'parent', vars: Record<string, string>): string => {
        if (kind === 'inner') return t('condition_node.group.inner_list', '{list} of each {name}', vars);
        if (kind === 'parent') return t('condition_node.group.parent', 'The {name} it came from', vars);
        return t('condition_node.group.item', 'Fields of each {name}', vars);
    };
    return ruleFieldOptions(sampleToFields(elementSample, 'item'), {
        element: elementSample,
        name: humanizeFieldKey,
        group,
        itemName,
        fileTypeLabel: t('condition_node.file_type.label', 'File type'),
    });
}

/** Every upstream step's fields, grouped by step — the options when deciding about the whole run. */
export function upstreamFieldOptions(groups: readonly VariableGroup[] | null | undefined, t: TranslateFn = english): FieldOption[] {
    return (groups || []).flatMap((g) => flatten(g.fields || [], g.label, t));
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
