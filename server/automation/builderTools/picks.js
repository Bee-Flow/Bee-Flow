/**
 * Builder tools — the v2 mapping the AI builder writes: pick bindings for a
 * value, compose bindings for a text with values in it.
 *
 * The model is taught the compact pick (`{pick:"steps.x.output.items.email",
 * take:"all"}`, expanded by the shared core's normalizePick) and keeps
 * writing `{{ }}` placeholders in the text fields of a step (a notification's
 * body, an HTTP request's url). This file turns what it wrote into the
 * stored form:
 *
 *   - every pick it stores carries a `label`, derived from the key it reads
 *     ("replyText" → "Reply text"), so the editor shows a name instead of a
 *     path;
 *   - a text field whose every placeholder reads a plain path becomes a
 *     compose, so a list in it renders as readable text (one item per line,
 *     or comma-separated in a one-line field) instead of the JSON a template
 *     renders. The rule is the shared core's (template.mjs
 *     templateToCompose), the one the editor lifts a template with: a
 *     placeholder over a list (`items[*].name`) takes all of it, any other
 *     takes the value there, and a text with a placeholder a pick does not
 *     read the same way (an expression, `secrets.x`, `.length`, an index)
 *     stays the template it was: nothing is half-converted.
 *
 * Only the text fields the shared core lists as compose-capable
 * (shared/mapping/sites.mjs) get a compose; a field whose executor reads a
 * plain string only keeps its template. ai_step.prompt is not converted
 * here: its `{{name}}` reads the step's own inputs by name, which no pick
 * can say, and the values belong in `inputs` (as picks) anyway.
 *
 * Legacy refs and templates the model writes into `inputs` are kept as they
 * are (bindings.js); they resolve exactly as they always have.
 */

const {
    MAPPING_VERSION, normalizePick, sourceFromPath,
    isPick, isCompose, describeSource, textSitesOf, textAsTemplate, templateToCompose,
} = require('../../shared/mapping/index.mjs');

// Text sites whose `{{ }}` text stays a template. An ai_step's prompt reads
// the step's own inputs by name (`{{emails}}`), which no pick can say. A
// slide's content renders a list as a markdown bullet list that starts its
// own block (interpolateTemplate's listAsMarkdown: a blank line before it);
// render.mjs's 'bullets' join glues the first bullet onto the label line
// before it, so the slide would change. Lifted once that join opens a block.
const KEEP_TEMPLATE = new Set(['ai_step.prompt', 'slide.content']);
// A text site that holds ONE binding rather than a text: a data_extraction's
// source is canonicalised by its own sanitizer (sanitizeDataExtractionSource).
const NOT_A_TEXT = new Set(['data_extraction.source']);

// Lower-case words of a key that read as an acronym.
const ACRONYMS = new Set(['id', 'url', 'uri', 'api', 'pdf', 'csv', 'html', 'json', 'xml', 'iban', 'btw', 'kvk', 'vat', 'ip', 'utc', 'uuid', 'sms']);

/**
 * A short human name for the key a Source reads: its last key. A key typed
 * with spaces ("E-mail adres") is already a label and kept as written; an
 * identifier is split at camelCase and underscores in sentence case
 * ("replyText" → "Reply text", "messageId" → "Message ID", "AFAS" as it is).
 * Indexes are skipped; a Source that reads no key gets no label. A display
 * cache only — the run never reads it.
 *
 * TODO(M3 merge): the M3 track adds humanizeKey to
 * server/shared/mapping/label.mjs with exactly these rules, so the editor and
 * the builder name a value the same way. When it lands, replace the body
 * below with `humanizeKey(key)` from the core and delete ACRONYMS here.
 * @param {object} from
 * @returns {string|undefined}
 */
