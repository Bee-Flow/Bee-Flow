/**
 * Folding a node's REAL output (pinned, or from the last run) into the group
 * its describer built from the design-time sample: fields rebuilt from the
 * real data with the describers' own builder (fieldTree.ts), a curated field
 * the real output has kept beside them, and no path listed twice. Port of
 * agent-hub `Builder/mapping/upstream/realOverlay.js`.
 */

import { appendKey, formatKey, getRelativePath } from '@/shared/expr';

import type { VariableField, VariableGroup } from '../types';
import { eachField, fieldFor, isRecord, outputFields, positionChildren, recordFields } from './fieldTree';
import { forEachOutputPath, perIterationField } from './forEachShape';
import { payloadKeyOf, stepPayload } from './stepPayload';

/** sampleToFields for REAL data: real and design-time samples share one builder. */
export function sampleToFieldsReal(sample: unknown, basePath: string): VariableField[] {
    return recordFields(sample, basePath);
}

interface RealValue {
    base: string;
    value: unknown;
}

/** Does `path` (under `base`) reach anything in the real value? An empty `[*]` column reaches nothing. */
function reaches(path: string, real: RealValue): boolean {
    const { base, value } = real;
    if (path === base) return value !== undefined;
    const rest = path.startsWith(`${base}.`) ? path.slice(base.length + 1) : path.startsWith(`${base}[`) ? path.slice(base.length) : null;
    if (rest === null) return false;
    const v = getRelativePath(value, rest);
    return v !== undefined && !(Array.isArray(v) && v.length === 0 && rest.includes('[*]'));
}

/** A curated field the real output has, minus what the rebuild already offers; null when nothing is left. */
function uncovered(f: VariableField, covered: Set<string>, real: RealValue): VariableField | null {
    if (covered.has(f.path) || !reaches(f.path, real)) return null;
    if (!f.children) return f;
    const children = f.children.map((c) => uncovered(c, covered, real)).filter((c): c is VariableField => !!c);
    const { children: _drop, ...rest } = f;
    return children.length ? { ...rest, children } : rest;
}

/** Rebuilt fields first; then each curated field the real output has and the rebuild does not cover, once. */
function withCurated(fields: VariableField[], curated: VariableField[] | undefined, real: RealValue): VariableField[] {
    const covered = new Set<string>();
    eachField(fields, (f) => covered.add(f.path));
    for (const f of curated || []) {
        const kept = uncovered(f, covered, real);
        if (kept) {
            fields.push(kept);
            eachField([kept], (c) => covered.add(c.path));
        }
    }
    return fields;
}

/**
 * A step that ran once per item: the counters, then every per-iteration field
 * flat at `results[*].output.<key>`, rebuilt from what EVERY iteration returned.
 */
function forEachFields(group: VariableGroup, merged: Record<string, unknown>): VariableField[] {
    const base = group.basePath;
    const rows = Array.isArray(merged.results) ? merged.results.filter(isRecord) : [];
    const payloadKey = payloadKeyOf(group.kind);
    let outputs = rows.filter((r) => 'output' in r).map((r) => r.output);
    let outPath = forEachOutputPath(base);
    if (payloadKey) {
        outputs = outputs.map((o) => stepPayload(group.kind, o));
        outPath = appendKey(outPath, payloadKey);
    }
    const counters = FOR_EACH_COUNTERS.map((k) => ({ key: k, path: appendKey(base, k), sample: merged[k] ?? 0 }));
    if (!outputs.some((o) => o !== undefined)) {
        // No iteration returned anything (an empty list, every item failed):
        // the per-item fields offered before the run stay; the counters are real.
        const counted = new Set(counters.map((c) => c.path));
        return [...counters, ...(group.fields || []).filter((f) => !counted.has(f.path))];
    }
    let perItem = positionChildren(outputs, outPath);
    if (!perItem.length && outputs.some((o) => o !== undefined)) {
        const own = (group.fields || []).find((f) => f.path === outPath);
        perItem = [fieldFor(own?.key || payloadKey || 'output', outPath, outputs.find((o) => o != null) ?? outputs[0])];
    }
    return withCurated([...counters, ...perItem.map(perIterationField)], group.fields, { base, value: merged });
}

const FOR_EACH_COUNTERS = ['iterations', 'succeeded', 'failed'];

/** The runner's per-item envelope (execForEachStep); a Loop's own output has no succeeded / failed. */
function isPerItemEnvelope(v: unknown): v is Record<string, unknown> {
    return isRecord(v) && Array.isArray(v.results) && FOR_EACH_COUNTERS.every((k) => k in v);
}

/**
 * Does the real output have the shape the step is configured for NOW? With
 * "run once per item" switched on or off after a run, the stale output says
 * nothing about the fields: the design-time group (and its sample) stands. A
 * PIN is handed downstream as it is, so its own shape is the truth.
 */
function fitsShape(group: VariableGroup, realOutput: unknown): boolean {
    if (group.forEach) return isPerItemEnvelope(realOutput);
    return group.kind === 'loop' || !isPerItemEnvelope(realOutput);
}

/**
 * The real output IS the sample (a key the describer only guessed, an HTTP
 * step's `data` placeholder, does not survive it); fields are rebuilt from it,
 * and every original field the real output has but the rebuild does not offer
 * survives (curated paths such as `matchesByCase.<name>`). A Code step offers what its
 * code returned, never the `{ result, logs, httpCalls }` envelope. Output that
 * is not a record is one field at the base path, with the list's columns or
 * the text's JSON under it. `pinned`: the output is the step's pin, not a run.
 */
export function overlayGroupWithReal(group: VariableGroup, realOutput: unknown, { pinned = false }: { pinned?: boolean } = {}): VariableGroup {
    if (realOutput === undefined) return group;
    if (!fitsShape(group, realOutput)) {
        if (!pinned) return group;
        return overlayGroupWithReal({ ...group, forEach: !group.forEach }, realOutput, { pinned });
    }
    const merged = realOutput;
    if (group.forEach && isRecord(merged)) {
        return { ...group, sample: merged, fields: forEachFields(group, merged), hasRealData: true };
    }
    const payloadKey = payloadKeyOf(group.kind);
    if (payloadKey && isRecord(merged)) {
        const payload = stepPayload(group.kind, merged);
        const fields = outputFields(payload, `${group.basePath}${formatKey(payloadKey)}`, payloadKey);
        return { ...group, sample: merged, fields, hasRealData: true };
    }
    if (!isRecord(merged)) {
        const own = (group.fields || []).filter((f) => f.path === group.basePath);
        const fields = own.length
            ? own.map(({ children: _drop, ...f }) => ({ ...f, ...fieldFor(f.key, f.path, merged) }))
            : outputFields(merged, group.basePath);
        return { ...group, sample: merged, fields, hasRealData: true };
    }
    const fields = withCurated(recordFields(merged, group.basePath), group.fields, { base: group.basePath, value: merged });
    return { ...group, sample: merged, fields, hasRealData: true };
}
