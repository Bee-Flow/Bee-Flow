/**
 * Binding resolver for automation step inputs.
 *
 * Each step input is one of:
 *   { kind: 'literal',  value: <any> }
 *   { kind: 'ref',      path:  'steps.s1.output.items[0].subject' }
 *   { kind: 'template', value: 'Found {{steps.s1.output.count}} invoices' }
 *   { kind: 'expr',     value: 'steps.s1.output.amount > 1000 ? "high" : "low"' }
 *
 * Bare values (numbers/strings/booleans/arrays/objects without a `kind` field)
 * are treated as literals — this is a tolerance for hand-authored definitions
 * and AI-generated bindings that skip the wrapper.
 *
 * Roots available in runState:
 *   trigger.output, steps.<id>.output, loop.<itemVar>, vars, secrets
 *   (`secrets` is excluded from `template` bindings — see resolveValue.)
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { evaluate, parseExpr, templateText, parsePath, walkTokens, getRelativePath, replaceTemplate, scanTemplate, parseJsonText, formatPath, jsonCacheFor } = require('./expr');
const log = require('../telemetry/log');

// ── The binding log ─────────────────────────────────────────────────────
//
// A mapping that resolves to nothing used to leave no trace: the step got an
// empty value, the run stayed green, and the person looking at it could only
// say "it doesn't always work". The runner opens a log around every step
// (core/automationRunner/execution.js dispatchStep) and every miss made while
// it is open lands in it: which input, which path, and where the walk stopped.
//
// AsyncLocalStorage rather than a runState field: steps in parallel branches
// share one runState, so a per-run array could not tell their misses apart,
// and the resolvers are called from dozens of step handlers that would all
// have to pass a sink along. Outside a log (validation, previews, tests)
// nothing is recorded.
const bindingLogStore = new AsyncLocalStorage();
// One step can resolve the same binding for thousands of list items; the
// log keeps each distinct miss once, with a count, and at most this many.
const MAX_BINDING_LOG_ENTRIES = 50;

/**
 * Run `fn` with `entries` (an array) as the binding log: every mapping that
 * finds nothing while `fn` runs, including its async continuations, is
 * pushed there as `{ field?, kind, path, reason, at?, found?, missing?,
 * message?, count }`. Returns what `fn` returns.
 *
 *   reason 'missing'  the path is fine, the data has nothing there; `at` is
 *                     the deepest part that did resolve, `found` what was
 *                     there ('record' | 'list' | 'text' | 'number' | 'yes/no'
 *                     | 'empty'), `missing` the key it did not have
 *          'not_run'  the path reads steps.<id> and that step has not run
 *          'syntax'   not a path (ref, template) or not an expression (expr)
 *          'error'    the expression failed while evaluating (`message`)
 */
function withBindingLog(entries, fn) {
    return bindingLogStore.run({ entries, field: null }, fn);
}

/** Resolve under a field name, so a miss can say which input it was for. */
function underField(name, fn) {
    const store = bindingLogStore.getStore();
    if (!store) return fn();
    const prev = store.field;
    store.field = prev ? `${prev}.${name}` : String(name);
    try { return fn(); } finally { store.field = prev; }
}

// `cache`: the run's JSON-text cache (jsonCacheFor), so describing a miss
// on every item of a loop does not parse the same large body again each time.
function kindOfValue(v, cache = null) {
    if (v === null || v === undefined) return 'empty';
    if (Array.isArray(v)) return 'list';
    if (typeof v === 'string') {
        const parsed = parseJsonText(v, cache);
        if (parsed === undefined) return 'text';
        return Array.isArray(parsed) ? 'list' : 'record';
    }
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'yes/no';
    return 'record';
}

/** Where a path that resolved to nothing stopped, as `{ reason, at, found, missing, size }`. */
function analyseMiss(path, root) {
    const tokens = parsePath(path);
    if (!tokens) return { reason: 'syntax' };
    const head = tokens[0] && tokens[0].key;
    if (head === 'steps' && tokens[1] && tokens[1].type === 'prop'
        && !(root && root.steps && Object.prototype.hasOwnProperty.call(root.steps, tokens[1].key))) {
        return { reason: 'not_run', at: formatPath(tokens.slice(0, 2)), step: String(tokens[1].key) };
    }
    const cache = jsonCacheFor(root);
    for (let n = tokens.length - 1; n >= 1; n--) {
        const v = walkTokens(tokens.slice(0, n), root);
        if (v === undefined) continue;
        const next = tokens[n];
        const out = { reason: 'missing', at: formatPath(tokens.slice(0, n)), found: kindOfValue(v, cache) };
        if (next.type === 'prop') out.missing = String(next.key);
        else if (next.type === 'match') out.missing = formatPath([next]);
        else out.missing = '[*]';
        if (typeof next.key === 'number') out.index = true;
        const list = Array.isArray(v) ? v : (typeof v === 'string' ? parseJsonText(v, cache) : undefined);
        if (Array.isArray(list)) out.size = list.length;
        return out;
    }
    return { reason: 'missing' };
}

