import { humanizeFieldKey as humanizeFieldKeyJs, humanizeFieldTail as humanizeFieldTailJs } from '../flow/displayHelpers';
import { stepNumbers as stepNumbersJs } from '../flow/flowOrder';
import { isInlineId, parseInlineId } from '../flow/inlineFlowlets';
import { stepFamily as stepFamilyJs } from '../flow/nodeDefs';
import type { FlowDefinition } from '../flow/types';
import { usedPathsIn as usedPathsInJs } from '../mapping/boundPaths';
import { lastPathKey } from '../mapping/upstream/fieldTree';

const usedPathsIn = usedPathsInJs as (step: unknown) => Set<string>;
const humanizeFieldTail = humanizeFieldTailJs as (path: string) => string;
const humanizeFieldKey = humanizeFieldKeyJs as (key: string) => string;
const stepFamily = stepFamilyJs as (type: string | undefined) => string | null;
const stepNumbers = stepNumbersJs as (
    definition: FlowDefinition | null | undefined,
    helpers: { isInlineId?: unknown; parseInlineId?: unknown },
) => Map<string, number | string>;

/** One step that reads this step's output, and which of its fields. */
export interface UsedByEntry {
    stepId: string;
    label: string;
    family: string | null;
    number: number | string | null;
    /** Readable field names ("Text", "Page count"); empty = the whole output. */
    fields: string[];
    /** The raw leaf keys, for the table's column suggestion. */
    leaves: string[];
}

/** The fields of this step's output one other step reads. */
function fieldsReadBy(st: unknown, prefix: RegExp): { fields: string[]; leaves: string[]; whole: boolean } {
    const fields: string[] = [];
    const leaves: string[] = [];
    let whole = false;
    for (const p of usedPathsIn(st)) {
        const m = prefix.exec(p);
        if (!m) continue;
        const rest = m[1].replace(/^\./, '');
        if (!rest) { whole = true; continue; }
        // The key the path ENDS in, read as the runtime reads it:
        // `verdict["reason code"]` is "Reason code", not "Verdict".
        const leaf = lastPathKey(rest);
        const name = leaf ? humanizeFieldKey(leaf) : humanizeFieldTail(rest);
        if (name && !fields.includes(name)) fields.push(name);
        if (leaf && !leaves.includes(leaf)) leaves.push(leaf);
    }
    return { fields, leaves, whole };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which later steps REALLY use this step's output: every step whose settings
 * reference `steps.<id>.output…`, with the fields it reads. Syntactic, like
 * the server's binder (mapping/boundPaths.js), so a field counts as used
 * exactly when a run would resolve it. A connection line alone is not use.
 */
export function usedByDownstream(definition: FlowDefinition | null | undefined, stepId: string | null | undefined): UsedByEntry[] {
    if (!definition || !stepId) return [];
    const prefix = new RegExp(`^steps\\.${escapeRe(stepId)}\\.output(.*)$`);
    const numbers = stepNumbers(definition, { isInlineId, parseInlineId });
    const out: UsedByEntry[] = [];
    for (const st of definition.steps || []) {
        if (!st?.id || st.id === stepId) continue;
        const { fields, leaves, whole } = fieldsReadBy(st, prefix);
        if (!fields.length && !whole) continue;
        out.push({
            stepId: st.id,
            label: String(st.label || st.type || st.id),
            family: stepFamily(st.type),
            number: numbers.get(st.id) ?? null,
            fields,
            leaves,
        });
    }
    const n = (e: UsedByEntry) => (typeof e.number === 'number' ? e.number : Number.MAX_SAFE_INTEGER);
    return out.sort((a, b) => n(a) - n(b));
}

/** Does this list look like files (so the suggestion says "for each file")? */
export function looksLikeFileRows(rows: unknown[]): boolean {
    const first = rows.find(r => r && typeof r === 'object' && !Array.isArray(r)) as Record<string, unknown> | undefined;
    if (!first) return false;
    const keys = Object.keys(first).map(k => k.toLowerCase());
    const named = keys.some(k => k === 'name' || k === 'filename' || k === 'basename');
    return named && keys.some(k => ['path', 'mimetype', 'mime', 'size', 'fileid', 'etag', 'url'].includes(k));
}
