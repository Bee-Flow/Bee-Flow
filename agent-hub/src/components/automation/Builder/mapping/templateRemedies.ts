/**
 * A LIST, TABLE or GROUP put into a TEXT template (a notification body, an
 * e-mail, a document field): what can it become, as the `{{…}}` token each
 * choice writes.
 *
 * mismatch.js asks the same question for a binding slot, but its answers are
 * expressions (`join(…)`, `first(…)`), and a template only interpolates PATHS
 * (server/automation/bind.js interpolateTemplate). So every answer here is a
 * path the runtime really resolves:
 *
 *   list   all of them         {{p}}          "red, green, blue" (templateText)
 *          only the first      {{p[0]}}
 *          how many            {{p.length}}
 *   table  one column          {{p[*].key}}   "A1, B2"  (mismatch.columnPath:
 *                                             `{{p.key}}` when p is itself a
 *                                             column, `value[*].from`)
 *          how many rows       {{p.length}}   (not for a column: `.length`
 *                                             would count per row)
 *          the whole table     {{p}}          JSON
 *   group  a field inside it   {{p.key}}
 *          the whole group     {{p}}          JSON
 *
 * and, for a list or a table, "a separate run for each item": the step gets a
 * forEach over the list and the token becomes `{{loop.<item>…}}` (forEachPickFor).
 *
 * Pure and React-free.
 */
import { appendKey, parsePath, scanTemplate } from '@shared/expr/path.mjs';
import { templateText } from '@shared/expr/templateText.mjs';
import { columnPath, kindAtPath } from './mismatch';
import { forEachPickFor } from './listShape';
import { humanizeFieldKey } from '../flow/displayHelpers';
import { canonicalRefPath, walkPath } from '../../../../utils/bindingHelpers';

export type TemplateShape = 'list' | 'table' | 'group';

export interface ForEachSpec { overRef: string; itemVar: string; maxIterations: number }

export interface TemplateRemedy {
    id: string;
    /** What replaces `{{path}}` in the template. */
    token: string;
    labelKey: string;
    labelEn: string;
    labelParams?: Record<string, string | number>;
    /** What the run writes for this choice, from the sample (null when unknown). */
    preview: string | null;
    /** Set for "a separate run for each item": the step's forEach. */
    forEach?: ForEachSpec;
}

export interface TemplateRemedies {
    shape: TemplateShape;
    count: number | null;
    /** The choice the inserted `{{path}}` already is. */
    currentId: string;
    choices: TemplateRemedy[];
}

const MAX_COLUMNS = 4;
const MAX_FIELDS = 6;

const tok = (path: string) => `{{${path}}}`;