function noteMiss(rec) {
    const store = bindingLogStore.getStore();
    if (!store || !Array.isArray(store.entries)) return;
    const field = store.field || rec.field || null;
    const same = store.entries.find(e => e.kind === rec.kind && e.path === rec.path
        && e.reason === rec.reason && (e.field || null) === field);
    if (same) { same.count += 1; return; }
    if (store.entries.length >= MAX_BINDING_LOG_ENTRIES) return;
    const entry = { ...(field ? { field } : {}) };
    for (const [k, v] of Object.entries(rec)) if (k !== 'field' && v !== undefined) entry[k] = v;
    entry.count = 1;
    store.entries.push(entry);
}

function noteMissedPath(kind, path, root, extra = {}) {
    if (!bindingLogStore.getStore()) return;
    noteMiss({ kind, path, ...analyseMiss(path, root), ...extra });
}

/**
 * One binding-log entry as a sentence a person can act on:
 *   'input "to" read steps.http.output.data.contact.e-mail, but
 *    steps.http.output.data.contact has no "e-mail"'.
 */
function describeBindingMiss(e) {
    if (!e || typeof e !== 'object') return '';
    const who = e.field ? `input "${e.field}"` : 'a mapping';
    const what = e.path;
    const times = e.count > 1 ? ` (${e.count}×)` : '';
    let why;
    switch (e.reason) {
        case 'syntax':
            why = e.kind === 'expr'
                ? `could not be read: ${e.message || 'not a valid formula'}`
                : 'is not a valid path';
            return `${who}: ${e.kind === 'expr' ? `the formula ${e.path}` : e.path} ${why}${times}`;
        case 'error':
            return `${who}: the formula ${e.path} failed: ${e.message || 'error'}${times}`;
        case 'not_run':
            return `${who} read ${e.path}, but step "${e.step || '?'}" has not run in this run${times}`;
        default:
            break;
    }
    if (!e.at) {
        return e.kind === 'expr' && !parsePath(String(e.path || ''))
            ? `${who}: the formula ${what} gave nothing${times}`
            : `${who} read ${what}: nothing there${times}`;
    }
    if (e.missing === '[*]') return `${who} read ${what}, but ${e.at} is ${e.found === 'empty' ? 'empty' : `a ${e.found}`}, not a list${times}`;
    if (e.found === 'list') {
        const n = typeof e.size === 'number' ? ` of ${e.size}` : '';
        if (e.index) return `${who} read ${what}, but ${e.at} is a list${n}, with no item [${e.missing}]${times}`;
        if (String(e.missing || '').startsWith('[')) return `${who} read ${what}, but no item of ${e.at} matches ${e.missing}${times}`;
        return `${who} read ${what}, but ${e.at} is a list${n}: pick one item (${e.at}[0]) or every item (${e.at}[*])${times}`;
    }
    if (e.found === 'text') return `${who} read ${what}, but ${e.at} is text, not a record${times}`;
    if (e.found === 'empty') return `${who} read ${what}, but ${e.at} is empty${times}`;
    if (e.found === 'record') return `${who} read ${what}, but ${e.at} has no "${e.missing}"${times}`;
    return `${who} read ${what}, but ${e.at} is a ${e.found}${times}`;
}

// Defensive deep-clone for binding values. Without this, an object literal
// in a definition (`{kind:'literal', value:{...}}`) would be returned by
// reference — a downstream step mutating its inputs would silently corrupt
// the definition's binding for every subsequent run. Primitives are
// returned as-is to keep the hot path cheap.
function cloneLiteral(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); }
    catch { return JSON.parse(JSON.stringify(value)); }
}

