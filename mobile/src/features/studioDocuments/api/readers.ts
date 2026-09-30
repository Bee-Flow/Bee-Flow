/**
 * Contract readers for /api/studio-documents: stores/documentStore.js mapRow
 * and mapListRow for a document, getContract in
 * core/documents/documentContract.js for its contract, and the route's own
 * envelopes (server/routes/studioDocuments.js).
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import { DOC_KINDS, OPERATORS, PARAM_TYPES } from '../model/types';
import type {
    Condition,
    ContractParameter,
    ContractSection,
    DocumentContract,
    DocumentStarter,
    DocumentVersion,
    StudioDocument,
    StudioDocumentRow,
    ValidationResult,
} from '../model/types';

type Loose = Record<string, unknown>;
const asObject = (raw: unknown): Loose => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Loose) : {});

const rowSpec = {
    id: field.str(''),
    name: field.str(''),
    docType: field.str('document'),
    description: field.str(''),
    kind: field.oneOf(DOC_KINDS, 'document'),
    visibility: field.oneOf(['private', 'team'] as const, 'private'),
    categories: field.strArray,
    versionId: field.strOrNull,
    htmlSize: field.num(0),
    updatedAt: field.strOrNull,
};

const readRow = shapeOf(rowSpec);

export function readDocumentList(raw: unknown): StudioDocumentRow[] {
    return shapeListOf(rowSpec)(pick(raw, 'documents'));
}

function readParameter(raw: unknown, nested = false): ContractParameter {
    const p = asObject(raw);
    const out: ContractParameter = {
        key: field.str('')(p.key),
        type: field.oneOf(PARAM_TYPES, 'text')(p.type),
        label: field.str('')(p.label),
        required: p.required === true,
        summary: field.str('')(p.summary),
        instructions: field.str('')(p.instructions),
    };
    if (p.example !== undefined) out.example = p.example;
    if (p.default !== undefined) out.default = p.default;
    if (Array.isArray(p.options)) out.options = field.strArray(p.options);
    if (!nested && Array.isArray(p.fields)) out.fields = p.fields.map((f) => readParameter(f, true));
    if (p.inferred === true) out.inferred = true;
    return out;
}

/** A section rule, read as deep as it goes; anything unrecognisable is dropped. */
export function readCondition(raw: unknown): Condition | null {
    const c = asObject(raw);
    if (Array.isArray(c.all)) return { all: c.all.map(readCondition).filter((x): x is Condition => x !== null) };
    if (Array.isArray(c.any)) return { any: c.any.map(readCondition).filter((x): x is Condition => x !== null) };
    if (typeof c.parameter !== 'string') return null;
    const rule = { parameter: c.parameter, operator: field.oneOf(OPERATORS, 'equals')(c.operator) };
    return c.value === undefined ? rule : { ...rule, value: c.value };
}

function readSection(raw: unknown): ContractSection {
    const s = asObject(raw);
    const source = asObject(s.source);
    return {
        id: field.str('')(s.id),
        title: field.str('')(s.title),
        summary: field.str('')(s.summary),
        condition: readCondition(s.condition),
        ...(typeof source.documentId === 'string'
            ? { source: { documentId: source.documentId, versionId: field.str('')(source.versionId) } }
            : {}),
        parentId: field.strOrNull(s.parentId),
    };
}

export function readContract(raw: unknown): DocumentContract {
    const c = asObject(raw);
    return {
        instructions: field.str('')(c.instructions),
        parameters: field.list((p) => readParameter(p))(c.parameters),
        sections: field.list(readSection)(c.sections),
    };
}

/**
 * One document. GET /:id carries `editable` and the computed contract; PATCH
 * answers the contract without `editable`, and a restore answers neither —
 * `editable` falls back to `previous` there, the contract to the stored one.
 */
export function readDocument(raw: unknown, previous?: Pick<StudioDocument, 'editable'>): StudioDocument | null {
    const doc = pick(raw, 'document');
    if (!doc || typeof doc !== 'object') return null;
    const d = asObject(doc);
    const settings = asObject(d.settings);
    return {
        ...readRow(d),
        bodyHtml: field.str('')(d.bodyHtml),
        css: field.str('')(d.css),
        settings,
        editable: field.optBool(d.editable) ?? previous?.editable ?? true,
        contract: readContract(d.contract ?? settings.contract),
    };
}

export function readVersions(raw: unknown): DocumentVersion[] {
    return shapeListOf({ id: field.str(''), summary: field.str(''), createdAt: field.strOrNull })(pick(raw, 'versions'));
}

export function readStarters(raw: unknown): DocumentStarter[] {
    const rows = pick(raw, 'starters');
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
        const s = asObject(row);
        const params = asObject(asObject(s.settings).contract).parameters;
        return {
            id: field.str('')(s.id),
            name: field.str('')(s.name),
            docType: field.str('document')(s.docType),
            description: field.str('')(s.description),
            parameterCount: Array.isArray(params) ? params.length : 0,
        };
    });
}

const SECTION_STATES = ['included', 'excluded', 'unresolved'] as const;

export function readValidation(raw: unknown): ValidationResult {
    const r = asObject(raw);
    return {
        valid: r.valid === true,
        issues: shapeListOf({ code: field.str(''), message: field.str(''), key: field.optStr, sectionId: field.optStr })(r.issues),
        sections: shapeListOf({
            id: field.str(''),
            title: field.str(''),
            state: field.oneOf(SECTION_STATES, 'unresolved'),
            reason: field.str(''),
        })(r.sections),
    };
}