function labelForSource(from) {
    const path = from && Array.isArray(from.path) ? from.path : [];
    let key;
    for (let i = path.length - 1; i >= 0; i--) {
        if (typeof path[i] === 'string' && path[i].trim()) { key = path[i].trim(); break; }
    }
    if (key === undefined) return undefined;
    if (/\s/.test(key)) return key;
    const words = key
        .replace(/_+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) return undefined;
    return words.map((w, i) => {
        const lower = w.toLowerCase();
        if (ACRONYMS.has(lower)) return lower.toUpperCase();
        // A word written in capitals (AFAS, BSN) stays that way.
        if (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w;
        return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    }).join(' ');
}

/** The pick (or compose part) with a label, when it has none and one can be derived. */
function withLabel(pick) {
    if (!pick || typeof pick !== 'object' || pick.label !== undefined) return pick;
    const label = labelForSource(pick.from);
    return label ? { ...pick, label } : pick;
}

/** The text site a field is, or null (`values.<key>` is the site `values`). */
function textSiteFor(stepType, field) {
    const sites = textSitesOf(stepType);
    const exact = sites.find(s => s.field === field);
    if (exact) return exact;
    const head = String(field || '').split('.')[0];
    return sites.find(s => s.each && s.field === head) || null;
}

/**
 * A `{{ }}` text as a compose binding, every part labelled, or null when it
 * holds no placeholder or one a pick does not read the same way (then the
 * text stays the template it is). The rule is the shared core's
 * templateToCompose; `sole` there makes a text that is exactly one
 * placeholder a pick of the value itself.
 * @param {string} text
 * @param {{ stepType: string, field: string, sole?: boolean }} where
 */
function composeFromTemplate(text, { stepType, field, sole = false }) {
    const lifted = templateToCompose(text, { stepType, field, sole });
    if (!lifted) return null;
    if (lifted.kind === 'pick') return withLabel(lifted);
    return { ...lifted, parts: lifted.parts.map(p => (typeof p === 'string' ? p : withLabel(p))) };
}

const COMPACT_PICK_KEYS = new Set(['pick', 'take', 'as', 'join', 'label', 'required']);

/** `{ compose: [...] }` and nothing else: the compact compose. */
function isCompactCompose(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v) && v.kind === undefined
        && Array.isArray(v.compose) && Object.keys(v).every(k => k === 'compose');
}

/** `{ pick: '<path>' | Source, take?, as?, join?, label?, required? }` and nothing else. */
function isCompactPick(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.kind !== undefined) return false;
    if (typeof v.pick !== 'string' && !(v.pick && typeof v.pick === 'object' && !Array.isArray(v.pick))) return false;
    return Object.keys(v).every(k => COMPACT_PICK_KEYS.has(k));
}

const WILD_RE = /\[\s*\*\s*\]/;

/**
 * A pick the model wrote with its path as text: a `[*]` in that path says
 * "all of them", as it does in a ref, so without a take of its own it takes
 * all. (The Source keeps no `[*]`: a key on a list maps over it.)
 */
function wildTake(v) {
    if (!v || typeof v !== 'object' || v.take !== undefined) return v;
    const path = typeof v.pick === 'string' ? v.pick : (typeof v.from === 'string' ? v.from : null);
    return path !== null && WILD_RE.test(path) ? { ...v, take: 'all' } : v;
}

/**
 * A compose part as stored: a text stays text, a pick (compact or not) is
 * expanded and labelled, anything else is kept for the checks to refuse.
 */
function composePart(p) {
    if (typeof p === 'string') return p;
    const part = normalizePick(wildTake(p), { part: true });
    if (!part) return p;
    if (part.kind !== undefined) delete part.kind;
    return withLabel(part);
}

/**
 * The stored form of a v2 binding the model wrote, labelled: a pick or a
 * compact pick (normalizePick), a compose or a compact `{compose:[…]}` with
 * every part expanded. A compact form has no version by construction and is
 * stamped with the current one; a `kind: 'pick'|'compose'` object keeps the
 * version it was given (without one it is a literal object at run time, and
 * the checks say so rather than make it live here).
 * A pick whose path is text with a `[*]` in it takes all (wildTake).
 * Returned even when it does not validate, so the caller can say why.
 * @param {object} raw
 */
function canonicalMapping(raw) {
    const v = wildTake(raw);
    if (isCompactCompose(v)) {
        return { kind: 'compose', v: MAPPING_VERSION, parts: v.compose.map(composePart) };
    }
    if (v.kind === 'compose') {
        const out = { kind: 'compose' };
        if (v.v !== undefined) out.v = v.v;
        out.parts = Array.isArray(v.parts) ? v.parts.map(composePart) : v.parts;
        return out;
    }
    const compact = v.kind === undefined;
    const pick = normalizePick(v);
    if (!pick) {
        if (!compact) return raw;
        // normalizePick spells take/as/join/label the one way; the stand-in
        // Source is replaced by the path as written, for the error to name.
        return { ...normalizePick({ ...v, pick: { root: 'vars', path: [] } }), from: v.pick };
    }
    if (!compact) {
        if (v.v === undefined) delete pick.v;
        else pick.v = v.v;
    }
    return withLabel(pick);
}

/** Is this a v2 binding in any spelling the builder reads? */
function isMappingShape(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v)
        && (v.kind === 'pick' || v.kind === 'compose' || isCompactPick(v) || isCompactCompose(v));
}

/** A pick (stored form) as the one part of a compose, written as text. */
function pickAsPart(pick) {
    const part = { from: pick.from, take: pick.take, as: pick.as === 'native' ? 'text' : pick.as };
    if (pick.join !== undefined) part.join = pick.join;
    if (pick.label !== undefined) part.label = pick.label;
    return part;
}

