/**
 * What a file-type suggestion reads (spec S1, S4) — the half of
 * routeIntents.js that decides WHICH value a "pdf / word / powerpoint" rule
 * looks at. Pure, like the catalogue it serves.
 *
 * Three shapes, most specific first:
 *  - each item IS a file (a Drive file, an attachment): `fileType(item)`;
 *  - each item HOLDS a list of files (a mail and its attachments):
 *    `anyOf(fileType(item.attachments[*]), "equals", "pdf")`, which checks
 *    every attachment instead of the last one, and the answer carries
 *    `filesInside` so the box can offer to work through the files instead;
 *  - each item only has a text field holding a file name:
 *    `fileType(item.filename)`.
 * The type of a file comes from the shared `fileType()` (MIME type, else the
 * extension), so the preview, the rule rows and the run agree on what a PDF is.
 */
import { appendKey, pathKeys } from '@shared/expr/path.mjs';
import { fieldShape, fileTypeField, isFileRecord, quantifiedCall } from '@shared/expr/rules.mjs';

export interface FileFieldOption {
    path: string;
    label?: string;
    sample?: unknown;
    group?: string;
    quantified?: boolean;
    kind?: string;
}

export interface FilesInside {
    /** The list inside each item, relative to the item: `item.attachments`. */
    listPath: string;
    /** Its last key: `attachments`. */
    listKey: string;
}

export interface FileTarget {
    field: FileFieldOption;
    expr: (key: string) => string;
    filesInside: FilesInside | null;
}

// The words that make a sentence "about files" without naming a type
// ("split the attachments"): enough to offer working through the files
// themselves, never enough to guess which types were meant.
const FILE_WORDS = new Set(['file', 'files', 'attachment', 'attachments', 'document', 'documents']);

const FILE_TYPE_LABEL = 'File type';

const quote = (value: string): string => JSON.stringify(String(value));

/**
 * A field option that is one value per item: not a list column (those are
 * quantified), not a list of records, not a File type entry. The rule rows'
 * menu (shared ruleFieldOptions) offers all of these; only plain ones may be
 * compared directly.
 */
export function isPlainOption(f: FileFieldOption | null | undefined): boolean {
    const path = String(f?.path || '');
    return !f?.quantified && !f?.kind && !path.includes('[*]') && !path.startsWith('fileType(');
}

function optionFor(fields: FileFieldOption[], path: string): FileFieldOption {
    return (fields || []).find(f => f?.path === path) || { path, label: FILE_TYPE_LABEL };
}

/** Does each item ITSELF look like a file: its sample, or the File type entry the menu offers for it? */
export function itemIsFile(element: unknown, fields: FileFieldOption[]): boolean {
    return isFileRecord(element) || (fields || []).some(f => f?.path === fileTypeField('item'));
}

/** The first entry of a list that is not null; undefined for anything else. */
function firstRecord(value: unknown): unknown {
    return Array.isArray(value) ? value.find(v => v != null) : undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The key of the first list of files inside each item ("attachments" of a
 * mail), from the item sample, else from the field options; null when none.
 */
export function filesListKey(element: unknown, fields: FileFieldOption[]): string | null {
    if (isRecord(element)) {
        for (const [key, value] of Object.entries(element)) {
            if (isFileRecord(firstRecord(value))) return key;
        }
    }
    for (const f of (fields || [])) {
        const keys = pathKeys(f?.path);
        if (keys?.length === 2 && keys[0] === 'item' && isFileRecord(firstRecord(f.sample))) return String(keys[1]);
    }
    return null;
}

const itemTarget = (fields: FileFieldOption[]): FileTarget => ({
    field: optionFor(fields, fileTypeField('item')),
    expr: (key) => `equals(${fileTypeField('item')}, ${quote(key)})`,
    filesInside: null,
});

/** Every file of the list `listPath` (`item.attachments`), any of them passing. */
export function listTarget(listPath: string, fields: FileFieldOption[]): FileTarget {
    const left = fileTypeField(listPath, { list: true });
    const keys = pathKeys(listPath) || [];
    return {
        field: optionFor(fields, left),
        expr: (key) => quantifiedCall('any', left, 'is', quote(key)),
        filesInside: { listPath, listKey: String(keys[keys.length - 1] ?? '') },
    };
}

const valueTarget = (field: FileFieldOption): FileTarget => ({
    field,
    expr: (key) => `equals(${fileTypeField(field.path)}, ${quote(key)})`,
    filesInside: null,
});

/** Is `listPath` (`item.<key>`) a list of files: by the item sample, or by the File type entry the menu offers for it? */
function isFilesList(listPath: string, element: unknown, fields: FileFieldOption[]): boolean {
    const keys = pathKeys(listPath);
    if (keys?.length !== 2 || keys[0] !== 'item') return false;
    const value = isRecord(element) ? element[String(keys[1])] : undefined;
    return isFileRecord(firstRecord(value))
        || (fields || []).some(f => f?.path === fileTypeField(listPath, { list: true }));
}

/** A field the author named, as a file-type target; null when it cannot be one. */
function namedTarget(named: FileFieldOption, element: unknown, fields: FileFieldOption[]): FileTarget | null {
    const shape = fieldShape(named.path) as { kind: string; record?: string; list?: string } | null;
    if (shape?.kind === 'fileRecord' && shape.record) {
        return shape.record === 'item' ? itemTarget(fields) : valueTarget({ ...named, path: shape.record });
    }
    if ((shape?.kind === 'fileList' || shape?.kind === 'column') && shape.list) {
        return isFilesList(shape.list, element, fields) ? listTarget(shape.list, fields) : null;
    }
    if (isFileRecord(firstRecord(named.sample))) return listTarget(named.path, fields);
    return isPlainOption(named) && !Array.isArray(named.sample) ? valueTarget(named) : null;
}

interface FileTargetInput {
    named: FileFieldOption | null;
    element: unknown;
    fields: FileFieldOption[];
    /** routeIntents' scorer for a text field holding a file name. */
    pickField: (fields: FileFieldOption[]) => FileFieldOption | null;
}

/**
 * What a file-type rule reads, most specific first: the field the author
 * named; the item itself when it is a file; every file of a list inside the
 * item; else a text field that holds a file name. Null when none fits.
 */
export function fileTarget({ named, element, fields, pickField }: FileTargetInput): FileTarget | null {
    const fromName = named ? namedTarget(named, element, fields) : null;
    if (fromName) return fromName;
    if (itemIsFile(element, fields)) return itemTarget(fields);
    const listKey = filesListKey(element, fields);
    if (listKey) return listTarget(appendKey('item', listKey), fields);
    const field = pickField((fields || []).filter(isPlainOption));
    return field ? valueTarget(field) : null;
}

/** Does the sentence talk about files ("the attachments", "these documents")? */
export function mentionsFiles(lower: string): boolean {
    return lower.split(/[^a-z0-9]+/).some(w => FILE_WORDS.has(w));
}
