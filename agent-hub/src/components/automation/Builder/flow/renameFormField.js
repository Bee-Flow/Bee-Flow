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
 *   pick      { kind:'pick', from:{ root:'trigger', path:['old'] } } → ['new']
 *   compose   every value part's `from`, the same way
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

/** Field names are identifiers (the server's PARAM_NAME_RE), so this is safe. */
function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `<base>.<from>` → `<base>.<to>`, in a single ref path.
 *
 * Both spellings a binding can use are handled, and both only when `from` is a
 * COMPLETE segment: what follows must be the end of the path, a dot, or an
 * opening bracket.
 */
export function renameFieldPath(path, base, from, to) {
    if (typeof path !== 'string' || !base || !from || !to) return path;
    const b = escapeRe(base);
    const f = escapeRe(from);
    const dotted = new RegExp(`^(${b})\\.${f}(?=$|[.[])`);
    if (dotted.test(path)) return path.replace(dotted, `$1.${to}`);
    const bracketed = new RegExp(`^(${b})\\[(["'])${f}\\2\\]`);
    if (bracketed.test(path)) return path.replace(bracketed, `$1[$2${to}$2]`);
    return path;
}

/** Rewrite every `{{ … }}` body of a template string, preserving spacing. */
function renameInTemplate(str, base, from, to) {
    return String(str).replace(/\{\{([^}]*)\}\}/g, (whole, raw) => {
        const lead = /^\s*/.exec(raw)[0];
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
function renameInExpr(src, base, from, to) {
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

/**
 * The source of a pick (or of a compose's value part), renamed when it sits
 * under `base` — `trigger.output` is root `trigger`, `steps.<id>.output` root
 * `steps` with that id — and its first segment is the field. Same object when
 * it does not.
 */
function renameInSource(source, base, from, to) {
    if (!source || typeof source !== 'object' || !Array.isArray(source.path) || source.path[0] !== from) return source;
    const pageId = /^steps\.([^.]+)\.output$/.exec(base)?.[1] ?? null;
    const under = base === 'trigger.output' ? source.root === 'trigger' : source.root === 'steps' && source.id === pageId;
    return under ? { ...source, path: [to, ...source.path.slice(1)] } : source;
}

/**
 * Deep-walk a value, returning a rewritten COPY and counting what changed.
 *
 * Only objects whose `kind` is a binding kind are wrappers (a pick, and each
 * value part of a compose, name the field in their `from`); a `literal` ships
 * verbatim at run time, so its payload is left alone — the same carve-out
 * bind.js and portability.js make.
 */
function rewriteDeep(value, base, from, to, counter) {
    if (Array.isArray(value)) return value.map(v => rewriteDeep(v, base, from, to, counter));
    if (value === null || typeof value !== 'object') return value;

    const kind = typeof value.kind === 'string' ? value.kind : null;
    if (kind === 'literal') return { ...value };
    if (kind === 'ref' && typeof value.path === 'string') {
        const next = renameFieldPath(value.path, base, from, to);
        if (next !== value.path) counter.count += 1;
        return { ...value, path: next };
    }
    if (kind === 'template' && typeof value.value === 'string') {
        const next = renameInTemplate(value.value, base, from, to);
        if (next !== value.value) counter.count += 1;
        return { ...value, value: next };
    }
    if (kind === 'expr' && typeof value.value === 'string') {
        const next = renameInExpr(value.value, base, from, to);
        if (next !== value.value) counter.count += 1;
        return { ...value, value: next };
    }
    if (kind === 'pick') {
        const next = renameInSource(value.from, base, from, to);
        if (next !== value.from) counter.count += 1;
        return { ...value, from: next };
    }
    if (kind === 'compose' && Array.isArray(value.parts)) {
        let moved = false;
        const parts = value.parts.map((part) => {
            if (!part || typeof part !== 'object') return part;
            const next = renameInSource(part.from, base, from, to);
            if (next === part.from) return { ...part };
            moved = true;
            return { ...part, from: next };
        });
        if (moved) counter.count += 1;
        return { ...value, parts };
    }

    const out = {};
    for (const k of Object.keys(value)) out[k] = rewriteDeep(value[k], base, from, to, counter);
    return out;
}

/** Rename the field itself inside one form declaration. */
function renameInForm(form, from, to) {
    if (!form || !Array.isArray(form.fields)) return form;
    let hit = false;
    const fields = form.fields.map((f) => {
        if (!f || f.name !== from) return f;
        hit = true;
        return { ...f, name: to };
    });
    return hit ? { ...form, fields } : form;
}

/** Every place a form declaration can live: the triggers and the form_page steps. */
function mapForms(def, base, from, to) {
    const isTriggerBase = base === 'trigger.output';
    const pageId = isTriggerBase ? null : /^steps\.([^.]+)\.output$/.exec(base)?.[1] || null;

    const mapStep = (step) => {
        if (!step || typeof step !== 'object') return step;
        if (pageId && step.id === pageId && step.form) return { ...step, form: renameInForm(step.form, from, to) };
        return step;
    };
    const mapSteps = (steps) => (Array.isArray(steps) ? steps.map(mapStep) : steps);

    const next = { ...def };
    if (isTriggerBase && next.trigger?.form) {
        next.trigger = { ...next.trigger, form: renameInForm(next.trigger.form, from, to) };
    }
    if (!isTriggerBase) next.steps = mapSteps(next.steps);
    if (next.layers && typeof next.layers === 'object') {
        const layers = {};
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
export function isValidFieldName(name) {
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
 *   author what just happened to the rest of their routine.
 */
export function renameFormField(definition, { base, from, to } = {}) {
    if (!definition || typeof definition !== 'object') return { definition, rewritten: 0, ok: false, error: 'No routine to edit.' };
    if (!base || !from || !to) return { definition, rewritten: 0, ok: false, error: 'Nothing to rename.' };
    if (from === to) return { definition, rewritten: 0, ok: true };
    if (!isValidFieldName(to)) {
        return { definition, rewritten: 0, ok: false, error: 'A binding name starts with a letter and holds only letters, digits and underscores.' };
    }

    const counter = { count: 0 };
    // The declaration first, then the references — order is irrelevant to the
    // result (they touch disjoint keys) but this way a failure to find the
    // field cannot leave half a rename behind.
    const renamed = mapForms(definition, base, from, to);
    const rewritten = rewriteDeep(renamed, base, from, to, counter);
    return { definition: rewritten, rewritten: counter.count, ok: true };
}

/**
 * Would `to` collide with another question on the SAME page? The server drops
 * a duplicate name silently (normalizeFields keeps the first), so a collision
 * has to be refused before the edit, not discovered after it.
 */
export function fieldNameTaken(fields, to, from) {
    return (Array.isArray(fields) ? fields : []).some(f => f?.name === to && f?.name !== from);
}
