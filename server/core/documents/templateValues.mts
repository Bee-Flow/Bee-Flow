/**
 * The field values of a document made from a template: merge what is given
 * into what is stored, coerce and type-check each value against the
 * document's contract (core/documents/documentContract.js), save them where
 * the document editor keeps them (settings.sampleValues, which the PDF and
 * PowerPoint routes render), and say where the filling stands.
 *
 * ONE implementation for both writers: the chat's template-fill tools
 * (integrations/templateFillTools.mts) and the form under the chat answer
 * (PUT /api/studio-documents/:id/values, routes/studioDocuments/templateValues.mts).
 * Whatever one accepts, the other accepts; whatever one refuses, the other
 * refuses with the same reason.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type Settings = Record<string, unknown>;
export type TemplateDoc = {
    id: string, name: string, userId?: string, kind?: string, docType?: string, description?: string | null,
    bodyHtml?: string, css?: string, settings?: Settings | null, categories?: unknown,
    projectRole?: string | null, sharingRole?: string | null, versionId?: string | null,
};
export type Field = {
    key: string, type: string, label: string, required: boolean, summary?: string, instructions?: string,
    example?: unknown, default?: unknown, options?: string[], fields?: Field[],
};
export type Contract = { parameters: Field[], instructions?: string };
type Issue = { code: string, key?: string, message: string };
export type ContractModule = {
    getContract: (doc: TemplateDoc) => Contract,
    prepareDocument: (doc: TemplateDoc, values: Settings, overrides: Settings) => { valid: boolean, issues: Issue[] },
    coerceNumber: (value: unknown) => unknown,
    coerceNumberParams: (params: Field[] | undefined, scope: Settings) => void,
    typeValid: (p: Field, value: unknown) => boolean,
    hasThousandsSeparator: (text: string) => boolean,
};
export type ValuesStore = {
    getDocument: (id: string, userId: string) => Promise<TemplateDoc | null>,
    updateDocument: (id: string, userId: string, updates: Record<string, unknown>) => Promise<TemplateDoc | null>,
};
export type Rejected = { key: string, message: string };
export type Progress = {
    missingRequired: Array<{ key: string, label: string }>, issues: string[], complete: boolean, filled: number, total: number,
};
/** Who wrote the values: the assistant (an AI revision) or the person in the form. */
export type Origin = 'ai' | 'user';
/** A check on each given value before it is typed: a reason refuses it (the tools refuse masked Privacy Shield tokens). */
export type ValueGuard = (key: string, value: unknown) => string | null;

export const MAX_VALUES = 200;
const MAX_TEXT = 20000;

export const contractModule = (): ContractModule => nodeRequire('./documentContract');
export const isObject = (v: unknown): v is Settings => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '';
export const valuesOf = (doc: TemplateDoc): Settings => (isObject(doc.settings?.sampleValues) ? { ...doc.settings.sampleValues } : {});

/** A field as a reader is told about it: label and help, never more than it needs. */
export function describeField(p: Field): Record<string, unknown> {
    return {
        key: p.key, label: p.label || p.key, type: p.type, required: p.required === true,
        ...(p.options ? { options: p.options } : {}),
        ...(p.instructions || p.summary ? { help: p.instructions || p.summary } : {}),
        ...(p.example !== undefined ? { example: p.example } : {}),
        ...(p.fields ? { fields: p.fields.map((f) => ({ key: f.key, label: f.label || f.key, type: f.type, required: f.required === true })) } : {}),
    };
}

/** Why a value does not fit its field, in words that can be repeated to the person. */
function typeHint(p: Field, value: unknown, c: ContractModule): string {
    const label = p.label || p.key;
    switch (p.type) {
        case 'number': return `${label} must be a number${typeof value === 'string' && c.hasThousandsSeparator(value.trim()) ? ' without a thousands separator' : ''}.`;
        case 'date': return `${label} must be a date written as YYYY-MM-DD.`;
        case 'boolean': return `${label} must be true or false.`;
        case 'choice': return `${label} must be exactly one of: ${(p.options || []).join(', ')}.`;
        case 'list': return `${label} must be a list of items with: ${(p.fields || []).map((f) => f.key).join(', ')}.`;
        default: return `${label} must be text.`;
    }
}

/** The value as the field stores it (numbers coerced as the contract does), or a reason it cannot be. */
function fitValue(p: Field, raw: unknown, c: ContractModule): { value: unknown } | { reason: string } {
    let value = raw;
    if (p.type === 'text' && (typeof raw === 'number' || typeof raw === 'boolean')) value = String(raw);
    if (p.type === 'number') value = c.coerceNumber(raw);
    if (p.type === 'list' && Array.isArray(raw)) {
        const scope: Settings = { [p.key]: raw };
        c.coerceNumberParams([p], scope);
        value = scope[p.key];
    }
    if (typeof value === 'string' && value.length > MAX_TEXT) return { reason: `${p.label || p.key} is too long (at most ${MAX_TEXT} characters).` };
    return c.typeValid(p, value) ? { value } : { reason: typeHint(p, raw, c) };
}

