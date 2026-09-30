/**
 * Folding a node's REAL output (pinned, or from the last run) into the group
 * its describer built from the design-time sample. Port of agent-hub
 * `Builder/mapping/upstream/realOverlay.js`.
 */

import { deepOverlay } from '../realOutputs';
import type { VariableField, VariableGroup } from '../types';
import { seg } from './sampleFields';

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function childrenOf(v: Record<string, unknown>, path: string): VariableField[] {
    return Object.entries(v).map(([ck, cv]) => ({ key: ck, path: `${path}${seg(ck)}`, sample: cv }));
}

/**
 * sampleToFields for REAL data: an array of objects also gets `[*]` children
 * (`…results[*].subject`), so a real list is expandable and countable.
 */
function sampleToFieldsReal(sample: Record<string, unknown>, basePath: string): VariableField[] {
    const out: VariableField[] = [];
    for (const [k, v] of Object.entries(sample)) {
        const path = `${basePath}${seg(k)}`;
        if (isPlainObject(v)) {
            out.push({ key: k, path, sample: v, children: childrenOf(v, path) });
        } else if (Array.isArray(v) && v.length && isPlainObject(v[0])) {
            out.push({ key: k, path, sample: v, children: childrenOf(v[0], `${path}[*]`) });
        } else {
            out.push({ key: k, path, sample: v });
        }
    }
    return out;
}

/**
 * Real wins key by key; fields are regenerated from the merged sample, and any
 * original field whose path the regeneration doesn't cover survives (curated
 * paths such as `results[*].item.*` or `matchesByCase.<name>`). Non-object real
 * output keeps the group's fields and refreshes the one at the base path.
 */
export function overlayGroupWithReal(group: VariableGroup, realOutput: unknown): VariableGroup {
    if (realOutput === undefined) return group;
    const merged = deepOverlay(group.sample, realOutput);
    if (!isPlainObject(merged)) {
        const fields = (group.fields || []).map((f) => (f.path === group.basePath ? { ...f, sample: merged } : f));
        return { ...group, sample: merged, fields, hasRealData: true };
    }
    const fields = sampleToFieldsReal(merged, group.basePath);
    const covered = new Set(fields.map((f) => f.path));
    for (const f of group.fields || []) {
        if (!covered.has(f.path)) fields.push(f);
    }
    return { ...group, sample: merged, fields, hasRealData: true };
}
