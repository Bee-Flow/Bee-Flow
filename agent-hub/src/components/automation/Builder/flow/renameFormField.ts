/**
 * Renaming a form question's BINDING NAME, and everything that points at it.
 *
 * A form field has two names. The LABEL is what the visitor reads and may be
 * edited freely. The `name` is the binding — `trigger.output.<name>`, or
 * `steps.<pageId>.output.<name>` on a later page — and until now it was slugged
 * once at creation and frozen, because re-deriving it from the label would
 * silently break every downstream step that mapped off it. Frozen was the safe
 * answer, not a good one: an author who renamed "Jouw naam" to "Contactpersoon"
 * was left binding `jouw_naam` forever, with no way to fix it.
 *
 * So the name is editable, and renaming it rewrites every reference in the SAME
 * edit. That is the whole point of this module: the rename and the rewrite are
 * one operation over the whole definition, never two.
 *
 * What gets rewritten, everywhere in the graph (top-level steps, every flowlet
 * layer, every trigger, at any depth inside a step's inputs):
 *
 *   ref       { kind:'ref', path:'trigger.output.old' }        → …output.new
 *   template  "Dag {{trigger.output.old}}"                      → {{…output.new}}
 *   expr      "trigger.output.old == 'x'"                       → …output.new
 *   showIf    "form.old == 'x'" on the other questions of the page → form.new
 *
 * Three rules it follows, each of which is a bug it exists to avoid:
 *
 *   • Only THIS field's base. `trigger.output.name` and
 *     `steps.fp_2.output.name` are different questions that happen to share a
 *     slug; rewriting by field name alone would rename both.
 *   • Only a WHOLE segment. Renaming `naam` must not touch `naam_bedrijf`, and
 *     must still catch `trigger.output.naam.text` and `trigger.output["naam"]`.
 *   • String literals in an expression are left alone, so
 *     `reason == "trigger.output.old failed"` keeps its message. Same rule, and
 *     the same tokenizer discipline, as portability.js's rekeying.
 *
 * Pure: takes a definition, returns a new one. Never mutates its argument.
 */

import type { FlowStep } from './types';

type JsonValue = string | number | boolean | null | undefined | JsonObject | JsonValue[];
interface JsonObject { [key: string]: JsonValue }
interface FormField { name?: string; [key: string]: unknown }
interface FormLike { fields?: Array<FormField | null>; [key: string]: unknown }
interface FormStep extends FlowStep { form?: FormLike | null }
interface Def {
    trigger?: FormStep | null;
    steps?: FormStep[];
    layers?: Record<string, { steps?: FormStep[] }>;
    [key: string]: unknown;
}

/** Field names are identifiers (the server's PARAM_NAME_RE), so this is safe. */
function escapeRe(s: unknown): string {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `<base>.<from>` → `<base>.<to>`, in a single ref path.
 *
 * Both spellings a binding can use are handled, and both only when `from` is a
 * COMPLETE segment: what follows must be the end of the path, a dot, or an
 * opening bracket.
 */
export function renameFieldPath(path: string, base: string, from: string, to: string): string;
export function renameFieldPath(path: unknown, base: string, from: string, to: string): unknown;
export function renameFieldPath(path: unknown, base: string, from: string, to: string): unknown {
    if (typeof path !== 'string' || !base || !from || !to) return path;
    const b = escapeRe(base);
    const f = escapeRe(from);
    const dotted = new RegExp(`^(${b})\\.${f}(?=$|[.[])`);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored, built from escaped literals with no quantifier: linear
    if (dotted.test(path)) return path.replace(dotted, `$1.${to}`);
    const bracketed = new RegExp(`^(${b})\\[(["'])${f}\\2\\]`);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored, built from escaped literals with no quantifier: linear
    if (bracketed.test(path)) return path.replace(bracketed, `$1[$2${to}$2]`);
    return path;
}

/** Rewrite every `{{ … }}` body of a template string, preserving spacing. */
function renameInTemplate(str: unknown, base: string, from: string, to: string): string {
    return String(str).replace(/\{\{([^}]*)\}\}/g, (whole: string, raw: string) => {
        const lead = (/^\s*/.exec(raw) as RegExpExecArray)[0];
        const inner = raw.trim();
        const trail = raw.slice(lead.length + inner.length);
        const next = renameFieldPath(inner, base, from, to);
        return next === inner ? whole : `{{${lead}${next}${trail}}}`;
    });
}

