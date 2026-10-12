/**
 * Folding a node's REAL output (pinned, or from the last run) into the group
 * the describers built from its design-time sample.
 *
 * The fields are rebuilt from the real data with the same builder the
 * describers use (fieldTree.ts), so a real Gmail `results` list opens into
 * every column its rows have, at every level, and a field the run did not
 * produce but the describer knows about survives beside them.
 */
import { appendKey, formatKey, getRelativePath } from '@shared/expr/path.mjs';
import { eachField, fieldFor, isRecord, outputFields, positionChildren, recordFields } from './fieldTree';
import { forEachOutputPath, perIterationField } from './forEachShape';
import { payloadKeyOf, stepPayload } from '../../flow/stepPayload';

/**
 * sampleToFields for REAL data. Kept as a name for the describers that use
 * it; real and design-time samples share one builder now (a design-time `[]`
 * simply has no columns to offer).
 */
export function sampleToFieldsReal(sample, basePath) {
    return recordFields(sample, basePath);
}

/**
 * Does `path` (under `base`) reach anything in the real `value`? A column
 * through `[*]` that collects nothing reaches nothing.
 */
function reaches(path, base, value) {
    if (path === base) return value !== undefined;
    const rest = path.startsWith(`${base}.`) ? path.slice(base.length + 1) : path.startsWith(`${base}[`) ? path.slice(base.length) : null;
    if (rest === null) return false;
    const v = getRelativePath(value, rest);
    return v !== undefined && !(Array.isArray(v) && v.length === 0 && rest.includes('[*]'));
}

/**
 * A curated field the real output has, minus whatever the rebuilt fields
 * already offer (at any depth); null when nothing of it is left.
 */
function uncovered(f, covered, real) {
    if (covered.has(f.path) || !reaches(f.path, real.base, real.value)) return null;
    if (!f.children) return f;
    const children = f.children.map(c => uncovered(c, covered, real)).filter(Boolean);
    const { children: _drop, ...rest } = f;
    return children.length ? { ...rest, children } : rest;
}

/**
 * Rebuilt fields first; then each curated field the rebuild does not cover,
 * once — and only when the real output has it: a key the describer only
 * guessed (an HTTP step's parsed-body placeholder) is not offered next to
 * what the step really returned.
 */
function withCurated(fields, curated, real) {
    const covered = new Set();
    eachField(fields, f => covered.add(f.path));
    for (const f of (curated || [])) {
        const kept = uncovered(f, covered, real);
        if (kept) {
            fields.push(kept);
            eachField([kept], c => covered.add(c.path));
        }
    }
    return fields;
}

/**
 * A step that ran once per item: its output is the `{ iterations, succeeded,
 * failed, results: [{ index, item, output, status }] }` envelope. The fields
 * stay the ones it offered before the run (the counters, then every
 * per-iteration field flat at `results[*].output.<key>`), rebuilt from what
 * EVERY iteration returned rather than the catalog's guess.
 */
function forEachFields(group, merged) {
    const base = group.basePath;
    const rows = Array.isArray(merged.results) ? merged.results.filter(isRecord) : [];
    const payloadKey = payloadKeyOf(group.kind);
    let outputs = rows.filter(r => 'output' in r).map(r => r.output);
    let outPath = forEachOutputPath(base);
    if (payloadKey) {
        outputs = outputs.map(o => stepPayload(group.kind, o));
        outPath = appendKey(outPath, payloadKey);
    }
    const counters = FOR_EACH_COUNTERS.map(k => ({ key: k, path: appendKey(base, k), sample: merged[k] ?? 0 }));
    if (!outputs.some(o => o !== undefined)) {
        // No iteration returned anything (an empty list, every item failed):
        // no evidence against the per-item fields offered before the run, so
        // they stay; only the counters take the run's values.
        const counted = new Set(counters.map(c => c.path));
        return [...counters, ...(group.fields || []).filter(f => !counted.has(f.path))];
    }
    let perItem = positionChildren(outputs, outPath);
    if (!perItem.length && outputs.some(o => o !== undefined)) {
        // Every iteration returned a value, not a record (an AI answer, a
        // Code result list): one field for it, named as the step names it.
        const own = (group.fields || []).find(f => f.path === outPath);
        perItem = [fieldFor(own?.key || payloadKey || 'output', outPath, outputs.find(o => o != null) ?? outputs[0])];
    }
    return withCurated([...counters, ...perItem.map(perIterationField)], group.fields, { base, value: merged });
}

