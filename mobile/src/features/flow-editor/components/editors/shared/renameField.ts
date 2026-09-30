/**
 * Renaming a declared field's BINDING NAME, and everything that points at it
 * — the port of agent-hub `Builder/flow/renameFormField.js`, pinned by
 * renameField.lockstep.test.ts (differential).
 *
 * A declared field (a form question, a trigger parameter) has two names: the
 * label a person reads, and the `name` other steps bind (`trigger.output.<name>`,
 * `steps.<pageId>.output.<name>`). Renaming the second rewrites every ref,
 * template and expression in the SAME edit, and only:
 *   - under THIS field's base (two pages may share a slug);
 *   - on a WHOLE segment (`naam` never touches `naam_bedrijf`);
 *   - outside string literals in an expression.
 * Pure: a new definition, never a mutated one.
 */

type Obj = Record<string, unknown>;

function escapeRe(s: string): string {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `<base>.<from>` → `<base>.<to>` in one path, dotted or bracketed, whole segments only. */
export function renameFieldPath(path: unknown, base: string, from: string, to: string): unknown {
    if (typeof path !== 'string' || !base || !from || !to) return path;
    const b = escapeRe(base);
    const f = escapeRe(from);
    const dotted = new RegExp(`^(${b})\\.${f}(?=$|[.[])`);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- dotted is anchored at ^ and built only from escapeRe-escaped literals, with no quantifier at all, so it cannot backtrack
    if (dotted.test(path)) return path.replace(dotted, `$1.${to}`);
    const bracketed = new RegExp(`^(${b})\\[(["'])${f}\\2\\]`);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- bracketed is anchored at ^ and built only from escapeRe-escaped literals and a backreference, with no quantifier at all, so it cannot backtrack
    if (bracketed.test(path)) return path.replace(bracketed, `$1[$2${to}$2]`);
    return path;
}

function renameInTemplate(str: string, base: string, from: string, to: string): string {
    return String(str).replace(/\{\{([^}]*)\}\}/g, (whole, raw: string) => {
        const lead = (/^\s*/.exec(raw) as RegExpExecArray)[0];
        const inner = raw.trim();
        const trail = raw.slice(lead.length + inner.length);
        const next = renameFieldPath(inner, base, from, to);
        return next === inner ? whole : `{{${lead}${next as string}${trail}}}`;
    });
}

