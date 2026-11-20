/**
 * The form under a chat answer that fills in a template: read the document
 * with its fields (`GET /api/studio-documents/:id`, the contract and the
 * values it keeps in settings.sampleValues) and save values the person types
 * (`PUT /api/studio-documents/:id/values`, the same merge and type checks as
 * the assistant's template_fill_set_values, server/core/documents/templateValues.mts).
 */
import { apiJson } from './typedRequest';
import { downloadFilledDocument, type FilledDocumentFormat } from './filledDocumentDownload';

export interface FillField {
    key: string;
    type: string;
    label: string;
    required: boolean;
    help?: string;
    example?: unknown;
    options?: string[];
    fields?: FillField[];
}

export interface FillDocument {
    id: string;
    name: string;
    url: string;
    format: FilledDocumentFormat;
    editable: boolean;
    fields: FillField[];
    values: Record<string, unknown>;
    finished: boolean;
}

export interface FillProgress {
    values: Record<string, unknown>;
    missingRequired: Array<{ key: string; label: string }>;
    issues: string[];
    rejected: Array<{ key: string; message: string }>;
    complete: boolean;
    filled: number;
    total: number;
    finished: boolean;
}

export interface TemplateFillApi {
    load: (id: string) => Promise<FillDocument>;
    save: (id: string, values: Record<string, unknown>, finish?: boolean) => Promise<FillProgress>;
    download: (id: string, name: string, format: FilledDocumentFormat) => Promise<void>;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function fieldOf(raw: unknown): FillField | null {
    if (!isObject(raw) || typeof raw.key !== 'string' || !raw.key) return null;
    const help = text(raw.instructions) || text(raw.summary) || text(raw.help);
    return {
        key: raw.key,
        type: text(raw.type) || 'text',
        label: text(raw.label) || raw.key,
        required: raw.required === true,
        ...(help ? { help } : {}),
        ...(raw.example !== undefined ? { example: raw.example } : {}),
        ...(Array.isArray(raw.options) ? { options: raw.options.filter((o): o is string => typeof o === 'string') } : {}),
        ...(Array.isArray(raw.fields) ? { fields: raw.fields.map(fieldOf).filter((f): f is FillField => !!f) } : {}),
    };
}

/** The document as the form needs it, read defensively: the answer is the document route's. */
export function fillDocumentOf(body: unknown, id: string): FillDocument {
    const doc = isObject(body) && isObject(body.document) ? body.document : {};
    const settings = isObject(doc.settings) ? doc.settings : {};
    const contract = isObject(doc.contract) ? doc.contract : {};
    const link = isObject(settings.templateFill) ? settings.templateFill : {};
    return {
        id,
        name: text(doc.name),
        url: `/app/studio/documents/${encodeURIComponent(id)}`,
        format: doc.docType === 'presentation' ? 'pptx' : 'pdf',
        editable: doc.editable !== false,
        fields: (Array.isArray(contract.parameters) ? contract.parameters : []).map(fieldOf).filter((f): f is FillField => !!f),
        values: isObject(settings.sampleValues) ? { ...settings.sampleValues } : {},
        finished: typeof link.finishedAt === 'string',
    };
}

function progressOf(body: unknown): FillProgress {
    const b = isObject(body) ? body : {};
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    return {
        values: isObject(b.values) ? b.values : {},
        missingRequired: list<{ key: string; label: string }>(b.missingRequired),
        issues: list<string>(b.issues),
        rejected: list<{ key: string; message: string }>(b.rejected),
        complete: b.complete === true,
        filled: typeof b.filled === 'number' ? b.filled : 0,
        total: typeof b.total === 'number' ? b.total : 0,
        finished: b.finished === true,
    };
}

export const templateFillApi: TemplateFillApi = {
    load: async (id) => fillDocumentOf(await apiJson('GET /api/studio-documents/{id}', { params: { id } }), id),
    save: async (id, values, finish = false) => progressOf(await apiJson('PUT /api/studio-documents/{id}/values', {
        params: { id }, body: { values, ...(finish ? { finish: true } : {}) },
    })),
    download: downloadFilledDocument,
};
