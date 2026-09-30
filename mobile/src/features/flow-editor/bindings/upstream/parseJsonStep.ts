/**
 * parse_json's output: a FLAT `{ <fieldName>: value }`, or in grouped mode
 * ("one row per entry") `{ items, count }`. Each field's relative path is
 * resolved against the real source when there is one, so downstream previews
 * show actual values. Split out of collectionSteps (agent-hub
 * `Builder/mapping/upstream/collectionSteps.js` describeParseJson).
 */

import { translate as t } from '@/core/i18n';
import { nodeDefaultLabel } from '@/features/flow-editor/model/nodeDefs';

import { arr } from '../json';
import type { FlowNode, VariableGroup } from '../types';
import { walkPath, walkRelativePath } from '../walkPath';
import { stepGroup } from './sampleFields';

interface ParseField {
    name: string;
    path?: string;
    fallback?: unknown;
}

function sourceOf(node: FlowNode, sampleRoot: unknown): unknown {
    if (!sampleRoot || !node.sourceRef) return undefined;
    const src = walkPath(node.sourceRef, sampleRoot);
    if (typeof src !== 'string') return src;
    try {
        return JSON.parse(src);
    } catch {
        return undefined;
    }
}

function rowFrom(fields: ParseField[], root: unknown): Record<string, unknown> {
    return Object.fromEntries(
        fields.map((f) => {
            const v = root !== undefined ? walkRelativePath(f.path, root) : undefined;
            if (v !== undefined) return [f.name, v];
            return [f.name, f.fallback !== undefined ? f.fallback : '<extracted>'];
        }),
    );
}

export function describeParseJson(node: FlowNode, sampleRoot: unknown = null): VariableGroup {
    const fields = arr<ParseField>(node.fields).filter((f) => f && f.name);
    const src = sourceOf(node, sampleRoot);
    const itemsRef = typeof node.itemsRef === 'string' ? node.itemsRef.trim() : '';
    const label = node.label || nodeDefaultLabel('parse_json', t);
    if (!itemsRef) return stepGroup(node, { label, kind: 'parse_json' }, rowFrom(fields, src));
    const list = src !== undefined ? walkRelativePath(itemsRef, src) : undefined;
    const rows = Array.isArray(list) ? list.slice(0, 5).map((r) => rowFrom(fields, r)) : [rowFrom(fields, undefined)];
    const sample = { items: rows, count: Array.isArray(list) ? list.length : rows.length };
    return stepGroup(node, { label, kind: 'parse_json' }, sample);
}
