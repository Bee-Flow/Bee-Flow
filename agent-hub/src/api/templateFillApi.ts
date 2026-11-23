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
    /** One short line for under the label (the contract's summary). */
    help?: string;
    /** The full instructions, shown on request. */
    details?: string;
    example?: unknown;
    /** The contract's default: offered as a suggestion, never counted as filled in. */
    suggestion?: unknown;
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
    /** The person's own document, not in a project yet: it can be added to one. */
    canFile?: boolean;
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

const HELP_MAX = 140;

/** The first sentence of a long instruction, cut at a word when it runs on. */
function firstSentence(textValue: string): string {
    const flat = textValue.split('\n').join(' ').trim();
    const stop = flat.indexOf('. ');
    const sentence = stop > 0 ? flat.slice(0, stop + 1) : flat;
    if (sentence.length <= HELP_MAX) return sentence;
    const cut = sentence.slice(0, HELP_MAX);
    const space = cut.lastIndexOf(' ');
    return `${cut.slice(0, space > 40 ? space : HELP_MAX).trimEnd()}…`;
}

/** The short line under the label, the full instructions behind it, and the default to offer. */
function guidanceOf(raw: Record<string, unknown>): Pick<FillField, 'help' | 'details' | 'suggestion'> {
    const instructions = text(raw.instructions) || text(raw.help);
    const help = text(raw.summary) || firstSentence(instructions);
    const details = instructions && instructions !== help ? instructions : '';
    const hasDefault = raw.default !== undefined && raw.default !== null && raw.default !== '';
    return {
        ...(help ? { help } : {}),
        ...(details ? { details } : {}),
        ...(hasDefault ? { suggestion: raw.default } : {}),
    };
}

function fieldOf(raw: unknown): FillField | null {
    if (!isObject(raw) || typeof raw.key !== 'string' || !raw.key) return null;
    return {
        key: raw.key,
        type: text(raw.type) || 'text',
        label: text(raw.label) || raw.key,
        required: raw.required === true,
        ...guidanceOf(raw),
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
        canFile: doc.deletable === true && !doc.projectId && doc.kind === 'document',
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
