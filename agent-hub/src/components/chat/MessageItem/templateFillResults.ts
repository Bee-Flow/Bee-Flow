/**
 * Which documents an answer filled in from a template, read off the turn's
 * template-fill tools (server/integrations/templateFillTools.mts). Every
 * answer of those tools starts with `{"documentId":"…"`, so the id survives
 * both the live result (`toolResults`) and the short preview a reloaded
 * message keeps (`toolHistory[].resultPreview`). The form under the answer
 * (TemplateFillCard) reads the document itself from that id.
 *
 * `revision` counts the results per document: a new one in a live turn makes
 * the form read the document again.
 */

const TEMPLATE_FILL_TOOLS = new Set(['template_fill_start', 'template_fill_set_values', 'template_fill_status', 'template_fill_finish']);
const ID_MARK = '"documentId":"';
const MAX_ID = 100;

export interface TemplateFillRef {
    documentId: string;
    revision: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The id after `"documentId":"` in a (possibly cut-off) JSON text, or null. */
function idInText(text: string): string | null {
    const at = text.indexOf(ID_MARK);
    if (at === -1) return null;
    const start = at + ID_MARK.length;
    const end = text.indexOf('"', start);
    if (end === -1 || end - start > MAX_ID || end === start) return null;
    return text.slice(start, end);
}

/** The document a template-fill entry answered about, or null (another tool, an error without a document). */
function documentIdOf(entry: unknown, resultField: 'result' | 'resultPreview'): string | null {
    if (!isObject(entry) || typeof entry.name !== 'string' || !TEMPLATE_FILL_TOOLS.has(entry.name)) return null;
    const result = entry[resultField];
    if (isObject(result)) return typeof result.documentId === 'string' && result.documentId ? result.documentId : null;
    return typeof result === 'string' ? idInText(result) : null;
}

export function templateFillRefs(toolResults: unknown, toolHistory: unknown): TemplateFillRef[] {
    const live = Array.isArray(toolResults) ? toolResults : [];
    // A live turn has both lists; the results are the full answers, so they count when there are any.
    const entries = live.length > 0
        ? live.map((e) => documentIdOf(e, 'result'))
        : (Array.isArray(toolHistory) ? toolHistory : []).map((e) => documentIdOf(e, 'resultPreview'));
    const byDoc = new Map<string, number>();
    for (const id of entries) if (id) byDoc.set(id, (byDoc.get(id) ?? 0) + 1);
    return [...byDoc].map(([documentId, revision]) => ({ documentId, revision }));
}