/**
 * Walk a dotted/bracketed path on an object. Used by both ref-resolution
 * and the inside of {{...}} templates. The grammar and the walking rules
 * live in shared/expr/path.mjs, the ONE copy the builder's preview, the
 * expression engine and the phone use too:
 *   - keys: `.name` (unicode, `-`, `@`, digits allowed), `["any key"]` with
 *     JSON escapes, `[0]`, `[-1]` (last);
 *   - `[*]` maps the rest of the path over a list and flattens one level, so
 *     `steps.read.output.results[*].output.attachments` is one flat list of
 *     attachments across every message; a trailing `[*]` is the list itself;
 *   - JSON text (an HTTP body, an AI answer, even ```json fenced) is read as
 *     the object it encodes;
 *   - never the prototype chain: `…output.constructor.name` is undefined.
 * Tolerates undefined intermediates.
 */
function walkPath(path, root) {
    if (!path || typeof path !== 'string') return undefined;
    const tokens = parsePath(path);
    if (!tokens) return undefined;
    return walkTokens(tokens, root);
}

/**
 * A path that has to name a LIST (a Loop's or a per-item step's source, a
 * collection step's arrayRef): walkPath, plus JSON text that encodes a list
 * reads as that list, so `steps.http.output.body` iterates when the body came
 * back as text. The same reading `body[*]` already had.
 */
function walkList(path, root) {
    const v = walkPath(path, root);
    if (typeof v === 'string') {
        const parsed = parseJsonText(v, jsonCacheFor(root));
        if (Array.isArray(parsed)) return parsed;
    }
    return v;
}

/**
 * Walk a path RELATIVE to an arbitrary value (not the runState roots).
 * Used by the parse_json step and the design-time map-json-fields endpoint,
 * with the identical function in the builder (shared/expr/path.mjs
 * getRelativePath). Root-array sources work (`[0].x`, `[*].sku`), `$.a` too;
 * `''`/`'$'`/nullish returns the whole source.
 */
function walkRelativePath(path, value) {
    return getRelativePath(value, path);
}

/**
 * Resolve a single binding object against the runState.
 * @param {*} binding — { kind, ... } or a raw literal
 * @param {object} runState — { trigger, steps, loop, vars, secrets }
 * @param {object} opts
 * @param {'text'|'json'|'markdown'} opts.listAs — how a `template` binding writes a list
 *                  of plain values (see interpolateTemplate; default 'text')
 * @param {boolean} opts.allowSecrets — when false, secrets root is replaced
 *                  with an empty object so user-visible templates can't
 *                  echo secrets back to the chat or notification body.
 */
function resolveValue(binding, runState, opts = {}) {
    const { allowSecrets = false } = opts;
    const safeState = allowSecrets ? runState : { ...runState, secrets: {} };

    if (binding == null || typeof binding !== 'object' || Array.isArray(binding) || !binding.kind) {
        // Bare literal — but recursively resolve nested objects/arrays so
        // hand-built inputs like { to: 'a@b', body: { kind: 'ref', ... } }
        // still work.
        return resolveDeep(binding, runState, opts);
    }

    switch (binding.kind) {
        case 'literal':
            return cloneLiteral(binding.value);
        case 'ref': {
            const v = walkPath(binding.path, safeState);
            if (v === undefined) noteMissedPath('ref', typeof binding.path === 'string' ? binding.path : String(binding.path), safeState);
            return v;
        }
        case 'template':
            return interpolateTemplate(binding.value || '', safeState, { listAs: opts.listAs });
        case 'expr':
            return evaluateExprBinding(binding.value, safeState);
        default:
            return undefined;
    }
}

/**
 * An `expr` binding's value. A broken formula still resolves to undefined
 * (a step must not fail on it), but no longer silently: the binding log
 * records the parse or evaluation error, and a formula that is a plain path
 * and finds nothing is recorded like a ref.
 */
function evaluateExprBinding(src, safeState) {
    const text = typeof src === 'string' ? src : String(src ?? '');
    let ast;
    try { ast = parseExpr(text); }
    catch (e) {
        if (bindingLogStore.getStore()) noteMiss({ kind: 'expr', path: text, reason: 'syntax', message: e.message || String(e) });
        return undefined;
    }
    let v;
    try { v = evaluate(ast, safeState); }
    catch (e) {
        if (bindingLogStore.getStore()) noteMiss({ kind: 'expr', path: text, reason: 'error', message: e.message || String(e) });
        return undefined;
    }
    if (v === undefined && bindingLogStore.getStore()) {
        if (parsePath(text)) noteMissedPath('expr', text.trim(), safeState);
        else noteMiss({ kind: 'expr', path: text, reason: 'missing' });
    }
    return v;
}

/**
 * Resolve every binding inside a structure (objects, arrays).
 */
