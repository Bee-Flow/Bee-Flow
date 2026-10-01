/**
 * Folding a node's REAL output (pinned, or from the last run) into the group
 * the describers built from its design-time sample.
 */
import { deepOverlay, fieldsFromSample, overlayReal } from '../fields.mjs';
import { parseLegacyPath } from '../source.mjs';
import { fieldAt } from './sampleFields.mjs';

/** The base a group's fields hang from, rebuilt from its legacy basePath. */
function groupBase(group) {
    const text = String(group.basePath || '');
    return { source: parseLegacyPath(text), text, rel: [] };
}

/**
 * Fold a node's REAL output into its group.
 *
 * sample: deepOverlay: real wins key by key, a real list or scalar replaces
 * a placeholder subtree wholesale (that is how an http_request's placeholder
 * string body becomes the real JSON array).
 *
 * fields: regenerated from the merged sample, then any ORIGINAL field whose
 * path is not covered is appended: curated paths that regeneration cannot
 * derive (a Loop's `results[*].item.*`, a switch's `matchesByCase.<name>`)
 * must survive the overlay. Every field is then checked against the real
 * output: a key the run did not produce stays offered (a describer may know
 * keys one run lacked) but is marked `confirmed: false`.
 *
 * Real output that is not an object (a raw AI answer, a top-level list, a
 * markdown string) has no named fields; the group then offers its whole
 * output as one field, opened to its columns when it is a table.
 */
export function overlayGroupWithReal(group, realOutput) {
    if (realOutput === undefined) return group;
    const base = groupBase(group);
    const merged = deepOverlay(group.sample, realOutput);
    if (merged == null || typeof merged !== 'object' || Array.isArray(merged)) {
        const own = (group.fields || []).filter(f => f.path !== group.basePath);
        const whole = { ...fieldAt(base, [], merged), key: (group.fields || []).find(f => f.path === group.basePath)?.key || 'output' };
        return { ...group, sample: merged, fields: [whole, ...overlayReal(own, realOutput)], hasRealData: true };
    }
    const fields = fieldsFromSample(merged, base);
    const covered = new Set(fields.map(f => f.path));
    for (const f of (group.fields || [])) {
        if (!covered.has(f.path)) fields.push(f);
    }
    return { ...group, sample: merged, fields: overlayReal(fields, realOutput), hasRealData: true };
}
