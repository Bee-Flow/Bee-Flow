/**
 * The sample → field vocabulary every describer in this folder shares: one
 * sample object in, bindable `{ key, path, sample }` fields out — with the
 * path-segment escaping that keeps paths inside the RUNTIME's ref grammar.
 * Port of agent-hub `Builder/mapping/upstream/sampleFields.js`; pinned by
 * upstream.lockstep.test.ts.
 */

import type { VariableField, VariableGroup } from '../types';
import { walkPath } from '../walkPath';

/**
 * Append ONE object key to a ref path, bracket-quoting it when it isn't a bare
 * identifier: `…output["line-items"]` resolves at run time, `…output.line-items`
 * does not (server bind.js REF_RE).
 */
export const seg = (k: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);

/**
 * A sample object as a field list: top-level keys become leaves, nested
 * objects one level of children. Arrays are not expanded (their element
 * shape is a loop variable's business).
 */
export function sampleToFields(sample: unknown, basePath: string): VariableField[] {
    if (sample == null || typeof sample !== 'object') return [];
    const out: VariableField[] = [];
    for (const [k, v] of Object.entries(sample)) {
        const path = `${basePath}${seg(k)}`;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const children = Object.entries(v).map(([ck, cv]) => ({ key: ck, path: `${path}${seg(ck)}`, sample: cv }));
            out.push({ key: k, path, sample: v, children });
        } else {
            out.push({ key: k, path, sample: v });
        }
    }
    return out;
}

/** The sample of ONE element of the array `arrayRef` points at, or null. */
export function resolveElementSample(arrayRef: unknown, sampleRoot: unknown): unknown {
    if (typeof arrayRef !== 'string' || !arrayRef.trim() || !sampleRoot) return null;
    const v = walkPath(arrayRef.trim(), sampleRoot);
    if (!Array.isArray(v) || v.length === 0) return null;
    return v[0] ?? null;
}

/** Top-level field options of an array element — the only level collection ops address. */
export function elementFieldOptions(elementSample: unknown): { key: string; sample: unknown }[] {
    if (!elementSample || typeof elementSample !== 'object' || Array.isArray(elementSample)) return [];
    return Object.entries(elementSample).map(([key, sample]) => ({ key, sample }));
}

function realArrays(group: VariableGroup, previewSample: unknown, push: (k: string, p: string, s: unknown) => void): void {
    const actual = walkPath(group.basePath, previewSample);
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return;
    for (const [k, v] of Object.entries(actual)) {
        if (Array.isArray(v)) push(k, `${group.basePath}${seg(k)}`, v);
    }
}

/**
 * Every ARRAY-valued path reachable from the groups — fields, one level of
 * children, and arrays only the real-run overlay (`previewSample`) has.
 */
export function collectArrayPaths(groups: VariableGroup[] | null | undefined, previewSample: unknown = null): VariableField[] {
    const out: VariableField[] = [];
    const seen = new Set<string>();
    const push = (key: string, path: string, sample: unknown) => {
        if (!path || seen.has(path)) return;
        seen.add(path);
        out.push({ key, path, sample });
    };
    for (const g of groups || []) {
        for (const f of g.fields || []) {
            if (Array.isArray(f.sample)) push(f.key, f.path, f.sample);
            for (const c of f.children || []) {
                if (Array.isArray(c.sample)) push(c.key, c.path, c.sample);
            }
        }
        if (previewSample && g.basePath) realArrays(g, previewSample, push);
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
