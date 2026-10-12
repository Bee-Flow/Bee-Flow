/**
 * The sample → field vocabulary every describer in this folder shares: one
 * sample in, a tree of bindable `{ key, path, sample, children? }` fields out,
 * built by fieldTree.ts (every level, list columns from the union of the rows,
 * JSON text opened, each path in the RUNTIME's grammar). Port of agent-hub
 * `Builder/mapping/upstream/sampleFields.js`; pinned by upstream.lockstep.test.ts.
 */

import { formatKey, getList } from '@/shared/expr';

import type { VariableField, VariableGroup } from '../types';
import { walkPath } from '../walkPath';
import { eachField, isRecord, mergeElements, recordFields } from './fieldTree';
import { overlayGroupWithReal } from './realOverlay';

/** The path segment for ONE key (`.key`, `[3]`, `["line-items"]`): the runtime grammar's writer. */
export const seg = (k: string): string => formatKey(k);

/** A record's fields, every level of it; anything else has none. */
export function sampleToFields(sample: unknown, basePath: string): VariableField[] {
    return recordFields(sample, basePath);
}

/**
 * ONE element standing for the array `arrayRef` points at (its rows' keys
 * merged), or null. The list is read like the run reads it (getList), so a
 * list held as JSON text has an element too.
 */
export function resolveElementSample(arrayRef: unknown, sampleRoot: unknown): unknown {
    if (typeof arrayRef !== 'string' || !arrayRef.trim() || !sampleRoot) return null;
    // A flowlet sub-step id (`steps.<call>/<sub>`) is outside the runtime grammar: the builder's own walker reads it.
    const ref = arrayRef.trim();
    const v = getList(sampleRoot, ref) ?? walkPath(ref, sampleRoot);
    if (!Array.isArray(v) || v.length === 0) return null;
    return mergeElements(v);
}

/** Top-level field options of an array element — the only level collection ops address. */
export function elementFieldOptions(elementSample: unknown): { key: string; sample: unknown }[] {
    if (!elementSample || typeof elementSample !== 'object' || Array.isArray(elementSample)) return [];
    return Object.entries(elementSample).map(([key, sample]) => ({ key, sample }));
}

/**
 * The fields of a group's REAL value: exactly what overlayGroupWithReal
 * offers (a per-item step's forEach envelope, a Code step's data, never its logs).
 */
export function realFieldsOf(group: VariableGroup, actual: unknown): VariableField[] {
    return overlayGroupWithReal(group, actual).fields || [];
}

/**
 * Every LIST reachable from the groups, at any depth — fields and their
 * children, plus lists only the real-run overlay (`previewSample`) has.
 */
export function collectArrayPaths(groups: VariableGroup[] | null | undefined, previewSample: unknown = null): VariableField[] {
    const out: VariableField[] = [];
    const seen = new Set<string>();
    const visit = (fields: VariableField[] | undefined) => eachField(fields, (f) => {
        if (!Array.isArray(f.sample) || !f.path || seen.has(f.path)) return;
        seen.add(f.path);
        out.push({ key: f.key, path: f.path, sample: f.sample });
    });
    for (const g of groups || []) {
        visit(g.fields);
        if (previewSample && g.basePath) {
            const actual = walkPath(g.basePath, previewSample);
            if (actual !== undefined) visit(realFieldsOf(g, actual));
        }
    }
    return out;
}

/** A typed placeholder for a declared field type. */
export function samplePlaceholderFor(type: unknown): unknown {
    switch (type) {
        case 'number':
            return 0;
        case 'boolean':
            return false;
        case 'object':
            return {};
        case 'array':
            return [];
        // App-trigger file inputs arrive expanded (appStudio/actionExecutor).
        case 'file':
            return { fileId: '<file-id>', name: 'document.pdf', mime: 'application/pdf', size: 12345, url: '<signed download url>' };
        default:
            return '<string>';
    }
}

/**
 * A declared schema as a sample with the same shape: an object's properties,
 * an array's items as one element, a type list's first non-null type, the
 * first non-null branch of an anyOf / oneOf. A bare type name is its placeholder.
 */
export function schemaToSample(schema: unknown, depth = 0): unknown {
    if (typeof schema === 'string') return samplePlaceholderFor(schema);
    if (!isRecord(schema)) return samplePlaceholderFor('string');
    const branch = [schema.anyOf, schema.oneOf].find(Array.isArray) as unknown[] | undefined;
    if (branch && !schema.type && !schema.properties) {
        return schemaToSample(branch.find((b) => isRecord(b) && b.type !== 'null') || branch[0], depth);
    }
    const type = schemaType(schema);
    if (depth >= 8) return samplePlaceholderFor(type);
    if ((type === 'object' || !type) && isRecord(schema.properties)) {
        return Object.fromEntries(Object.entries(schema.properties).filter(([k]) => k).map(([k, v]) => [k, schemaToSample(v, depth + 1)]));
    }
    if (type === 'array') return isRecord(schema.items) ? [schemaToSample(schema.items, depth + 1)] : [];
    return samplePlaceholderFor(typeof type === 'string' ? type : 'string');
}

/** A schema's one type: the first non-null of a type list. */
function schemaType(schema: Record<string, unknown>): unknown {
    return Array.isArray(schema.type) ? (schema.type.find((x) => x !== 'null') || schema.type[0]) : schema.type;
}

/** A group's name and kind. */
export interface GroupHead {
    label: string;
    kind: string;
}

/** A describer's group for a step whose output lives at `steps.<id>.output`. */
export function stepGroup(node: { id: string }, head: GroupHead, sample: unknown, fields?: VariableField[]): VariableGroup {
    const basePath = `steps.${node.id}.output`;
    return { id: node.id, ...head, basePath, sample, fields: fields ?? sampleToFields(sample, basePath) };
}
