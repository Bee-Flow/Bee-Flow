/**
 * The words a rule row is read in — a quantifier ("any attachment"), a File
 * type ("PDF", "Excel or CSV") and the entry a quantified row checks
 * ("attachment") — under the web's `condition_node.*` keys, so the phone says
 * what the browser says and a translation reaches both.
 */

import { FILE_TYPE_KEYS, parsePath, singularKey } from '@/shared/expr';
import { humanizeFieldKey } from '@/shared/lib/humanizeKey';

import type { Translate } from '../types';
import type { Quantifier } from './conditionModel';

const FILE_TYPE_EN: Record<string, string> = {
    pdf: 'PDF', word: 'Word', excel: 'Excel or CSV', powerpoint: 'PowerPoint', image: 'Image',
    text: 'Text', archive: 'Archive (zip)', audio: 'Audio', video: 'Video', other: 'Other',
};

const QUANTIFIER_EN: Record<Quantifier, string> = { any: 'any {name}', every: 'every {name}', none: 'no {name}' };

const fill = (text: string, vars: Record<string, string | number>): string => text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const say = (t: Translate | null, key: string, en: string, vars: Record<string, string | number> = {}): string => (t ? t(key, en, vars) : fill(en, vars));

/** Is this one of the File type keys (`pdf`, `word`, …)? */
export function isFileTypeKey(value: unknown): value is string {
    return typeof value === 'string' && (FILE_TYPE_KEYS as readonly string[]).includes(value);
}

/** "PDF", "Excel or CSV" — a File type key in words; an unknown key as itself. */
export function fileTypeLabel(key: string, t: Translate | null = null): string {
    const en = FILE_TYPE_EN[key];
    return en ? say(t, `condition_node.file_type.${key}`, en) : key;
}

/** The File type field's own name. */
export function fileTypeFieldLabel(t: Translate | null = null): string {
    return say(t, 'condition_node.file_type.label', 'File type');
}

/** Every File type, in the shared order, as select options. */
export function fileTypeOptions(t: Translate | null = null): { value: string; label: string }[] {
    return FILE_TYPE_KEYS.map((key) => ({ value: key, label: fileTypeLabel(key, t) }));
}

/** One entry of a list in words, lower case: `item.attachments` → "attachment" ("item" when the path has no key). */
export function singularName(listPath: unknown): string {
    const tokens = parsePath(String(listPath ?? ''));
    const key = tokens?.length ? (tokens[tokens.length - 1] as { key?: unknown }).key : null;
    return humanizeFieldKey(singularKey(typeof key === 'string' ? key : 'items')).toLowerCase();
}

/** Is this one of the three quantifiers? */
export function isQuantifier(value: unknown): value is Quantifier {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(QUANTIFIER_EN, value);
}

/** "any attachment", "every line", "no label". */
export function quantifierLabel(quantifier: Quantifier, name: string, t: Translate | null = null): string {
    return say(t, `condition_node.quantifier.${quantifier}`, QUANTIFIER_EN[quantifier], { name });
}
