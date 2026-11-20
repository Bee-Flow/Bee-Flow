/**
 * Where each template being filled in this turn stands, read off the turn's
 * tool results (template_fill_start / _set_values / _finish, answered by
 * server/integrations/templateFillTools.mts). One entry per document, the
 * latest answer winning: the card shows where the filling ended up, not every
 * step on the way.
 *
 * A reloaded message has no `toolResults` (only 200-character previews), so the
 * card is a live-turn affordance; the assistant's closing "[name](url)" link
 * (DocumentLinkCard) is what stays.
 */

const TEMPLATE_FILL_RESULT_TOOLS = new Set(['template_fill_start', 'template_fill_set_values', 'template_fill_finish']);

export interface TemplateFillState {
    documentId: string;
    name: string;
    url: string;
    filled: number;
    total: number;
    missing: string[];
    finished: boolean;
    format: 'pdf' | 'pptx';
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** The result as an object: a tool result may arrive as its JSON text. */
function resultObject(result: unknown): Record<string, unknown> | null {
    if (isObject(result)) return result;
    if (typeof result !== 'string') return null;
    try {
        const parsed: unknown = JSON.parse(result);
        return isObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** The labels of the fields still required (the key when a field has no label). */
function missingLabels(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.map((field: unknown) => {
        if (!isObject(field)) return '';
        const label = field.label ?? field['key'];
        return typeof label === 'string' ? label : '';
    }).filter(Boolean);
}

/** A template-fill result that names its document, or null for any other entry (an error, another tool). */
function fillResult(entry: unknown): (Record<string, unknown> & { documentId: string }) | null {
    if (!isObject(entry) || typeof entry.name !== 'string' || !TEMPLATE_FILL_RESULT_TOOLS.has(entry.name)) return null;
    const r = resultObject(entry.result);
    if (!r || r.error || typeof r.documentId !== 'string' || !r.documentId) return null;
    return r as Record<string, unknown> & { documentId: string };
}

const text = (v: unknown, fallback: string): string => (typeof v === 'string' && v ? v : fallback);

export function templateFillStates(toolResults: unknown): TemplateFillState[] {
    const byDoc = new Map<string, TemplateFillState>();
    for (const entry of Array.isArray(toolResults) ? toolResults : []) {
        const r = fillResult(entry);
        if (!r) continue;
        const before = byDoc.get(r.documentId);
        // Re-inserted, so a document keeps the place of its latest answer.
        byDoc.delete(r.documentId);
        byDoc.set(r.documentId, {
            documentId: r.documentId,
            name: text(r.name, before?.name ?? ''),
            url: text(r.url, `/app/studio/documents/${r.documentId}`),
            filled: count(r.filled),
            total: count(r.total),
            missing: missingLabels(r.missingRequired),
            finished: r.finished === true,
            format: r.format === 'pptx' ? 'pptx' : 'pdf',
        });
    }
    return [...byDoc.values()];
}