/**
 * Rewrite the field inside an expression, leaving quoted literals untouched.
 *
 * A path in an expression is not anchored at the start of the string, so the
 * match has to be bounded on the left too — by anything that cannot be part of
 * an identifier — or `steps.a.output.trigger.output.old` would be rewritten
 * from the middle.
 */
function renameInExpr(src: string, base: string, from: string, to: string): string;
function renameInExpr(src: unknown, base: string, from: string, to: string): unknown;
function renameInExpr(src: unknown, base: string, from: string, to: string): unknown {
    if (typeof src !== 'string') return src;
    const b = escapeRe(base);
    const f = escapeRe(from);
    const dotted = new RegExp(`(^|[^A-Za-z0-9_.$])(${b})\\.${f}(?=$|[^A-Za-z0-9_])`, 'g');
    const bracketed = new RegExp(`(^|[^A-Za-z0-9_.$])(${b})\\[(["'])${f}\\3\\]`, 'g');
    let out = '';
    let buf = '';
    const flush = () => {
        if (!buf) return;
        out += buf
            .replace(dotted, `$1$2.${to}`)
            .replace(bracketed, `$1$2[$3${to}$3]`);
        buf = '';
    };
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '"' || c === "'") {
            flush();
            let j = i + 1;
            while (j < src.length && src[j] !== c) {
                if (src[j] === '\\' && j + 1 < src.length) j += 2;
                else j++;
            }
            out += src.slice(i, Math.min(j + 1, src.length));
            i = j + 1;
            continue;
        }
        buf += c;
        i++;
    }
    flush();
    return out;
}

/** Which payload field of each binding kind holds an expression-ish string, and how to rename inside it. */
const BINDING_RENAMERS = new Map<string, { field: 'path' | 'value'; rename: (text: string, base: string, from: string, to: string) => string }>([
    ['ref', { field: 'path', rename: renameFieldPath }],
    ['template', { field: 'value', rename: renameInTemplate }],
    ['expr', { field: 'value', rename: renameInExpr }],
]);

/**
 * Deep-walk a value, returning a rewritten COPY and counting what changed.
 *
 * Only objects whose `kind` is one of the four binding kinds are wrappers;
 * a `literal` ships verbatim at run time, so its payload is left alone — the
 * same carve-out bind.js and portability.js make.
 */
function rewriteDeep(value: JsonValue, base: string, from: string, to: string, counter: { count: number }): JsonValue {
    if (Array.isArray(value)) return value.map((v: JsonValue) => rewriteDeep(v, base, from, to, counter));
    if (value === null || typeof value !== 'object') return value;

    const kind = typeof value.kind === 'string' ? value.kind : null;
    if (kind === 'literal') return { ...value };
    const wrapper = kind ? BINDING_RENAMERS.get(kind) : undefined;
    if (wrapper) {
        const current = value[wrapper.field];
        if (typeof current === 'string') {
            const next = wrapper.rename(current, base, from, to);
            if (next !== current) counter.count += 1;
            return { ...value, [wrapper.field]: next };
        }
    }

    const out: JsonObject = {};
    for (const k of Object.keys(value)) out[k] = rewriteDeep(value[k], base, from, to, counter);
    return out;
}

/**
 * Rename the field itself inside one form declaration, and the `form.<name>`
 * in the `showIf` of the questions on the same page: a condition names its
 * questions page-locally (`form.contact == "email"`), so it moves with them.
 */