/** Where the filling stands: what is filled, what is still required, and anything else in the way. */
export function progress(doc: TemplateDoc, contract: Contract, values: Settings, c: ContractModule): Progress {
    const fill = c.prepareDocument(doc, values, isObject(doc.settings?.sectionOverrides) ? doc.settings.sectionOverrides : {});
    const labels = new Map(contract.parameters.map((p) => [p.key, p.label || p.key]));
    const missingRequired = fill.issues.filter((i) => i.code === 'required' && i.key)
        .map((i) => ({ key: String(i.key), label: labels.get(String(i.key)) || String(i.key) }));
    const issues = fill.issues.filter((i) => i.code !== 'required').map((i) => i.message);
    const filled = contract.parameters.filter((p) => !isEmpty(values[p.key])).length;
    return { missingRequired, issues, complete: fill.valid, filled, total: contract.parameters.length };
}

/** The given values merged into the stored ones: what fits is taken, what does not comes back with a reason. */
export function mergeValues(contract: Contract, stored: Settings, given: Settings, c: ContractModule, guard?: ValueGuard) {
    const byKey = new Map(contract.parameters.map((p) => [p.key, p]));
    const values = { ...stored };
    const rejected: Rejected[] = [];
    let changed = false;
    for (const [key, raw] of Object.entries(given)) {
        const p = byKey.get(key);
        if (!p) { rejected.push({ key, message: `Unknown field "${key}".` }); continue; }
        if (isEmpty(raw)) { if (key in values) { delete values[key]; changed = true; } continue; }
        const guarded = guard ? guard(key, raw) : null;
        if (guarded) { rejected.push({ key, message: guarded }); continue; }
        const fit = fitValue(p, raw, c);
        if ('reason' in fit) { rejected.push({ key, message: fit.reason }); continue; }
        values[key] = fit.value;
        changed = true;
    }
    return { values, rejected, changed };
}

const REVISION: Record<Origin, { source: string, summary: string }> = {
    ai: { source: 'ai', summary: 'Filled in template fields' },
    user: { source: 'autosave', summary: 'Filled in template fields in the chat form' },
};

/** Write new settings as one revision; null when the caller may not change the document. */
export function saveSettings(store: ValuesStore, doc: TemplateDoc, settings: Settings, userId: string, origin: Origin): Promise<TemplateDoc | null> {
    return store.updateDocument(doc.id, userId, {
        settings, expectedVersionId: doc.versionId, ...REVISION[origin],
        ...(origin === 'ai' ? { contributors: [{ userId, kind: 'ai' }] } : {}),
    });
}

const isConflict = (e: unknown): boolean => (e as { status?: number }).status === 409;

export type ApplyResult = { doc: TemplateDoc, contract: Contract, values: Settings, rejected: Rejected[] } & Progress;

/**
 * Merge `given` into the document's values and save them. A write that lost a
 * race (the person saved in the form while the assistant did, a 409) is
 * merged once more on the fresh document. Null when the caller may not
 * change the document; a store refusal below 500 is thrown to the caller.
 */
/** Extra settings written in the same save as the values (who filled what, requests answered). */
export type Annotate = (settings: Settings, values: Settings, changedKeys: string[]) => Settings;

/** The keys whose stored value this save changes (accepted, and different from before). */
function changedKeysOf(stored: Settings, values: Settings, given: Settings, rejected: Rejected[]): string[] {
    const refused = new Set(rejected.map((r) => r.key));
    return Object.keys(given).filter((k) => !refused.has(k) && JSON.stringify(values[k]) !== JSON.stringify(stored[k]));
}

export async function applyTemplateValues(
    { store, doc, given, userId, origin, guard, annotate, contract = contractModule }:
    { store: ValuesStore, doc: TemplateDoc, given: Settings, userId: string, origin: Origin, guard?: ValueGuard, annotate?: Annotate, contract?: () => ContractModule },
): Promise<ApplyResult | null> {
    const c = contract();
    let current = doc;
    for (let attempt = 0; ; attempt += 1) {
        const fields = c.getContract(current);
        const stored = valuesOf(current);
        const { values, rejected, changed } = mergeValues(fields, stored, given, c, guard);
        let saved: TemplateDoc | null = current;
        try {
            if (changed) {
                const base = { ...(current.settings || {}), sampleValues: values };
                const next = annotate ? annotate(base, values, changedKeysOf(stored, values, given, rejected)) : base;
                saved = await saveSettings(store, current, next, userId, origin);
            }
        } catch (e) {
            if (attempt === 0 && isConflict(e)) {
                const fresh = await store.getDocument(current.id, userId);
                if (fresh) { current = fresh; continue; }
            }
            throw e;
        }
        if (!saved) return null;
        return { doc: saved, contract: fields, values, rejected, ...progress(saved, fields, values, c) };
    }
}
