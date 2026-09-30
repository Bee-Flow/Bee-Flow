/**
 * A plain-language diff between two automation definitions — the line at the
 * top of a version comparison ("2 steps added · 1 connection removed ·
 * Description changed"). Steps match by id, edges by their from→to pair; order
 * within steps/edges is ignored. Port of server/automation/diffSummary.js (the
 * web's own mirror, `Builder/diffSummary.js`, went with handoff 5); pinned by
 * settings.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';

type Obj = Record<string, unknown>;

function asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function asObject(v: unknown): Obj {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function sortKeys(x: unknown): unknown {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (x && typeof x === 'object') {
        const out: Obj = {};
        for (const k of Object.keys(x).sort()) out[k] = sortKeys((x as Obj)[k]);
        return out;
    }
    return x;
}

function stableJson(v: unknown): string {
    return JSON.stringify(sortKeys(v ?? null)) as string;
}

function stepMap(def: Obj): Map<string, unknown> {
    const m = new Map<string, unknown>();
    for (const s of asArray(def.steps)) {
        const id = (s as Obj | null)?.id;
        if (s && id != null) m.set(String(id), s);
    }
    return m;
}

function edgeSet(def: Obj): Set<string> {
    const s = new Set<string>();
    for (const e of asArray(def.edges)) {
        const edge = e as Obj | null;
        if (edge && edge.from != null && edge.to != null) s.add(`${String(edge.from)}→${String(edge.to)}`);
    }
    return s;
}

type Counted = 'steps_added' | 'steps_removed' | 'steps_changed' | 'connections_added' | 'connections_removed';

const COUNTED: Record<Counted, [string, string]> = {
    steps_added: ['{n} step added', '{n} steps added'],
    steps_removed: ['{n} step removed', '{n} steps removed'],
    steps_changed: ['{n} step changed', '{n} steps changed'],
    connections_added: ['{n} connection added', '{n} connections added'],
    connections_removed: ['{n} connection removed', '{n} connections removed'],
};

function counted(key: Counted, n: number): string {
    const [one, many] = COUNTED[key];
    return n === 1 ? t(`mobile.flow.diff.${key}_one`, one, { n }) : t(`mobile.flow.diff.${key}`, many, { n });
}

/** Scalar/object fields that surface as one "X changed" phrase. */
const FIELD_LABELS: [string, string][] = [
    ['description', 'Description changed'],
    ['trigger', 'Trigger changed'],
    ['notificationSettings', 'Notification settings changed'],
    ['manualTriggerPayload', 'Manual trigger payload changed'],
    ['layers', 'Layers changed'],
];

function stepPhrases(prev: Obj, next: Obj): string[] {
    const prevSteps = stepMap(prev);
    const nextSteps = stepMap(next);
    let added = 0;
    let changed = 0;
    for (const [id, s] of nextSteps) {
        if (!prevSteps.has(id)) added += 1;
        else if (stableJson(prevSteps.get(id)) !== stableJson(s)) changed += 1;
    }
    const removed = [...prevSteps.keys()].filter((id) => !nextSteps.has(id)).length;
    const out: string[] = [];
    if (added) out.push(counted('steps_added', added));
    if (removed) out.push(counted('steps_removed', removed));
    if (changed) out.push(counted('steps_changed', changed));
    return out;
}

function edgePhrases(prev: Obj, next: Obj): string[] {
    const prevEdges = edgeSet(prev);
    const nextEdges = edgeSet(next);
    const added = [...nextEdges].filter((k) => !prevEdges.has(k)).length;
    const removed = [...prevEdges].filter((k) => !nextEdges.has(k)).length;
    const out: string[] = [];
    if (added) out.push(counted('connections_added', added));
    if (removed) out.push(counted('connections_removed', removed));
    return out;
}

/** Plain phrases describing prev → next; empty when they are equal. */
export function summarizeDefinitionDiff(prevDef: unknown, nextDef: unknown): string[] {
    const prev = asObject(prevDef);
    const next = asObject(nextDef);
    const phrases = [...stepPhrases(prev, next), ...edgePhrases(prev, next)];
    for (const [field, label] of FIELD_LABELS) {
        if (stableJson(prev[field]) !== stableJson(next[field])) phrases.push(t(`mobile.flow.diff.${field}_changed`, label));
    }
    return phrases;
}

/** One line, e.g. "2 steps added · 1 connection removed", or the formatting-only note. */
export function summarizeDefinitionDiffLine(prevDef: unknown, nextDef: unknown): string {
    const phrases = summarizeDefinitionDiff(prevDef, nextDef);
    return phrases.length ? phrases.join(' · ') : t('mobile.flow.diff.formatting_only', 'No structural changes (formatting only)');
}