/**
 * The value a step's text field stores, from what the model sent:
 *
 *   - a `{{ }}` string: a compose where the field takes one and every
 *     placeholder reads a plain path (a fill_document value that is one
 *     sole placeholder: a pick of the value itself); else the string;
 *   - a compose or pick in any spelling: its stored form (a pick becomes a
 *     compose of one part, since the field renders text);
 *   - a legacy binding object: its `{{ }}` text, then as a string above;
 *   - anything else: `fallback(value)` (the field's old coercion).
 *
 * In a field that takes plain text only, a compose or pick is written back
 * as `{{ }}` text (textAsTemplate): the one form that field renders.
 * @param {unknown} value
 * @param {{ stepType: string, field: string, fallback?: (v: unknown) => unknown }} where
 */
function textFieldValue(value, { stepType, field, fallback = (v) => v }) {
    const site = NOT_A_TEXT.has(`${stepType}.${field}`) ? null : textSiteFor(stepType, field);
    const sole = stepType === 'fill_document' && String(field).startsWith('values.');
    let v = value;
    if (isMappingShape(v)) {
        let mapping = canonicalMapping(v);
        if (isPick(mapping) && !sole) mapping = { kind: 'compose', v: MAPPING_VERSION, parts: [pickAsPart(mapping)] };
        if (site && site.compose === false) return isPick(mapping) || isCompose(mapping) ? textAsTemplate(mapping) : mapping;
        return mapping;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.kind === 'string') {
        if (v.kind === 'ref' && typeof v.path === 'string') v = `{{${v.path}}}`;
        else if ((v.kind === 'template' || v.kind === 'literal') && typeof v.value === 'string') v = v.value;
    }
    if (typeof v !== 'string') return fallback(v);
    if (!site || site.compose === false || KEEP_TEMPLATE.has(`${stepType}.${field}`)) return v;
    return composeFromTemplate(v, { stepType, field, sole }) || v;
}

/**
 * Is `key` a top-level text field of this step type (sites.mjs), one whose
 * value is a text rather than a binding? A nested one (`toast.message`) is
 * not patched as a key of its own.
 * @param {string} stepType
 * @param {string} key
 */
function isTextField(stepType, key) {
    if (NOT_A_TEXT.has(`${stepType}.${key}`)) return false;
    return textSitesOf(stepType).some(site => site.field === key && !site.each);
}

/**
 * Every top-level text field of a built step in its stored form
 * (textFieldValue), for the steps that arrive whole rather than through
 * their add tool (a loop body). Changes the step in place and returns it.
 * A nested text field (`toast.message`, `chart.unit`) takes plain text only
 * and is left as written.
 * @param {object} step
 */
function composeTextFields(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
    for (const site of textSitesOf(step.type)) {
        if (site.field.includes('.') || NOT_A_TEXT.has(`${step.type}.${site.field}`)) continue;
        const current = step[site.field];
        if (current === undefined) continue;
        if (!site.each) {
            step[site.field] = textFieldValue(current, { stepType: step.type, field: site.field });
            continue;
        }
        if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
        const map = {};
        for (const [k, v] of Object.entries(current)) map[k] = textFieldValue(v, { stepType: step.type, field: `${site.field}.${k}` });
        step[site.field] = map;
    }
    return step;
}

/**
 * The legacy path a binding reads, for the checks written against ref paths
 * (a loop item's field, a file location): a ref's path, or a pick's Source
 * spelled as one. null for anything else.
 * @param {unknown} b
 */
function refPathOf(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
    if (b.kind === 'ref' && typeof b.path === 'string') return b.path;
    if (isPick(b)) return describeSource(b.from) || null;
    return null;
}

/**
 * The binding read at another path, in its own kind: a ref gets the path, a
 * pick the Source it spells (its label kept, or derived anew when the key it
 * reads changed). The binding unchanged when the path reads no Source.
 * @param {object} b
 * @param {string} path
 */
function withRefPath(b, path) {
    if (b.kind === 'ref') return { ...b, path };
    if (!isPick(b)) return b;
    const from = sourceFromPath(path);
    if (!from) return b;
    const next = { ...b, from };
    if (labelForSource(b.from) === b.label) delete next.label;
    return withLabel(next);
}

module.exports = {
    labelForSource,
    composeFromTemplate,
    textFieldValue,
    composeTextFields,
    isTextField,
    canonicalMapping,
    isCompactPick,
    isCompactCompose,
    isMappingShape,
    refPathOf,
    withRefPath,
};
