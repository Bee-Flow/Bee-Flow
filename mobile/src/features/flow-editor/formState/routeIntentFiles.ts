/**
 * "Suggest outputs", the file half: WHICH value a "pdf / word / powerpoint"
 * rule reads (spec S1, S4). The web keeps the same decisions in
 * `Builder/flow/settings/routeIntentsFiles.ts`; settings.lockstep.test.ts runs
 * both on the same sentences, items and field menus.
 *
 * Most specific first:
 *  - a field the author named (a File type entry, a list of files, a name field);
 *  - each item IS a file: `equals(fileType(item), "pdf")`;
 *  - each item HOLDS files (a mail's attachments):
 *    `anyOf(fileType(item.attachments[*]), "equals", "pdf")`, so every
 *    attachment is checked, and the answer says where the files sit
 *    (`filesInside`) so the box can offer to work through them instead;
 *  - a text field holding a file name: `equals(fileType(item.filename), "pdf")`.
 * What a file's type IS comes from the shared `fileType()`, the run's own.
 */

import { translate as t } from '@/core/i18n';
import { appendKey, fieldShape, fileTypeField, isFileRecord, pathKeys, quantifiedCall } from '@/shared/expr';

import type { IntentField } from './routeIntentFields';

/** The list of files inside each item: `{ listPath: 'item.attachments', listKey: 'attachments' }`. */
export interface FilesInside {
    listPath: string;
    listKey: string;
}

export interface FileTarget {
    field: IntentField;
    expr: (key: string) => string;
    filesInside: FilesInside | null;
}

/** Words that make a sentence about files without naming a type. */
const FILE_WORDS: ReadonlySet<string> = new Set(['file', 'files', 'attachment', 'attachments', 'document', 'documents']);

/** Does the sentence talk about files ("the attachments", "these documents")? */
export const mentionsFiles = (lower: string): boolean => lower.split(/[^a-z0-9]+/).some((word) => FILE_WORDS.has(word));

/**
 * One value per item: no list column, no list of records, no File type entry.
 * Only these are compared directly; the rest need a quantifier.
 */
export function isPlainOption(field: IntentField | null | undefined): boolean {
    if (field?.quantified || field?.kind) return false;
    const path = String(field?.path || '');
    return !path.startsWith('fileType(') && !path.includes('[*]');
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const firstOf = (value: unknown): unknown => (Array.isArray(value) ? value.find((entry) => entry != null) : undefined);

const offers = (fields: IntentField[] | null | undefined, path: string): boolean => (fields || []).some((f) => f?.path === path);

/** The menu's own entry for `path`, else a bare "File type" one. */
const entryFor = (fields: IntentField[], path: string): IntentField =>
    (fields || []).find((f) => f?.path === path) ?? { path, label: t('condition_node.file_type.label', 'File type') };

/** Is each item itself a file, by its sample or by the File type entry the menu offers for it? */
export const itemIsFile = (element: unknown, fields: IntentField[]): boolean => isFileRecord(element) || offers(fields, fileTypeField('item'));

/** The key of the first list of files in each item (a mail's "attachments"), from the sample, else the menu; null when none. */
export function filesListKey(element: unknown, fields: IntentField[]): string | null {
    const record = asRecord(element);
    const fromSample = record ? Object.keys(record).find((key) => isFileRecord(firstOf(record[key]))) : undefined;
    if (fromSample !== undefined) return fromSample;
    for (const f of fields || []) {
        const keys = pathKeys(f?.path);
        if (keys && keys.length === 2 && keys[0] === 'item' && isFileRecord(firstOf(f.sample))) return String(keys[1]);
    }
    return null;
}

const quoted = (key: string): string => JSON.stringify(String(key));

/** Every file of `listPath` (`item.attachments`), any one of them passing. */
export function listTarget(listPath: string, fields: IntentField[]): FileTarget {
    const left = fileTypeField(listPath, { list: true });
    const keys = pathKeys(listPath) ?? [];
    const listKey = String(keys.length ? keys[keys.length - 1] : '');
    return { field: entryFor(fields, left), filesInside: { listPath, listKey }, expr: (key) => quantifiedCall('any', left, 'is', quoted(key)) };
}

/** One value read with fileType(): the item itself (`record` 'item') or a field holding a file name. */
function oneValueTarget(record: string, field: IntentField): FileTarget {
    const left = fileTypeField(record);
    return { field, filesInside: null, expr: (key) => `equals(${left}, ${quoted(key)})` };
}

const itemTarget = (fields: IntentField[]): FileTarget => oneValueTarget('item', entryFor(fields, fileTypeField('item')));

/** Is `listPath` (`item.<key>`) a list of files: by the item's sample or by the menu's File type entry for it? */
function holdsFiles(listPath: string, element: unknown, fields: IntentField[]): boolean {
    const keys = pathKeys(listPath);
    if (!keys || keys.length !== 2 || keys[0] !== 'item') return false;
    return isFileRecord(firstOf(asRecord(element)?.[String(keys[1])])) || offers(fields, fileTypeField(listPath, { list: true }));
}

/** The field the author named, as what a file-type rule reads; null when it cannot be one. */
function namedTarget(named: IntentField, element: unknown, fields: IntentField[]): FileTarget | null {
    const shape = fieldShape(named.path);
    if (shape?.kind === 'fileRecord') {
        return shape.record === 'item' ? itemTarget(fields) : oneValueTarget(shape.record, { ...named, path: shape.record });
    }
    if (shape?.kind === 'fileList' || shape?.kind === 'column') return holdsFiles(shape.list, element, fields) ? listTarget(shape.list, fields) : null;
    if (isFileRecord(firstOf(named.sample))) return listTarget(String(named.path), fields);
    if (!isPlainOption(named) || Array.isArray(named.sample)) return null;
    return oneValueTarget(String(named.path), named);
}

/**
 * What a file-type rule reads: the named field; the item when it is a file;
 * every file of a list inside the item; a text field holding a file name
 * (`pickField`, the catalogue's scorer). Null when nothing fits.
 */
export function fileTarget(
    named: IntentField | null,
    element: unknown,
    fields: IntentField[],
    pickField: (plain: IntentField[]) => IntentField | null,
): FileTarget | null {
    const fromName = named ? namedTarget(named, element, fields) : null;
    if (fromName) return fromName;
    if (itemIsFile(element, fields)) return itemTarget(fields);
    const listKey = filesListKey(element, fields);
    if (listKey) return listTarget(appendKey('item', listKey), fields);
    const field = pickField((fields || []).filter(isPlainOption));
    return field ? oneValueTarget(String(field.path), field) : null;
}
