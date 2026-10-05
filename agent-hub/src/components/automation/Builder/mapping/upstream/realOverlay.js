/**
 * Folding a node's REAL output (pinned, or from the last run) into the group
 * the describers built from its design-time sample.
 *
 * Kept apart from sampleFields.js because real data earns a second field
 * builder: an array of objects gets `[*]` children, which a placeholder `[]`
 * never could.
 */
import { deepOverlay } from '../realOutputs';
import { seg } from './sampleFields';
import { payloadKeyOf, stepPayload } from '../../flow/stepPayload';

/**
 * sampleToFields for REAL data: same shape, plus `[*]` children for arrays of
 * objects (`…results[*].subject` — the collectionItemsFields convention), so a
 * real Gmail `results` array is expandable in the VariableTree and countable
 * by collectArrayPaths/nearestArrayRef. Design-time samples keep the plain
 * builder — placeholder arrays are `[]` and would only add noise.
 */
function sampleToFieldsReal(sample, basePath) {
    if (sample == null || typeof sample !== 'object') return [];
    const out = [];
    for (const [k, v] of Object.entries(sample)) {
        const path = `${basePath}${seg(k)}`;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const children = Object.entries(v).map(([ck, cv]) => ({ key: ck, path: `${path}${seg(ck)}`, sample: cv }));
            out.push({ key: k, path, sample: v, children });
        } else if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
            const children = Object.entries(v[0]).map(([ck, cv]) => ({ key: ck, path: `${path}[*]${seg(ck)}`, sample: cv }));
            out.push({ key: k, path, sample: v, children });
        } else {
            out.push({ key: k, path, sample: v });
        }
    }
    return out;
}

/**
 * Fold a node's REAL output (pinned or from the last run) into its group.
 *
 * sample: deepOverlay — real wins key-by-key, a real array/scalar replaces a
 * placeholder subtree wholesale (that is how an http_request's placeholder
 * string body becomes the real JSON array).
 *
 * fields: regenerated from the merged sample (with `[*]` children), then any
 * ORIGINAL field whose path isn't covered is appended — curated paths that
 * regeneration can't derive (forEach `results[*].item.*`, a switch's
 * `matchesByCase.<name>`, loop counters) must survive the overlay.
 *
 * Non-object real output (a schema-less ai_step returning a raw string) can't
 * produce a field list — keep the group's own fields but refresh the sample of
 * any field pointing at the base path itself.
 */
export function overlayGroupWithReal(group, realOutput) {
    if (realOutput === undefined) return group;
    const merged = deepOverlay(group.sample, realOutput);
    if (merged == null || typeof merged !== 'object' || Array.isArray(merged)) {
        const fields = (group.fields || []).map(f => (f.path === group.basePath ? { ...f, sample: merged } : f));
        return { ...group, sample: merged, fields, hasRealData: true };
    }
    // A step that wraps its data in an envelope (a Code step's `result` next to
    // `logs` / `httpCalls`, plus `_dryRun` / `wouldHaveCalled` on a dry run):
    // offer the fields of the data itself, not the envelope. A record lists its
    // own fields (paths keep `.result`); a list or a value stays one `result` field.
    const payloadKey = payloadKeyOf(group.kind);
    if (payloadKey) {
        const payload = stepPayload(group.kind, merged);
        const payloadPath = `${group.basePath}${seg(payloadKey)}`;
        const fields = payload && typeof payload === 'object' && !Array.isArray(payload)
            ? sampleToFieldsReal(payload, payloadPath)
            : [{ key: payloadKey, path: payloadPath, sample: payload }];
        return { ...group, sample: merged, fields, hasRealData: true };
    }
    const fields = sampleToFieldsReal(merged, group.basePath);
    const covered = new Set(fields.map(f => f.path));
    for (const f of (group.fields || [])) {
        if (!covered.has(f.path)) fields.push(f);
    }
    return { ...group, sample: merged, fields, hasRealData: true };
}