function renameInForm(form: FormLike | null | undefined, from: string, to: string, counter: { count: number }): FormLike | null | undefined {
    if (!form || !Array.isArray(form.fields)) return form;
    let hit = false;
    const fields = form.fields.map((f: FormField | null) => {
        if (!f) return f;
        let next: FormField = f;
        if (f.name === from) {
            hit = true;
            next = { ...next, name: to };
        }
        if (typeof f.showIf === 'string') {
            const showIf = renameInExpr(f.showIf, 'form', from, to);
            if (showIf !== f.showIf) {
                hit = true;
                counter.count += 1;
                next = { ...next, showIf };
            }
        }
        return next;
    });
    return hit ? { ...form, fields } : form;
}

/** Every place a form declaration can live: the triggers and the form_page steps. */
function mapForms(def: Def, base: string, from: string, to: string, counter: { count: number }): Def {
    const isTriggerBase = base === 'trigger.output';
    const pageId = isTriggerBase ? null : /^steps\.([^.]+)\.output$/.exec(base)?.[1] || null;

    const mapStep = (step: FormStep): FormStep => {
        if (!step || typeof step !== 'object') return step;
        if (pageId && step.id === pageId && step.form) return { ...step, form: renameInForm(step.form, from, to, counter) };
        return step;
    };
    const mapSteps = (steps: FormStep[] | undefined) => (Array.isArray(steps) ? steps.map(mapStep) : steps);

    const next = { ...def };
    if (isTriggerBase && next.trigger?.form) {
        next.trigger = { ...next.trigger, form: renameInForm(next.trigger.form, from, to, counter) };
    }
    if (!isTriggerBase) next.steps = mapSteps(next.steps);
    if (next.layers && typeof next.layers === 'object') {
        const layers: Record<string, { steps?: FormStep[] }> = {};
        for (const [key, layer] of Object.entries(next.layers)) {
            layers[key] = layer && typeof layer === 'object' && !isTriggerBase
                ? { ...layer, steps: mapSteps(layer.steps) }
                : layer;
        }
        next.layers = layers;
    }
    return next;
}

/** A name the server's PARAM_NAME_RE will accept. */
export function isValidFieldName(name: unknown): boolean {
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(name);
}

/**
 * Rename one form question's binding name across a whole definition.
 *
 * @param {object} definition  the ROOT definition (flowlet layers included)
 * @param {object} opts
 *   @param {string} opts.base  'trigger.output' or 'steps.<pageId>.output'
 *   @param {string} opts.from  the current binding name
 *   @param {string} opts.to    the new one
 * @returns {{definition: object, rewritten: number, ok: boolean, error?: string}}
 *   `rewritten` counts the BINDINGS that moved, so the caller can tell the
 *   author what just happened to the rest of their automation.
 */
export function renameFormField(definition: unknown, { base, from, to }: { base?: string; from?: string; to?: string } = {}): { definition: unknown; rewritten: number; ok: boolean; error?: string } {
    if (!definition || typeof definition !== 'object') return { definition, rewritten: 0, ok: false, error: 'No automation to edit.' };
    if (!base || !from || !to) return { definition, rewritten: 0, ok: false, error: 'Nothing to rename.' };
    if (from === to) return { definition, rewritten: 0, ok: true };
    if (!isValidFieldName(to)) {
        return { definition, rewritten: 0, ok: false, error: 'A binding name starts with a letter and holds only letters, digits and underscores.' };
    }

    const counter = { count: 0 };
    // The declaration first, then the references — order is irrelevant to the
    // result (they touch disjoint keys) but this way a failure to find the
    // field cannot leave half a rename behind.
    const renamed = mapForms(definition as Def, base, from, to, counter);
    const rewritten = rewriteDeep(renamed as JsonObject, base, from, to, counter);
    return { definition: rewritten, rewritten: counter.count, ok: true };
}

/**
 * Would `to` collide with another question on the SAME page? The server drops
 * a duplicate name silently (normalizeFields keeps the first), so a collision
 * has to be refused before the edit, not discovered after it.
 */
export function fieldNameTaken(fields: unknown, to: string, from?: string): boolean {
    return (Array.isArray(fields) ? fields : []).some((f: FormField | null) => f?.name === to && f?.name !== from);
}