function resolveDeep(structure, runState, opts = {}) {
    if (structure == null) return structure;
    if (Array.isArray(structure)) return structure.map(s => resolveDeep(s, runState, opts));
    if (typeof structure === 'object') {
        // If this object is itself a binding wrapper, resolve it.
        if (typeof structure.kind === 'string' && ['literal', 'ref', 'template', 'expr'].includes(structure.kind)) {
            return resolveValue(structure, runState, opts);
        }
        const out = {};
        for (const k of Object.keys(structure)) out[k] = underField(k, () => resolveDeep(structure[k], runState, opts));
        return out;
    }
    return structure;
}

/**
 * Resolve a step's `inputs` map. Returns plain object with concrete values.
 */
function resolveInputs(inputs, runState, opts = {}) {
    if (!inputs || typeof inputs !== 'object') return {};
    const out = {};
    for (const k of Object.keys(inputs)) out[k] = underField(k, () => resolveValue(inputs[k], runState, opts));
    return out;
}

/**
 * The value of one `{{ path }}` placeholder. A miss is written to
 * `runState._templateWarnings` (the run-level breadcrumbs) and to the binding
 * log. With `leaveUnresolved` (an AI prompt, where `{{…}}` may be text the
 * author meant literally) only a placeholder that reads a real root of the
 * run (steps, trigger, loop, vars) counts as a miss.
 */
function resolveTemplatePath(trimmed, runState, opts = {}) {
    const v = walkPath(trimmed, runState);
    if (v !== undefined) return v;
    if (runState && Array.isArray(runState._templateWarnings)) {
        runState._templateWarnings.push(trimmed);
    }
    if (process.env.AUTOMATION_DEBUG_BINDINGS) {
        log.warn(`[bind] template path "${trimmed}" resolved to undefined`);
    }
    if (bindingLogStore.getStore()) {
        const tokens = parsePath(trimmed);
        const readsRunRoot = !!tokens && ['steps', 'trigger', 'loop', 'vars'].includes(tokens[0].key);
        if (!opts.leaveUnresolved || readsRunRoot) {
            noteMissedPath('template', trimmed, runState, opts.field ? { field: opts.field } : {});
        }
    }
    return undefined;
}

/**
 * Interpolate a template string with {{ path }} segments. `undefined` and
 * `null` paths render as the empty string (callers historically depend on
 * this — e.g. notification bodies and prompt prefixes). To make the silent
 * failure mode discoverable, when a path resolves to `undefined` we record
 * it on `runState._templateWarnings` (if the array exists) so the runner
 * can surface a per-run warning summary; `AUTOMATION_DEBUG_BINDINGS=1`
 * additionally logs to the server console.
 *
 * What a value looks like in the text is `templateText` (shared/expr): a list
 * of plain values reads "red, green, blue", a record or a list of records
 * stays compact JSON with its keys in the order the step returned them, null
 * is empty. That is the default because most slots are prose (notification,
 * e-mail and chat bodies, documents). A slot that carries DATA says so with
 * `listAs: 'json'` (http_request url/headers/body, a prompt, a code step's
 * inputs) and keeps every list as JSON.
 *
 * @param {object} [opts]
 * @param {'text'|'json'|'markdown'} [opts.listAs] — how a list of plain values
 *   is written: 'text' (default) comma-separated, 'json' as JSON, 'markdown' as
 *   bullets (same as `listAsMarkdown: true`).
 * @param {boolean} [opts.leaveUnresolved] — when true, a `{{token}}` whose
 *   path resolves to `undefined` is returned VERBATIM (braces and all)
 *   rather than blanked. Used for AI-step prompts so a literal `{{...}}`
 *   the builder typed (and any not-yet-available reference) isn't silently
 *   deleted from the instruction text. Default false keeps the historical
 *   blank-on-miss behaviour for notification/stop_error callers.
 * @param {string} [opts.field] — the setting this text fills (`body`, `url`),
 *   named by a miss in the binding log when no input name is known.
 * @param {boolean} [opts.listAsMarkdown] — when true, a path that resolves to
 *   an array of plain values renders as a markdown bullet list instead of as
 *   a comma-separated line. Used ONLY for the human-readable text of a form
 *   page, which IS rendered as markdown: a step that produced a list of
 *   findings put `["Productaanbod van RVS platen…","Algemene bedrijfspresentatie…"]`,
 *   brackets and quotes and all, on a page a customer reads. Opt-in: every
 *   other slot reads the list on one line.
 */
