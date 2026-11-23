/**
 * The fill-in form of a document made from a template (in the chat, in a
 * project's team chat and in the document editor): read the document with its
 * fields (`GET /api/studio-documents/:id`, the contract and the values it
 * keeps in settings.sampleValues), save values the person types
 * (`PUT /api/studio-documents/:id/values`, the same merge and type checks as
 * the assistant's template_fill_set_values, server/core/documents/templateValues.mts),
 * and let the assistant check what is filled in
 * (`POST /api/studio-documents/:id/values/review`).
 *
 * Every answer carries what is shown next to the values (`FillTeam`): the
 * colleagues' requests, who filled in what, the notes people left each other
 * and the final check's remarks.
 */
import { apiJson } from './typedRequest';
import { downloadFilledDocument, type FilledDocumentFormat } from './filledDocumentDownload';
import { filingApi, type FilingApi } from './documentFilingApi';
import { fillTeamApi, teamOf, type FillTeam, type FillTeamApi } from './templateFillTeamApi';

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
    /** The project the document is filed in, when it is: people fill it in together there. */
    projectId?: string | null;
    team?: FillTeam;
    versionId?: string | null;
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
    team?: FillTeam;
    versionId?: string | null;
}

export interface SaveOptions {
    /** Mark the fill finished when nothing required is missing. */
    finish?: boolean;
    /** Take the final check's remark off these fields: the person keeps their value. */
    dismiss?: string[];
}

export interface TemplateFillApi {
    load: (id: string) => Promise<FillDocument>;
    save: (id: string, values: Record<string, unknown>, options?: SaveOptions) => Promise<FillProgress>;
    /** The assistant's final check of what is filled in; its remarks come back in `team.review`. */
    review?: (id: string) => Promise<FillProgress>;
    download: (id: string, name: string, format: FilledDocumentFormat) => Promise<void>;
    /** Tagging colleagues and notes, in a project. */
    team?: FillTeamApi;
    /** Saving the document in a project and a folder of it. */
    filing?: FilingApi;
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

/** Where its readers open it: in the project when it is filed in one, else in the library. */
function openUrl(id: string, projectId: string | null): string {
    return projectId
        ? `/app/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(id)}`
        : `/app/studio/documents/${encodeURIComponent(id)}`;
}

/** What the document's settings keep for the form: the values, whether it is finished, and the team's part. */
function settingsPart(settings: Record<string, unknown>): Pick<FillDocument, 'values' | 'finished' | 'team'> {
    const values = isObject(settings.sampleValues) ? { ...settings.sampleValues } : {};
    const link = isObject(settings.templateFill) ? settings.templateFill : {};
    return {
        values, finished: typeof link.finishedAt === 'string',
        team: teamOf({ filledBy: settings.filledBy, review: settings.fillReview, notes: settings.fieldNotes, requests: settings.valueRequests }, values),
    };
}

/** The document as the form needs it, read defensively: the answer is the document route's. */
export function fillDocumentOf(body: unknown, id: string): FillDocument {
    const doc = isObject(body) && isObject(body.document) ? body.document : {};
    const contract = isObject(doc.contract) ? doc.contract : {};
    const projectId = typeof doc.projectId === 'string' && doc.projectId ? doc.projectId : null;
    return {
        id,
        name: text(doc.name),
        url: openUrl(id, projectId),
        format: doc.docType === 'presentation' ? 'pptx' : 'pdf',
        editable: doc.editable !== false,
        fields: (Array.isArray(contract.parameters) ? contract.parameters : []).map(fieldOf).filter((f): f is FillField => !!f),
        ...settingsPart(isObject(doc.settings) ? doc.settings : {}),
        canFile: doc.deletable === true && !projectId && doc.kind === 'document',
        projectId,
        versionId: typeof doc.versionId === 'string' ? doc.versionId : null,
    };
}

/** Where the filling stands, as every route of the form answers it. */
export function progressOf(body: unknown): FillProgress {
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
        team: teamOf(b),
        versionId: typeof b.versionId === 'string' ? b.versionId : null,
    };
}

export const templateFillApi: TemplateFillApi = {
    load: async (id) => fillDocumentOf(await apiJson('GET /api/studio-documents/{id}', { params: { id } }), id),
    save: async (id, values, options = {}) => progressOf(await apiJson('PUT /api/studio-documents/{id}/values', {
        params: { id }, body: { values, ...(options.finish ? { finish: true } : {}), ...(options.dismiss?.length ? { dismiss: options.dismiss } : {}) },
    })),
    review: async (id) => progressOf(await apiJson('POST /api/studio-documents/{id}/values/review', { params: { id }, body: {} })),
    download: downloadFilledDocument,
    team: fillTeamApi,
    filing: filingApi,
};
