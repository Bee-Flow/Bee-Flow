// How the Comes-in column orders and folds one step's fields (round 4,
// artboard 4c): at most six per step with a human name, the fields this step
// already uses on top, and the system fields (kind, source, id, provider,
// event, cron, etag…) behind "Technical details". Pure, so the rule has a
// test of its own and the panel only draws it.

/** Keys that describe the plumbing of a record rather than its content. */
const SYSTEM_KEYS = new Set([
    'kind', 'source', 'id', '_id', 'uuid', 'provider', 'event', 'eventtype', 'cron', 'etag',
    'fileid', 'nodeid', 'instanceid', 'orgid', 'ownerid', 'userid', 'runid', 'triggerid',
    'permissions', 'headers', 'raw', 'meta', 'metadata', 'mimetype', 'contenttype', 'checksum',
    'hash', 'webhookid', 'deliveryid', 'signature', 'firedat',
]);

/** Is this a system field that belongs under "Technical details"? */
export function isSystemField(key: unknown): boolean {
    const k = String(key || '');
    if (!k) return false;
    if (k.startsWith('_')) return true;
    return SYSTEM_KEYS.has(k.toLowerCase().replace(/[_-]/g, ''));
}

/** Rows shown before "n more". */
export const FIELDS_SHOWN = 6;

export interface FieldLike { key: string; path: string | null }

export interface IncomingFieldPlan<F extends FieldLike> {
    /** The rows on screen now. */
    shown: F[];
    /** How many content fields the "n more" button would add. */
    more: number;
    /** The system fields, folded under "Technical details". */
    technical: F[];
}

/**
 * Split one step's fields into what shows, what waits behind "n more", and
 * what folds under "Technical details". Used fields float to the top, in
 * their own order; the rest keep the order the step declares them in.
 * `expanded` lifts the six-row cap (the "n more" click, or a search).
 */
export function planIncomingFields<F extends FieldLike>(
    fields: F[],
    isUsed: (path: string) => boolean,
    expanded = false,
): IncomingFieldPlan<F> {
    const content: F[] = [];
    const technical: F[] = [];
    for (const f of fields || []) (isSystemField(f.key) ? technical : content).push(f);
    const usedField = (f: F) => f.path != null && isUsed(f.path);
    const used = content.filter(usedField);
    const rest = content.filter(f => !usedField(f));
    const ordered = [...used, ...rest];
    // A system field the step already binds is not "technical" to this step:
    // it stays in view so the author can see what they mapped.
    const usedTechnical = technical.filter(usedField);
    const foldedTechnical = technical.filter(f => !usedField(f));
    const all = [...usedTechnical, ...ordered];
    const cap = expanded ? all.length : Math.max(FIELDS_SHOWN, usedTechnical.length + used.length);
    return { shown: all.slice(0, cap), more: Math.max(0, all.length - cap), technical: foldedTechnical };
}

/** "kind, id, provider…" — the first three technical names, for the fold's label. */
export function technicalPreview(fields: FieldLike[], n = 3): string {
    const names = fields.slice(0, n).map(f => f.key);
    return names.join(', ') + (fields.length > n ? '…' : '');
}
