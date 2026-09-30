/**
 * Studio Documents, as /api/studio-documents serves them
 * (server/routes/studioDocuments.js over stores/documentStore.js mapRow and
 * mapListRow, with the contract from core/documents/documentContract.js).
 *
 * A document is two slots — `bodyHtml` (for a presentation: a text outline)
 * and `css` — plus `settings`, an open object that carries the contract
 * (typed parameters and conditional sections), the customer values, the
 * design and the per-document house-style switch.
 */

/** stores/documentStore.js DOC_TYPES. */
export const DOC_TYPES = ['invoice', 'quote', 'letter', 'report', 'security', 'document', 'presentation'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_KINDS = ['document', 'template', 'section'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export type Visibility = 'private' | 'team';

/** core/documents/documentContract.js TYPES. */
export const PARAM_TYPES = ['text', 'number', 'boolean', 'date', 'choice', 'list'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/** core/documents/documentContract.js OPERATORS. */
export const OPERATORS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_set'] as const;
export type Operator = (typeof OPERATORS)[number];

export interface ContractParameter {
    key: string;
    type: ParamType;
    label: string;
    required: boolean;
    summary: string;
    instructions: string;
    example?: unknown;
    default?: unknown;
    options?: string[];
    fields?: ContractParameter[];
    /** Found in the body or a rule but never declared. */
    inferred?: boolean;
}

export interface Rule {
    parameter: string;
    operator: Operator;
    value?: unknown;
}
export type Condition = { all: Condition[] } | { any: Condition[] } | Rule;

export interface ContractSection {
    id: string;
    title: string;
    summary: string;
    condition: Condition | null;
    source?: { documentId: string; versionId: string };
    parentId?: string | null;
}

export interface DocumentContract {
    instructions: string;
    parameters: ContractParameter[];
    sections: ContractSection[];
}

/** One row of the list: no slots (mapListRow). */
export interface StudioDocumentRow {
    id: string;
    name: string;
    docType: string;
    description: string;
    kind: DocKind;
    visibility: Visibility;
    categories: string[];
    versionId: string | null;
    htmlSize: number;
    updatedAt: string | null;
}

export type DocumentSettings = Record<string, unknown>;

/** One document with its slots, the caller's right to edit it and its contract. */
export interface StudioDocument extends StudioDocumentRow {
    bodyHtml: string;
    css: string;
    settings: DocumentSettings;
    editable: boolean;
    contract: DocumentContract;
}

export interface DocumentVersion {
    id: string;
    summary: string;
    createdAt: string | null;
}

/** A starting point from GET /starters (core/documents/documentStarters.js). */
export interface DocumentStarter {
    id: string;
    name: string;
    docType: string;
    description: string;
    parameterCount: number;
}

export type SectionState = 'included' | 'excluded' | 'unresolved';

export interface ValidationIssue {
    code: string;
    message: string;
    key?: string;
    sectionId?: string;
}

/** POST /:id/validate: prepareDocument's verdict (the composed HTML is not read). */
export interface ValidationResult {
    valid: boolean;
    issues: ValidationIssue[];
    sections: { id: string; title: string; state: SectionState; reason: string }[];
}

/** The fields a PATCH may carry (documentStore.updateDocument's key list). */
export interface DocumentPatch {
    name?: string;
    docType?: string;
    description?: string;
    bodyHtml?: string;
    settings?: DocumentSettings;
    kind?: DocKind;
    visibility?: Visibility;
    categories?: string[];
    summary?: string;
}

export interface DocumentFilters {
    kind: DocKind;
    /** '' lists pages and presentations; 'page' is every type but presentations. */
    format: '' | 'page' | 'presentation';
    query: string;
}