/** The field inside an expression, bounded on both sides; quoted literals untouched. */
function renameInExpr(src: string, base: string, from: string, to: string): string {
    const b = escapeRe(base);
    const f = escapeRe(from);
    const dotted = new RegExp(`(^|[^A-Za-z0-9_.$])(${b})\\.${f}(?=$|[^A-Za-z0-9_])`, 'g');
    const bracketed = new RegExp(`(^|[^A-Za-z0-9_.$])(${b})\\[(["'])${f}\\3\\]`, 'g');
    let out = '';
    let buf = '';
    const flush = () => {
        if (!buf) return;
        out += buf.replace(dotted, `$1$2.${to}`).replace(bracketed, `$1$2[$3${to}$3]`);
        buf = '';
    };
    let i = 0;
    while (i < src.length) {
        const c = src[i] as string;
        if (c === '"' || c === "'") {
            flush();
            let j = i + 1;
            while (j < src.length && src[j] !== c) j += src[j] === '\\' && j + 1 < src.length ? 2 : 1;
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

/** One rename in flight, and how many bindings it has moved so far. */
interface Rename {
    base: string;
    from: string;
    to: string;
    count: number;
}

function rewriteBinding(value: Obj, kind: string, r: Rename): Obj | null {
    const text = kind === 'ref' ? value.path : value.value;
    if (typeof text !== 'string') return null;
    let next: string;
    if (kind === 'ref') next = renameFieldPath(text, r.base, r.from, r.to) as string;
    else if (kind === 'template') next = renameInTemplate(text, r.base, r.from, r.to);
    else next = renameInExpr(text, r.base, r.from, r.to);
    if (next !== text) r.count += 1;
    return kind === 'ref' ? { ...value, path: next } : { ...value, value: next };
}

/** A rewritten COPY of any value; a `literal` ships verbatim at run time, so its payload stays. */
function rewriteDeep(value: unknown, r: Rename): unknown {
    if (Array.isArray(value)) return value.map((v) => rewriteDeep(v, r));
    if (value === null || typeof value !== 'object') return value;
    const obj = value as Obj;
    const kind = typeof obj.kind === 'string' ? obj.kind : null;
    if (kind === 'literal') return { ...obj };
    if (kind === 'ref' || kind === 'template' || kind === 'expr') {
        const bound = rewriteBinding(obj, kind, r);
        if (bound) return bound;
    }
    const out: Obj = {};
    for (const k of Object.keys(obj)) out[k] = rewriteDeep(obj[k], r);
    return out;
}

function renameInForm(form: unknown, from: string, to: string): unknown {
    const f = form as { fields?: unknown } | null;
    if (!f || !Array.isArray(f.fields)) return form;
    let hit = false;
    const fields = f.fields.map((q: unknown) => {
        const row = q as Obj | null;
        if (!row || row.name !== from) return q;
        hit = true;
        return { ...row, name: to };
    });
    return hit ? { ...f, fields } : form;
}

/** Every place a form declaration lives: the trigger, and the form_page steps. */
function mapForms(def: Obj, base: string, from: string, to: string): Obj {
    const isTriggerBase = base === 'trigger.output';
    const pageId = isTriggerBase ? null : /^steps\.([^.]+)\.output$/.exec(base)?.[1] || null;
    const mapStep = (step: unknown) => {
        const s = step as Obj | null;
        if (!s || typeof s !== 'object') return step;
        if (pageId && s.id === pageId && s.form) return { ...s, form: renameInForm(s.form, from, to) };
        return step;
    };
    const mapSteps = (steps: unknown) => (Array.isArray(steps) ? steps.map(mapStep) : steps);
    const next: Obj = { ...def };
    const trigger = next.trigger as Obj | null | undefined;
    if (isTriggerBase && trigger?.form) next.trigger = { ...trigger, form: renameInForm(trigger.form, from, to) };
    if (!isTriggerBase) next.steps = mapSteps(next.steps);
    if (next.layers && typeof next.layers === 'object') {
        const layers: Obj = {};
        for (const [key, layer] of Object.entries(next.layers as Obj)) {
            layers[key] = layer && typeof layer === 'object' && !isTriggerBase ? { ...(layer as Obj), steps: mapSteps((layer as Obj).steps) } : layer;
        }
        next.layers = layers;
    }
    return next;
}

/** A name the server's PARAM_NAME_RE accepts. */
export function isValidFieldName(name: unknown): name is string {
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(name);
}

export interface RenameOutcome<D> {
    definition: D;
    /** How many BINDINGS moved — so the author can be told what happened to the rest of the routine. */
    rewritten: number;
    ok: boolean;
    error?: string;
}

/** Rename one declared field across a whole (root) definition. */
export function renameFormField<D>(definition: D, { base, from, to }: { base?: string; from?: string; to?: string } = {}): RenameOutcome<D> {
    if (!definition || typeof definition !== 'object') return { definition, rewritten: 0, ok: false, error: 'No routine to edit.' };
    if (!base || !from || !to) return { definition, rewritten: 0, ok: false, error: 'Nothing to rename.' };
    if (from === to) return { definition, rewritten: 0, ok: true };
    if (!isValidFieldName(to)) {
        return { definition, rewritten: 0, ok: false, error: 'A binding name starts with a letter and holds only letters, digits and underscores.' };
    }
    const r: Rename = { base, from, to, count: 0 };
    const renamed = mapForms(definition as Obj, base, from, to);
    const rewritten = rewriteDeep(renamed, r) as D;
    return { definition: rewritten, rewritten: r.count, ok: true };
}

/** Would `to` collide with another field of the same declaration? */
export function fieldNameTaken(fields: unknown, to: string, from: string): boolean {
    return (Array.isArray(fields) ? fields : []).some((f) => (f as Obj | null)?.name === to && (f as Obj | null)?.name !== from);
}
