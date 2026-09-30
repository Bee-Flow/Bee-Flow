/**
 * The page a form DECLARATION would render as — for the Questions tab's
 * preview, which shows the author the same control a colleague fills in.
 *
 * A light copy of the server's normalizeFields/renderFormConfig
 * (formTriggerContract.js), for display only: nothing here is sent, and the
 * real page is always the server's. Invalid fields are dropped, as there.
 */

import { DEFAULT_UPLOAD_MB, FIELD_TYPES, MAX_OPTIONS, MAX_UPLOAD_MB } from './contract';
import type { FillField, FillForm, FillOption } from './fillTypes';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function optionsOf(raw: unknown): FillOption[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((o) => {
            const value = typeof o === 'string' ? o : str((o as { value?: unknown } | null)?.value);
            const label = typeof o === 'string' ? o : str((o as { label?: unknown } | null)?.label) || value;
            return value.trim() ? { value, label } : null;
        })
        .filter((o): o is FillOption => o !== null)
        .slice(0, MAX_OPTIONS);
}

function sizeOf(raw: unknown): number {
    const mb = Number(raw);
    return Number.isFinite(mb) && mb > 0 ? Math.min(MAX_UPLOAD_MB, Math.ceil(mb)) : DEFAULT_UPLOAD_MB;
}

function fieldOf(raw: Record<string, unknown>): FillField {
    const type = (FIELD_TYPES as readonly string[]).includes(str(raw.type)) ? str(raw.type) : 'text';
    const name = str(raw.name);
    return {
        name,
        type,
        label: str(raw.label).trim() || name,
        required: raw.required === true,
        placeholder: str(raw.placeholder),
        help: str(raw.help),
        options: type === 'select' ? optionsOf(raw.options) : [],
        accept: str(raw.accept),
        maxSizeMb: sizeOf(raw.maxSizeMb),
        source: str(raw.source),
        app: str(raw.sourceLabel) || str(raw.source),
        sourceLabel: str(raw.sourceLabel),
        searchHint: str(raw.searchHint),
        multiple: raw.multiple === true,
        maxItems: Number(raw.maxItems) || 5,
        fileId: str(raw.fileId),
        filename: '',
        mimeType: '',
        size: null,
    };
}

export function previewFields(raw: unknown): FillField[] {
    const seen = new Set<string>();
    const out: FillField[] = [];
    for (const f of Array.isArray(raw) ? raw : []) {
        if (!f || typeof f !== 'object') continue;
        const field = fieldOf(f as Record<string, unknown>);
        if (!NAME_RE.test(field.name) || seen.has(field.name)) continue;
        seen.add(field.name);
        out.push(field);
    }
    return out;
}

export function previewForm(declaration: Record<string, unknown> | null | undefined): FillForm {
    const d = declaration ?? {};
    const theme = d.theme && typeof d.theme === 'object' ? (d.theme as Record<string, unknown>) : null;
    return {
        title: str(d.title).trim() || 'Form',
        description: str(d.description),
        submitLabel: str(d.submitLabel).trim() || 'Submit',
        successMessage: str(d.successMessage).trim() || 'Thanks — we got your answer.',
        theme,
        fields: previewFields(d.fields),
        multiPage: false,
    };
}