function interpolateTemplate(template, runState, opts = {}) {
    const { leaveUnresolved = false, listAsMarkdown = false } = opts;
    const listAs = listAsMarkdown ? 'markdown' : (opts.listAs || 'text');
    // In a markdown slot a list of plain values, or a table, becomes bullets.
    const asMarkdownList = (v) => {
        if (listAs !== 'markdown' || !Array.isArray(v)) return null;
        if (!v.length) return '';
        const scalar = (x) => x == null || ['string', 'number', 'boolean'].includes(typeof x);
        const isRec = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
        // A list of plain values, or a table (one bullet per row, read as
        // "key: value"). Anything mixed keeps the prose rendering.
        if (!v.every(scalar) && !v.every(x => x == null || isRec(x))) return null;
        // Blank line first: a bullet list has to start its own block, or it
        // glues itself onto the label that introduces it.
        const NL = String.fromCharCode(10);
        return NL + NL + v.filter(x => x != null || v.every(scalar))
            .map(x => '- ' + (x == null ? '' : (isRec(x) ? templateText(x) : String(x).trim()))).join(NL) + NL;
    };
    // Quote-aware placeholder scan (shared/expr/path.mjs scanTemplate): a
    // `}` inside a bracket-quoted key no longer ends the placeholder.
    return replaceTemplate(String(template), (trimmed, whole) => {
        const v = resolveTemplatePath(trimmed, runState, opts);
        if (v === undefined) {
            return leaveUnresolved ? whole : '';
        }
        const list = asMarkdownList(v);
        if (list !== null) return list;
        // null -> '', a list of plain values -> "red, green, blue", a record
        // (or a list of records) -> compact JSON in the author's key order.
        // The editor's preview calls the same function (shared/expr/templateText).
        return templateText(v, { lists: listAs === 'json' ? 'json' : 'join' });
    });
}

// ── JSON request bodies ─────────────────────────────────────────────────

const JSON_CONTENT_TYPE_RE = /[/+]json\b/i;

/** `"…"` content for a value: its text, JSON-escaped (no surrounding quotes). */
function jsonStringContent(v) {
    if (v === undefined || v === null) return '';
    const text = typeof v === 'string' ? v : templateText(v, { lists: 'json' });
    return JSON.stringify(text).slice(1, -1);
}

/** A bare JSON value for a placeholder whose old raw text did not fit where it stands. */
function jsonBareValue(v) {
    if (v === undefined || v === null) return 'null';
    if (typeof v === 'string') {
        // Fenced JSON (```json … ```) goes in as the value it encodes; text
        // that is a JSON value once trimmed goes in as that value; anything
        // else is a string.
        const parsed = parseJsonText(v);
        if (parsed !== undefined) return JSON.stringify(parsed);
        const t = v.trim();
        if (t) {
            try { JSON.parse(t); return t; } catch { /* plain text */ }
        }
        return JSON.stringify(v);
    }
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v) ?? 'null'; } catch { return 'null'; }
}

const isJsonText = (text) => {
    try { JSON.parse(text); return true; } catch { return false; }
};

/**
 * Where each `{{…}}` of a JSON-shaped template sits: inside a JSON string
 * (`inString`), and whether it is that string's whole content (`sole`).
 * `index` is the placeholder's position in `parts`. Null when the template
 * is not JSON-shaped, i.e. when it does not start with `{` or `[` or does not
 * parse once every placeholder is replaced by an empty string (in a string)
 * or `null` (as a value).
 */
function jsonTemplateLayout(parts) {
    if (!parts.length || parts[0].type !== 'text' || !/^\s*[[{]/.test(parts[0].value)) return null;
    let inString = false;
    let openedAtEnd = false;
    const layout = [];
    let probe = '';
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.type === 'text') {
            openedAtEnd = false;
            for (let j = 0; j < p.value.length; j++) {
                const c = p.value[j];
                if (inString && c === '\\') { j++; continue; }
                if (c === '"') {
                    inString = !inString;
                    openedAtEnd = inString && j === p.value.length - 1;
                }
            }
            probe += p.value;
            layout.push({ part: p, index: i });
            continue;
        }
        const next = parts[i + 1];
        const sole = inString && openedAtEnd && !!next && next.type === 'text' && next.value.startsWith('"');
        layout.push({ part: p, index: i, inString, sole });
        probe += inString ? '' : 'null';
        openedAtEnd = false;
    }
    if (inString) return null;
    try {
        const v = JSON.parse(probe);
        if (v === null || typeof v !== 'object') return null;
    } catch { return null; }
    return layout;
}

