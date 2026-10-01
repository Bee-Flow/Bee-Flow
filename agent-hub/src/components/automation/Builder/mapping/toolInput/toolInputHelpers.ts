// Small, pure readings of one tool parameter's JSON schema, for the
// schema-driven inputs editor (ToolInputForm).
import { humanizeKey } from '@shared/mapping/index.mjs';

export interface SchemaProp {
    type?: string | string[];
    title?: string;
    description?: string;
    format?: string;
    enum?: unknown[];
    default?: unknown;
    example?: unknown;
    items?: { type?: string };
    [key: string]: unknown;
}

/** A placeholder that shows the shape of a good value. */
export function describeExample(prop: SchemaProp | null | undefined): string {
    if (!prop) return '';
    if (prop.example != null) return String(prop.example);
    if (prop.default != null) return String(prop.default);
    if (prop.enum && prop.enum.length) return `one of: ${prop.enum.slice(0, 3).join(', ')}${prop.enum.length > 3 ? '…' : ''}`;
    if (prop.type === 'string') return '';
    if (prop.type === 'number' || prop.type === 'integer') return 'e.g. 42';
    if (prop.type === 'boolean') return 'true / false';
    if (prop.type === 'array') return '[…]';
    if (prop.type === 'object') return '{…}';
    return '';
}

/**
 * The name a person reads for a parameter: its schema title; else its
 * description when that is a short name rather than a sentence ("Recipient
 * e-mail address"); else the key made readable (`to` → "To", `body_html` →
 * "Body HTML"). Never the raw key.
 */
export function paramLabel(key: string, prop: SchemaProp | null | undefined): string {
    const title = typeof prop?.title === 'string' ? prop.title.trim() : '';
    if (title) return title;
    const description = typeof prop?.description === 'string' ? prop.description.trim().replace(/\.$/, '') : '';
    if (description && description.length <= 40 && !/[.:;!?(]/.test(description) && description.split(/\s+/).length <= 5) {
        return description.charAt(0).toUpperCase() + description.slice(1);
    }
    return humanizeKey(key) || key;
}

/** Long-text parameters get a multi-line editor: by format, or by a telling name. */
export function isMultilineProp(prop: SchemaProp | null | undefined): boolean {
    if (!prop) return false;
    if (prop.format === 'multiline' || prop.format === 'textarea') return true;
    const name = (prop.title || '').toLowerCase();
    return /body|message|prompt|content|description|notes/.test(name);
}

/** Enums short enough to read as buttons (round 4: "choices as buttons"). */
export const ENUM_BUTTON_MAX = 4;

/** The options of a short enum, or null when it should stay a field. */
export function shortEnum(prop: SchemaProp | null | undefined): string[] | null {
    const list = Array.isArray(prop?.enum) ? prop.enum : null;
    if (!list || list.length < 2 || list.length > ENUM_BUTTON_MAX) return null;
    if (list.some(v => v == null || typeof v === 'object')) return null;
    return list.map(v => String(v));
}

/**
 * "More options · version · encoding · max size": the first names of the
 * folded settings, so the fold says what is in it before it is opened.
 */
export function foldedNames(labels: string[], n = 3): string {
    return labels.slice(0, n).join(' · ') + (labels.length > n ? ' · …' : '');
}
