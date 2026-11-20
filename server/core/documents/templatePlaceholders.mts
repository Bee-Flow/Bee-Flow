/**
 * A TEMPLATE downloaded or printed from the Documents editor, with its gaps
 * shown instead of refused.
 *
 * A template keeps no sample values (stores/documentStore.js drops them for
 * anything that is not a plain document), so a template with a required field
 * could never be rendered: the fill refused on the missing value. For the
 * editor's own PDF and .pptx of a TEMPLATE, each value the body prints and
 * nobody gave is printed as its label in brackets ("[Customer name]"), a list
 * gets one row of such labels, and what is still open (a required value, a
 * section whose rule has no answer yet) does not block the file.
 *
 * Only the editor's download of a template asks for this. A document keeps
 * refusing (the editor explains and opens "Fill in & preview"), and an
 * automation or an app filling a template with a run's data keeps refusing a
 * missing required value: an invoice with "[Customer name]" on it must never
 * be sent.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Values = Record<string, unknown>;
type Field = { key: string; label?: string; type?: string };
type Parameter = Field & { fields?: Field[] };
type Issue = { code: string; key?: string; message?: string };
type Fill = { valid: boolean; issues: Issue[]; bodyHtml: string } & Record<string, unknown>;

const contract = () => nodeRequire('./documentContract') as {
    getContract: (doc: unknown) => { parameters: Parameter[] };
    setPath: (target: Values, key: string, value: unknown) => void;
    prepareDocument: (doc: unknown, values: Values, overrides?: Record<string, unknown>) => Fill;
};
const template = () => nodeRequire('./documentTemplate') as {
    listPlaceholders: (body: string) => Array<{ key: string; kind: 'value' | 'list' | 'condition' }>;
};

/** What a missing value prints as: its label in brackets. */
export function placeholderText(field: Field): string {
    return `[${String(field.label || field.key).trim() || field.key}]`;
}

/** Whether `values` holds something for this dotted key (null and '' are nothing). */
function hasValue(values: Values, key: string): boolean {
    let cur: unknown = values;
    for (const part of key.split('.')) {
        if (!cur || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return false;
        cur = (cur as Values)[part];
    }
    return cur !== null && cur !== undefined && cur !== '';
}

/** Deep enough a copy that writing a placeholder never touches the caller's values. */
function copyValues(values: unknown): Values {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
    return structuredClone(values) as Values;
}

/**
 * The values with a bracketed label for every value or list the body prints
 * and nobody gave, and the keys that got one. A yes/no value and a value that
 * only a section rule reads stay missing: a label would decide them.
 */
export function templatePreviewValues(doc: { bodyHtml?: string }, values: unknown): { values: Values; filled: string[] } {
    const out = copyValues(values);
    const filled: string[] = [];
    const parameters = new Map(contract().getContract(doc).parameters.map((p) => [p.key, p]));
    for (const shown of template().listPlaceholders(doc.bodyHtml || '')) {
        const p = parameters.get(shown.key);
        if (!p || shown.kind === 'condition' || p.type === 'boolean' || hasValue(out, p.key)) continue;
        const value = shown.kind === 'list'
            ? [Object.fromEntries((p.fields || []).map((f) => [f.key, placeholderText(f)]))]
            : placeholderText(p);
        contract().setPath(out, p.key, value);
        filled.push(p.key);
    }
    return { values: out, filled };
}

/** Whether an issue is a gap a template may print with: a required value, an open section, a placeholder's type. */
function isTemplateGap(issue: Issue, filled: string[]): boolean {
    if (issue.code === 'required' || issue.code === 'section_unresolved') return true;
    if (issue.code !== 'type' || !issue.key) return false;
    return filled.some((k) => issue.key === k || issue.key!.startsWith(`${k}[`));
}

/** The fill with the template's gaps no longer counted as problems; anything else still refuses. */
export function tolerateTemplateGaps<F extends Fill>(fill: F, filled: string[]): F {
    const issues = fill.issues.filter((i) => !isTemplateGap(i, filled));
    return { ...fill, issues, valid: issues.length === 0 };
}

/** prepareDocument for a template's download: gaps printed as labels, and not refused. */
export function prepareTemplateForDownload(doc: { bodyHtml?: string }, values: unknown, overrides: Record<string, unknown> = {}): Fill {
    const preview = templatePreviewValues(doc, values);
    return tolerateTemplateGaps(contract().prepareDocument(doc, preview.values, overrides), preview.filled);
}