/** The rest of a JSON-shaped template from `from` on, every placeholder as its empty stand-in. */
function restProbe(layout, from) {
    let out = '';
    for (let i = from; i < layout.length; i++) {
        const { part, inString } = layout[i];
        out += part.type === 'text' ? part.value : (inString ? '' : 'null');
    }
    return out;
}

/**
 * Fill a request body, keeping a JSON body valid JSON.
 *
 * The body is first written the way it always was: plain templating with
 * `listAs: 'json'` (a mapped string raw, a list or record as JSON, nothing as
 * nothing). When that is valid JSON, or the body is not JSON at all, it is
 * sent byte for byte: saved automations rely on those exact bytes (an ID list
 * joined into `[{{ids}}]`, a string field holding encoded JSON, a 64-bit id
 * JSON.parse would round, `"{{x}}"` holding a list an API wants as text).
 *
 * Only a JSON-shaped body (see jsonTemplateLayout) that the plain templating
 * BROKE is repaired. That used to happen to `{"text":"{{steps.ai.output.summary}}"}`
 * for every record whose text held a quote, a newline or a backslash, and to
 * `{"v": {{…}}}` for every empty field: an external API answering 400 for
 * SOME records. The repair changes only the placeholders whose old text does
 * not fit where they stand:
 *   - inside a string: the value's text, JSON-escaped (text without a quote,
 *     backslash or control character is unchanged by that);
 *   - as the whole string (`"{{x}}"`) with a record or a list whose JSON
 *     text would break the string: that record or list itself;
 *   - as a value: the old raw text when it is a run of complete JSON values
 *     and the body still parses with it (so `[{{ids}}]` keeps `101,102`, and
 *     a fragment that would ADD keys never goes in raw); otherwise the value
 *     as JSON, `null` for nothing.
 * Every placeholder is resolved once; both writings use the same values, so
 * a miss is logged once.
 *
 * @param {string} template
 * @param {object} runState
 * @param {{ contentType?: string, field?: string }} [opts]
 */
function interpolateJsonBody(template, runState, opts = {}) {
    if (typeof template !== 'string' || !template) {
        return interpolateTemplate(template, runState, { listAs: 'json', field: opts.field });
    }
    const ct = typeof opts.contentType === 'string' ? opts.contentType.trim() : '';
    if (ct && !JSON_CONTENT_TYPE_RE.test(ct)) {
        return interpolateTemplate(template, runState, { listAs: 'json', field: opts.field });
    }
    const tplOpts = { field: opts.field };
    const parts = scanTemplate(template);
    // What interpolateTemplate(…, { listAs: 'json' }) writes for each part.
    const values = parts.map(p => (p.type === 'ref' ? resolveTemplatePath(p.inner, runState, tplOpts) : undefined));
    const rawText = parts.map((p, i) => (p.type === 'text' ? p.value : templateText(values[i], { lists: 'json' })));
    const asBefore = rawText.join('');
    if (isJsonText(asBefore)) return asBefore;
    const layout = jsonTemplateLayout(parts);
    if (!layout) return asBefore;
    let out = '';
    let skipQuote = false;
    for (let i = 0; i < layout.length; i++) {
        const { part, index, inString, sole } = layout[i];
        if (part.type === 'text') {
            out += skipQuote ? part.value.slice(1) : part.value;
            skipQuote = false;
            continue;
        }
        const v = values[index];
        const raw = rawText[index];
        if (inString) {
            const escaped = jsonStringContent(v);
            if (sole && v !== null && typeof v === 'object' && escaped !== raw) {
                out = out.slice(0, -1) + JSON.stringify(v);
                skipQuote = true;
            } else {
                out += escaped;
            }
        } else if (isJsonText(`[${raw}]`) && isJsonText(out + raw + restProbe(layout, i + 1))) {
            out += raw;
        } else {
            out += jsonBareValue(v);
        }
    }
    if (!isJsonText(out)) {
        // Cannot happen by construction; if it ever does, send what the old
        // templating would have sent rather than something new and wrong.
        log.warn('[bind] JSON body did not stay JSON after interpolation; falling back to plain templating');
        return asBefore;
    }
    return out;
}

module.exports = {
    walkList,
    resolveValue, resolveDeep, resolveInputs, walkPath, walkRelativePath, interpolateTemplate, cloneLiteral,
    interpolateJsonBody, withBindingLog, describeBindingMiss,
};
