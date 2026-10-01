/**
 * The source panel's model: the upstream groups the core describes
 * (`@shared/mapping` computeUpstreamGroups, through mapping/upstream.ts),
 * ordered and read the way the "Comes in" column shows them.
 *
 * Pure helpers plus one memoising hook, so SourcePanel and SourceNode only
 * draw. A node here is the core's SourceNode; groups built by older callers
 * (and tests) that carry only `{key, path, sample, children}` work too, read
 * by the same rules.
 */
import { useMemo } from 'react';
import {
    humanizeKey, labelText, textChildren, walkPath,
    type LabelPart, type Source, type SourceNode as CoreSourceNode,
} from '@shared/mapping/index.mjs';
import { filterGroups } from '../mapping/filterFields';

/** A row's node: the core's SourceNode, of which older groups carry only the first four keys. */
export type TreeNode = Pick<CoreSourceNode, 'key' | 'sample'> & {
    path: string | null;
    children?: TreeNode[];
    source?: Source | null;
    labelParts?: LabelPart[];
    shape?: CoreSourceNode['shape'];
    count?: number;
    preview?: string;
    confirmed?: boolean;
    fromText?: boolean;
    perIteration?: boolean;
};

export interface TreeGroup {
    id: string;
    label: string;
    kind?: string;
    basePath: string;
    sample?: unknown;
    fields?: TreeNode[];
    hasRealData?: boolean;
}

/** Is this the current loop item (`loop.<var>`), which the panel puts on top? */
export function isLoopItemGroup(group: Pick<TreeGroup, 'basePath'> | null | undefined): boolean {
    return String(group?.basePath || '').startsWith('loop.');
}

/**
 * Display order: the current loop item first, then the nearest step first.
 * `groups` arrive topological (trigger first, nearest last), so this is a
 * reversed COPY.
 */
export function orderGroups<G extends TreeGroup>(groups: readonly G[] | null | undefined): G[] {
    const copy = [...(groups || [])].reverse();
    return [...copy.filter(isLoopItemGroup), ...copy.filter(g => !isLoopItemGroup(g))];
}

/**
 * The name a person reads for a row: the last named part of its label, else
 * the key made readable. Never a path.
 */
export function nodeLabel(node: Pick<TreeNode, 'key' | 'labelParts'>): string {
    const parts = node.labelParts || [];
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i] as { text?: string };
        if (typeof p.text === 'string' && p.text) return p.text;
    }
    return humanizeKey(node.key) || String(node.key ?? '');
}

/** The whole label, for a tooltip: "Klant › Adres › Postcode". */
export function nodeTitle(node: Pick<TreeNode, 'key' | 'labelParts'>): string {
    return labelText(node.labelParts || []) || nodeLabel(node);
}

/**
 * The value a row shows: the real one (last run or pin, through the
 * preview sample) when its path resolves there, else the describer's sample.
 */
export function nodeValue(node: Pick<TreeNode, 'path' | 'sample'>, previewSample: unknown): unknown {
    if (previewSample && node.path) {
        const v = walkPath(node.path, previewSample);
        if (v !== undefined) return v;
    }
    return node.sample;
}

/**
 * A row's children: its own, or, for a JSON string, what the text holds
 * (read from the value the row shows, so a real response opens to its real
 * keys). Text children carry no legacy path: they are shown, not picked.
 */
export function nodeChildren(node: TreeNode, value: unknown): TreeNode[] {
    if (Array.isArray(node.children) && node.children.length) return node.children;
    if (typeof value !== 'string') return [];
    return textChildren({ ...node, sample: value }) as TreeNode[];
}

/** Does the last real run lack this key? */
export function isUnconfirmed(node: Pick<TreeNode, 'confirmed'>): boolean {
    return node.confirmed === false;
}

/**
 * The panel's groups in display order, narrowed by a search. Memoised on
 * its inputs.
 */
export function useSourceTree<G extends TreeGroup>(groups: readonly G[] | null | undefined, query: string) {
    const ordered = useMemo(() => orderGroups(groups), [groups]);
    const shown = useMemo(() => filterGroups(ordered, query) as G[], [ordered, query]);
    return { ordered, shown };
}