function previewOf(path: string, sampleRoot: unknown): string | null {
    const v = walkPath(path, sampleRoot);
    if (v === undefined) return null;
    const s = templateText(v);
    return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** The shape a template question is about, or null when the value is one value. */
export function templateShapeAt(path: string, sampleRoot: unknown): TemplateShape | null {
    const kind = kindAtPath(path, sampleRoot);
    return kind === 'list' || kind === 'table' || kind === 'group' ? kind : null;
}

/**
 * The choices for `path` in a text template, or null when it is a single
 * value (nothing to ask). `allowForEach` is false when the step cannot take a
 * forEach here (already running per item over something, or the editor did
 * not offer one).
 */
export function templateRemediesFor(
    path: string,
    sampleRoot: unknown,
    { allowForEach = false }: { allowForEach?: boolean } = {},
): TemplateRemedies | null {
    const p = canonicalRefPath(String(path || '').trim());
    const shape = templateShapeAt(p, sampleRoot);
    if (!shape) return null;
    const value = walkPath(p, sampleRoot);
    // A column (`a[*].b`) is already one value per row: `[0]` and `.length`
    // would apply per row there, so it gets neither.
    const isColumn = (parsePath(p) || []).some(t => t.type === 'wild');
    const fieldName = (key: string) => humanizeFieldKey(key) || key;

    if (shape === 'group') {
        const obj = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
        const keys = Object.keys(obj).slice(0, MAX_FIELDS);
        return {
            shape, count: Object.keys(obj).length, currentId: 'whole',
            choices: [
                ...keys.map((key): TemplateRemedy => {
                    const kp = appendKey(p, key);
                    return {
                        id: `field:${key}`, token: tok(kp),
                        labelKey: 'automations.template_fit.field', labelEn: '{field}', labelParams: { field: fieldName(key) },
                        preview: previewOf(kp, sampleRoot),
                    };
                }),
                {
                    id: 'whole', token: tok(p),
                    labelKey: 'automations.template_fit.whole_group', labelEn: 'The whole group, as data',
                    preview: previewOf(p, sampleRoot),
                },
            ],
        };
    }

    const list = Array.isArray(value) ? value : [];
    const forEach = (): TemplateRemedy[] => {
        if (!allowForEach) return [];
        const pick = forEachPickFor(p, sampleRoot);
        return [{
            id: 'foreach', token: tok(pick.binding.path), forEach: pick.forEach,
            labelKey: shape === 'table' ? 'automations.template_fit.foreach_row' : 'automations.template_fit.foreach_item',
            labelEn: shape === 'table' ? 'A separate run for each row' : 'A separate run for each item',
            preview: previewOf(`${isColumn ? p.split('[*]')[0] : p}[0]`, sampleRoot) ?? null,
        }];
    };

    if (shape === 'table') {
        const first = list.find((r) => r && typeof r === 'object') as Record<string, unknown> | undefined;
        const cols = first ? Object.keys(first).slice(0, MAX_COLUMNS) : [];
        return {
            shape, count: list.length, currentId: 'whole',
            choices: [
                ...forEach(),
                ...cols.map((key): TemplateRemedy => {
                    const cp = columnPath(p, key, sampleRoot);
                    return {
                        id: `column:${key}`, token: tok(cp),
                        labelKey: 'automations.template_fit.column', labelEn: 'Only “{field}”, from every row', labelParams: { field: fieldName(key) },
                        preview: previewOf(cp, sampleRoot),
                    };
                }),
                ...(isColumn ? [] : [{
                    id: 'count', token: tok(appendKey(p, 'length')),
                    labelKey: 'automations.template_fit.count_rows', labelEn: 'How many rows ({n})', labelParams: { n: list.length },
                    preview: String(list.length),
                }]),
                {
                    id: 'whole', token: tok(p),
                    labelKey: 'automations.template_fit.whole_table', labelEn: 'The whole table, as data',
                    preview: previewOf(p, sampleRoot),
                },
            ],
        };
    }

    return {
        shape, count: list.length, currentId: 'all',
        choices: [
            {
                id: 'all', token: tok(p),
                labelKey: 'automations.template_fit.all', labelEn: 'All of them, comma separated',
                preview: previewOf(p, sampleRoot),
            },
            ...(isColumn ? [] : [
                {
                    id: 'first', token: tok(appendKey(p, 0)),
                    labelKey: 'automations.template_fit.first', labelEn: 'Only the first',
                    preview: previewOf(appendKey(p, 0), sampleRoot),
                },
                {
                    id: 'count', token: tok(appendKey(p, 'length')),
                    labelKey: 'automations.template_fit.count', labelEn: 'How many ({n})', labelParams: { n: list.length },
                    preview: String(list.length),
                },
            ]),
            ...forEach(),
        ],
    };
}

/**
 * The placeholders in `text` that read `path` — found with the runtime's own
 * quote-aware scan, and compared by MEANING (canonical spelling), so
 * `{{ a['x'] }}` is the same placeholder as `{{a["x"]}}`.
 */
function tokensFor(text: string, path: string) {
    const want = canonicalRefPath(path);
    return (scanTemplate(String(text || '')) as Array<{ type: string; inner?: string; start?: number; end?: number }>)
        .filter(p => p.type === 'ref' && canonicalRefPath(p.inner) === want);
}

/** Does `text` still hold `{{path}}`? */
export function hasToken(text: string, path: string): boolean {
    return tokensFor(text, path).length > 0;
}

/**
 * Replace the LAST `{{path}}` in `text` with `token` — the occurrence the
 * author just inserted. Unchanged when it is not there (the author edited it
 * away).
 */
export function replaceLastToken(text: string, path: string, token: string): string {
    const found = tokensFor(text, path);
    const last = found[found.length - 1];
    if (!last) return text;
    return text.slice(0, last.start) + token + text.slice(last.end);
}