const FOR_EACH_COUNTERS = ['iterations', 'succeeded', 'failed'];

/**
 * The envelope the runner wraps a per-item step's outputs in
 * (execForEachStep). A Loop step's own output (`{ iterations, results }`)
 * carries no succeeded / failed.
 */
function isPerItemEnvelope(v) {
    return isRecord(v) && Array.isArray(v.results) && FOR_EACH_COUNTERS.every(k => k in v);
}

/**
 * Does the real output have the shape the step is configured for NOW? With
 * "run once per item" switched on or off after a run, the last run has the
 * other shape while the next run produces the configured one: the stale
 * output says nothing about the fields, so the design-time group stands
 * (its sample too, for everything resolved through it downstream). A PIN is
 * different: the runner hands it downstream as it is (execution.js), so its
 * own shape is the truth.
 */
function fitsShape(group, realOutput) {
    if (group.forEach) return isPerItemEnvelope(realOutput);
    return group.kind === 'loop' || !isPerItemEnvelope(realOutput);
}

/**
 * Fold a node's REAL output (pinned or from the last run) into its group.
 *
 * sample: the real output itself. It used to be merged over the design-time
 * sample, which kept every key the describer had only GUESSED (an HTTP step's
 * `data` "parsed body") beside what the step really returned, as a field
 * that read "not seen yet" forever.
 *
 * fields: rebuilt from the real output, then every ORIGINAL field the real
 * output has but the rebuild does not offer is appended — curated paths a
 * rebuild can't derive (a switch's `matchesByCase.<name>`, loop counters)
 * survive, and a path is never listed twice.
 *
 * Output that is not a record (a root list, a schema-less AI step's text) is
 * one field at the base path, with the list's columns or the text's JSON
 * under it.
 *
 * `pinned`: the output is the step's pin, not a run (see fitsShape).
 */
export function overlayGroupWithReal(group, realOutput, { pinned = false } = {}) {
    if (realOutput === undefined) return group;
    if (!fitsShape(group, realOutput)) {
        if (!pinned) return group;
        return overlayGroupWithReal({ ...group, forEach: !group.forEach }, realOutput, { pinned });
    }
    const merged = realOutput;
    if (group.forEach && isRecord(merged)) {
        return { ...group, sample: merged, fields: forEachFields(group, merged), hasRealData: true };
    }
    // A step that wraps its data in an envelope (a Code step's `result` next to
    // `logs` / `httpCalls`, plus `_dryRun` / `wouldHaveCalled` on a dry run):
    // offer the fields of the data itself, not the envelope. A record lists its
    // own fields (paths keep `.result`); a list or a value is one `result` field.
    const payloadKey = payloadKeyOf(group.kind);
    if (payloadKey && isRecord(merged)) {
        const payload = stepPayload(group.kind, merged);
        const fields = outputFields(payload, `${group.basePath}${formatKey(payloadKey)}`, payloadKey);
        return { ...group, sample: merged, fields, hasRealData: true };
    }
    if (!isRecord(merged)) {
        const own = (group.fields || []).filter(f => f.path === group.basePath);
        const fields = own.length
            ? own.map(({ children: _drop, ...f }) => ({ ...f, ...fieldFor(f.key, f.path, merged) }))
            : outputFields(merged, group.basePath);
        return { ...group, sample: merged, fields, hasRealData: true };
    }
    const fields = withCurated(recordFields(merged, group.basePath), group.fields, { base: group.basePath, value: merged });
    return { ...group, sample: merged, fields, hasRealData: true };
}
