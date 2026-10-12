/**
 * Automation Builder — the verification half of POST /suggest-mappings
 * (suggestMappings.js): what a model proposed for an input, checked against
 * the editor's samples with the runtime's own code before it may reach the
 * canvas.
 *
 * A proposal survives only when
 *   - every path parses (shared/expr grammar), starts at one of the offered
 *     sources and resolves to a value on the sample;
 *   - no path reads a field the prompt hid (a secret-like key, or an entry of
 *     a name/value list named like one): the model knows nothing about such a
 *     value, so it can only pick it blindly or because the sample told it to;
 *   - it has a PILL shape (mapping/valueParts.js): a field, text with
 *     fields, or ONE transform of ONE field. A plain path written as a
 *     formula becomes a ref; text glued with `+` becomes a template when both
 *     give the same text on the sample; anything else is dropped;
 *   - its value fits the input (judgeFit).
 * What is dropped is returned with the reason, so the editor (and the tests)
 * can tell a wrong guess from a missing field.
 *
 * Pure: no model, no request, no logging.
 */

'use strict';

const {
    parsePath, walkTokens, appendKey, appendMatch, appendWildcard,
    parseExpr, evaluate, scanTemplate, parseJsonText, stepInto, stepMatch,
} = require('../../../automation/expr');
const { interpolateTemplate } = require('../../../automation/bind');

const MAX_TEMPLATE_CHARS = 1000;
const MAX_EXPR_CHARS = 400;
const MAX_REASON_CHARS = 160;
const PREVIEW_CHARS = 120;
// Rows of a list compared with a loop sample: the editor merges this many
// (agent-hub upstream/fieldTree FIELD_LIMITS.elements).
const LOOP_ROWS_COMPARED = 50;
const LOOP_COMPARE_DEPTH = 8;
// Values followed per [*] when looking for a hidden entry on a path.
const HIDDEN_SCAN = 200;

const ROOT_WORDS = new Set(['steps', 'trigger', 'loop']);
// Same family as agent-hub autoMapInputs.isSecretLikeKey: never shown to the
// model (suggestMappings.describeSource), never mapped (readsHidden).
const SECRET_KEY_RE = /(password|passwd|secret|token|apikey|api[_-]?key|credential|client[_-]?secret|private[_-]?key|authorization|cookie)/i;

// Lists of name/value pairs (mail headers, custom fields, attributes): the
// entry a person means is "the Subject header", not "header number 4", and
// the grammar says exactly that: headers[name="Subject"].value.
const PAIR_NAME_KEYS = ['name', 'key', 'Name', 'Key', 'field', 'label', 'title'];
const PAIR_VALUE_KEYS = ['value', 'values', 'Value', 'content', 'text', 'val', 'data', 'stringValue', 'displayValue'];
const PAIR_ENTRY_MAX_KEYS = 5;
const PAIR_NAME_MAX_CHARS = 80;
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;
// A design-time placeholder (agent-hub upstream samplePlaceholderFor): not data.
const PLACEHOLDER_RE = /^<[a-z_ -]+>$/i;

/**
 * The transforms ValueBuilder draws as ONE chip after a field pill
 * (mapping/valueParts.js VALUE_TRANSFORMS, plus parseJson's "Pick fields from
 * it" chip). `args` is how many string arguments may follow the path.
 */
const PILL_TRANSFORMS = Object.freeze({
    lower: { args: [0, 0] },
    upper: { args: [0, 0] },
    trim: { args: [0, 0] },
    number: { args: [0, 0] },
    round: { args: [0, 0] },
    toStr: { args: [0, 0] },
    first: { args: [0, 0] },
    last: { args: [0, 0] },
    count: { args: [0, 0] },
    groupSummary: { args: [0, 0] },
    asTable: { args: [0, 0] },
    join: { args: [0, 1], check: (a) => a.length <= 10 },
    formatNumber: { args: [0, 1], check: (a) => ['amount', 'percent', 'plain'].includes(a) },
    formatDate: { args: [0, 1], check: (a) => /^[DMYHhms\-/ .:,]{1,40}$/.test(a) },
    yesNoText: { args: [0, 2], check: (a) => a.length <= 40 },
    parseJson: { args: [0, 1], check: (a) => !/["']/.test(a) && a.length <= 200 },
});
// A transform that changes nothing on this value is dropped in favour of the
// bare field (`toStr(subject)` on a subject that is text is just `subject`).
const NOOP_WHEN_EQUAL = new Set(['toStr', 'trim', 'number']);

// Inside a transform the editor reads the field up to the first `,` or `)`
// (valueParts.js ARG1_CALL), so a key holding one of `,()` cannot be a chip
// there. Otherwise a canonical path is what the editor's own reader takes,
// in a ref, in {{ }} (quote-aware) and in a call alike.
const pillPathInCall = (path) => !/[,()]/.test(path);

// ── Kinds ───────────────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The key that names `el` when it is a name/value ENTRY named like a secret
 * (`{ name: "Authorization", value: "Bearer …" }`, an AWS tag `{ Key:
 * "db_password", Value }`), else null. The entry's other fields are hidden;
 * its name is not. Only an entry counts (a few keys, one of them a value
 * key), so a calendar event titled "Rotate the password policy" stays
 * readable.
 */
function secretEntryNameKey(el) {
    if (!isPlainObject(el) || Object.keys(el).length > PAIR_ENTRY_MAX_KEYS) return null;
    if (!PAIR_VALUE_KEYS.some((k) => hasOwn(el, k))) return null;
    for (const nk of PAIR_NAME_KEYS) {
        const name = el[nk];
        if (typeof name === 'string' && name.length <= PAIR_NAME_MAX_CHARS && SECRET_KEY_RE.test(name)) return nk;
    }
    return null;
}

/** What an input takes, in agent-hub fieldKinds.expectedKindFor's words. */
function expectedKind(param) {
    let type = param.type;
    if (Array.isArray(type)) type = type.find((t) => t !== 'null') || type[0];
    const fmt = param.format || '';
    if (param.enum && (type === 'string' || !type) && fmt !== 'date' && fmt !== 'date-time') return 'choice';
    if (type === 'string') {
        if (fmt === 'date' || fmt === 'date-time') return 'date';
        return fmt === 'email' ? 'email' : 'text';
    }
    if (type === 'number' || type === 'integer') return 'number';
    if (type === 'boolean') return 'yesno';
    if (type === 'array') return 'list';
    if (type === 'object') return 'group';
    return 'unknown';
}

/** What a value is (agent-hub fieldKinds.kindOfValue, placeholders unknown). */
function valueKind(v) {
    if (v === null || v === undefined) return 'unknown';
    if (Array.isArray(v)) return v.length && v.every((x) => x == null || isPlainObject(x)) && v.some(isPlainObject) ? 'table' : 'list';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'yesno';
    if (typeof v === 'string') {
        const s = v.trim();
        if (PLACEHOLDER_RE.test(s)) return 'unknown';
        if (ISO_DATE_RE.test(s)) return 'date';
        return EMAIL_RE.test(s) ? 'email' : 'text';
    }
    return 'group';
}

const KIND_WORDS = {
    text: 'text', email: 'an e-mail address', number: 'a number', yesno: 'yes/no', date: 'a date',
    choice: 'one of the allowed values', list: 'a list', table: 'a table', group: 'a group of fields', unknown: 'a value',
};

/**
 * Does `value` fit an input of kind `expected`? `{ ok }`, `{ ok, wrap }` when
 * one transform makes it fit (a list of texts joined, numeric text read as a
 * number), or `{ ok: false, reason }`.
 */
function judgeFit(expected, value, param) {
    if (value === undefined) return { ok: false, reason: 'gives no value on the sample data' };
    const kind = valueKind(value);
    if (expected === 'unknown' || kind === 'unknown') return { ok: true };
    const scalarList = Array.isArray(value) && value.every(isScalar);
    switch (expected) {
        case 'text':
        case 'email': {
            if (kind === 'table' || kind === 'group') return { ok: false, reason: `is ${KIND_WORDS[kind]}, the input takes ${KIND_WORDS[expected]}` };
            if (Array.isArray(value)) {
                if (!scalarList) return { ok: false, reason: 'is a list of lists' };
                return { ok: true, wrap: 'join' };
            }
            if (expected === 'email' && !(kind === 'email' || (kind === 'text' && value.includes('@')))) {
                return { ok: false, reason: 'does not look like an e-mail address' };
            }
            return { ok: true };
        }
        case 'date':
            if (kind === 'date' || kind === 'number') return { ok: true };
            if (kind === 'text' && Number.isFinite(Date.parse(value))) return { ok: true };
            return { ok: false, reason: `is ${KIND_WORDS[kind]}, the input takes a date` };
        case 'choice': {
            if (!isScalar(value)) return { ok: false, reason: `is ${KIND_WORDS[kind]}, the input takes one of the allowed values` };
            const s = String(value).toLowerCase();
            if ((param.enum || []).some((e) => String(e).toLowerCase() === s)) return { ok: true };
            return { ok: false, reason: `"${String(value).slice(0, 40)}" is not one of the allowed values` };
        }
        case 'number':
            if (kind === 'number') return { ok: true };
            if (kind === 'text' && value.trim() !== '' && Number.isFinite(Number(value.trim()))) return { ok: true, wrap: 'number' };
            return { ok: false, reason: `is ${KIND_WORDS[kind]}, the input takes a number` };
        case 'yesno':
            return kind === 'yesno' ? { ok: true } : { ok: false, reason: `is ${KIND_WORDS[kind]}, the input takes yes/no` };
        case 'list':
            return kind === 'list' || kind === 'table' ? { ok: true } : { ok: false, reason: `is ${KIND_WORDS[kind]}, the input takes a list` };
        case 'group':
            return kind === 'group' ? { ok: true } : { ok: false, reason: `is ${KIND_WORDS[kind]}, the input takes a group of fields` };
        default:
            return { ok: true };
    }
}

// ── Verification ────────────────────────────────────────────────────────────

/** The run state the samples stand in for: steps.<id>.output, trigger.output, loop.<name>. */
function buildRunState(sources) {
    const state = { trigger: {}, steps: {}, loop: {}, vars: {} };
    for (const s of sources) {
        let cur = state;
        const keys = s.rootTokens.map((t) => t.key);
        for (let i = 0; i < keys.length - 1; i++) {
            if (!isPlainObject(cur[keys[i]])) cur[keys[i]] = {};
            cur = cur[keys[i]];
        }
        cur[keys[keys.length - 1]] = s.sample;
    }
    return state;
}

const startsWith = (tokens, prefix) => prefix.length <= tokens.length
    && prefix.every((p, i) => tokens[i].type === 'prop' && tokens[i].key === p.key);

/** Append tokens to a path the way the canonical writer spells them. */
function appendTokens(prefix, tokens) {
    let out = prefix;
    for (const t of tokens) {
        if (t.type === 'wild') out = appendWildcard(out);
        else if (t.type === 'match') out = appendMatch(out, t.key, t.value);
        else out = appendKey(out, t.key);
    }
    return out;
}

// ── Per element: the current element, not [0] of its list ───────────────────

/** JSON text read as the value it encodes; anything else as it is. */
const asValue = (v) => {
    if (typeof v !== 'string') return v;
    const parsed = parseJsonText(v);
    return parsed === undefined ? v : parsed;
};

/** JSON of an object, once per request (a loop sample is compared with many rows). */
function jsonOf(v, ctx) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (!ctx.json.has(v)) {
        let s = null;
        try { s = JSON.stringify(v); } catch { /* not serialisable: equal to nothing */ }
        ctx.json.set(v, s);
    }
    return ctx.json.get(v);
}

// `cut` is `full` cut short by the editor (aiAutoMap.boundValue: text + "…").
const cutOf = (cut, full) => typeof cut === 'string' && typeof full === 'string'
    && cut.endsWith('…') && full.startsWith(cut.slice(0, -1));
const sameScalar = (a, b) => a === b || cutOf(a, b) || cutOf(b, a);

/**
 * Walk a loop sample against the values a list's rows hold at the same
 * place: `tally.agree` counts plain values found among the rows' values,
 * `tally.disagree` is set by one that is not there.
 */
function compareWithRows(sample, values, depth, tally) {
    const vals = values.map(asValue).filter((v) => v != null);
    const s = asValue(sample);
    if (!vals.length || s == null || depth > LOOP_COMPARE_DEPTH) return;
    if (isPlainObject(s)) {
        const records = vals.filter(isPlainObject);
        if (!records.length) { tally.disagree = true; return; }
        for (const k of Object.keys(s)) {
            const sub = records.filter((r) => hasOwn(r, k)).map((r) => r[k]);
            if (sub.length) compareWithRows(s[k], sub, depth + 1, tally);
            if (tally.disagree) return;
        }
        return;
    }
    // Lists inside the rows are concatenated in a merged sample: only their kind says something.
    if (Array.isArray(s)) {
        if (!vals.some(Array.isArray)) tally.disagree = true;
        return;
    }
    if (vals.some((v) => sameScalar(v, s))) tally.agree += 1;
    else tally.disagree = true;
}

/**
 * Does `loopSrc` run over `list`? Its sample is what the editor shows for
 * the current element: one element as it is (a catalog sample, a list of
 * one), or the union of the first rows (upstream mergeElements: per key the
 * first value that says something, nested lists concatenated), each source
 * bounded on its own (long text cut with "…"). So agreement, not equality:
 * every plain value of the sample is found among the rows' values at the
 * same place, and at least one is. A list of other records (other files,
 * the outer mails) disagrees on its ids and names. Remembered per request.
 */
function loopRunsOver(loopSrc, list, ctx) {
    let byLoop = ctx.loopMatch.get(list);
    if (!byLoop) { byLoop = new Map(); ctx.loopMatch.set(list, byLoop); }
    if (byLoop.has(loopSrc)) return byLoop.get(loopSrc);
    let out = false;
    const rows = asValue(list);
    if (Array.isArray(rows) && rows.length) {
        const head = rows.slice(0, LOOP_ROWS_COMPARED);
        const want = jsonOf(loopSrc.sample, ctx);
        out = want !== null && head.some((el) => jsonOf(el, ctx) === want);
        if (!out) {
            const tally = { agree: 0, disagree: false };
            compareWithRows(loopSrc.sample, head, 0, tally);
            out = !tally.disagree && tally.agree > 0;
        }
    }
    byLoop.set(loopSrc, out);
    return out;
}

/**
 * A path through element n of a list that a loop source runs over, while
 * the step runs once per element of it, means the CURRENT element:
 * `steps.x.output.value[0].attachments[0].name` → `loop.att.name`. The
 * innermost loop wins (the index read last), whatever order the editor sent
 * the sources in, and a path that starts at an outer loop is carried on to
 * the inner one (`loop.mail.attachments[0].name` → `loop.att.name`).
 * Only plain keys and indexes count: `[*]` and `[name="…"]` read every / a
 * chosen element on purpose. Two loops over the same list: left as written.
 */
function currentElement(source, tokens, ctx) {
    const visited = new Set();
    for (;;) {
        visited.add(source);
        const loops = ctx.sources.filter((s) => !visited.has(s) && s.rootTokens[0].key === 'loop' && isPlainObject(s.sample));
        if (!loops.length) break;
        const from = source.rootTokens.length;
        let end = from;
        while (end < tokens.length && tokens[end].type === 'prop') end++;
        let found = null;
        for (let i = end - 1; i >= from && !found; i--) {
            if (typeof tokens[i].key !== 'number') continue;
            const list = walkTokens(tokens.slice(0, i), ctx.runState);
            if (list === undefined) continue;
            const hits = loops.filter((l) => loopRunsOver(l, list, ctx));
            if (hits.length > 1) return { source, tokens };
            if (hits.length === 1) found = { loop: hits[0], at: i };
        }
        if (!found) break;
        source = found.loop;
        tokens = [...found.loop.rootTokens, ...tokens.slice(found.at + 1)];
    }
    return { source, tokens };
}

/**
 * Does a path read what the prompt hides? A secret-like key below the
 * source root (a step called get_token is fine), a match on a secret-like
 * name (`headers[name="Authorization"]`), or a field of a name/value entry
 * named like one, also by index or through [*] (`headers[0].value`,
 * `headers[*].value`).
 */
function readsHidden(tokens, from, runState) {
    // `alt`: the second reading of a quoted key from an older saved path, which
    // the runtime falls back to (shared/expr walkTokens).
    const secretKey = (k) => typeof k === 'string' && SECRET_KEY_RE.test(k);
    for (let i = from; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'prop' && (secretKey(t.key) || secretKey(t.alt))) return true;
        if (t.type === 'match' && (SECRET_KEY_RE.test(String(t.key)) || SECRET_KEY_RE.test(String(t.value)))) return true;
    }
    // Follow the path, every element at a [*], and look at each record a field is read from.
    let level = [walkTokens(tokens.slice(0, from), runState)];
    for (let i = from; i < tokens.length && level.length; i++) {
        const t = tokens[i];
        const next = [];
        for (const raw of level) {
            const cur = asValue(raw);
            if (t.type === 'wild') {
                if (Array.isArray(cur)) next.push(...cur.slice(0, HIDDEN_SCAN));
                continue;
            }
            if (t.type === 'prop' && typeof t.key === 'string') {
                const nameKey = secretEntryNameKey(cur);
                if (nameKey && t.key !== nameKey) return true;
            }
            let v = t.type === 'match' ? stepMatch(cur, t.key, t.value) : stepInto(cur, t.key);
            if (v === undefined && t.alt !== undefined) v = stepInto(cur, t.alt);
            if (v !== undefined) next.push(v);
        }
        level = next.slice(0, HIDDEN_SCAN);
    }
    return false;
}

/**
 * Resolve a path the model wrote: `{ path, value, source }` with the path in
 * canonical spelling (the source root kept as the editor spelled it), or
 * `{ reason }`. Two repairs, both only when they land on exactly one answer:
 *   - a path written RELATIVE to a source (`value[0].subject`) gets its root;
 *   - a path through an element of a list the step runs over becomes the
 *     loop's current element (currentElement), not always the first.
 * A path that reads a hidden field is refused after both (readsHidden).
 */
function resolvePathText(text, ctx) {
    const raw = String(text || '').trim().replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
    if (!raw) return { reason: 'is empty' };
    let tokens = parsePath(raw);
    let source = tokens ? ctx.sources.find((s) => startsWith(tokens, s.rootTokens)) : null;
    if (!source) {
        if (tokens && ROOT_WORDS.has(tokens[0].key)) return { reason: 'does not start at one of the steps above' };
        // Relative to a source (`value[0].subject`, `[0].id`, `$.a`)? Exactly
        // one source must hold it, or it is a guess.
        const bare = raw.replace(/^\$(?=[.[]|$)\.?/, '');
        const rel = bare ? parsePath(`$${bare.startsWith('[') ? '' : '.'}${bare}`) : null;
        if (!rel) return { reason: 'is not a field path' };
        const hits = [];
        for (const s of ctx.sources) {
            const candidate = [...s.rootTokens, ...rel.slice(1)];
            if (walkTokens(candidate, ctx.runState) !== undefined) hits.push({ s, candidate });
        }
        if (hits.length !== 1) return { reason: hits.length ? 'could be in more than one step above' : 'is not in the data of the steps above' };
        source = hits[0].s;
        tokens = hits[0].candidate;
    }
    ({ source, tokens } = currentElement(source, tokens, ctx));
    if (readsHidden(tokens, source.rootTokens.length, ctx.runState)) return { reason: 'is hidden (a password, token or key)' };
    const value = walkTokens(tokens, ctx.runState);
    const path = appendTokens(source.root, tokens.slice(source.rootTokens.length));
    if (value === undefined) return { reason: `is not in the data of "${source.label || source.root}"` };
    return { path, value, source };
}

/** Tokens of a plain path node of the expression AST, or null when computed. */
function astPathTokens(node) {
    if (!node || node.kind !== 'path') return null;
    const out = [];
    for (const s of node.segments) {
        if (s.kind === 'name') out.push({ type: 'prop', key: s.v });
        else if (s.kind === 'wildcard') out.push({ type: 'wild' });
        else if (s.kind === 'match') out.push({ type: 'match', key: s.key, value: s.value });
        else if (s.kind === 'index' && s.expr?.kind === 'num' && Number.isInteger(s.expr.v)) out.push({ type: 'prop', key: s.expr.v });
        else if (s.kind === 'index' && s.expr?.kind === 'unop' && s.expr.op === '-' && s.expr.a?.kind === 'num') out.push({ type: 'prop', key: -s.expr.a.v });
        else if (s.kind === 'index' && s.expr?.kind === 'str') out.push({ type: 'prop', key: s.expr.v });
        else return null;
    }
    return out;
}

/** Engine string literal body (valueParts.escapeExprString). */
const escapeExprString = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');

function verifyRef(text, ctx) {
    const r = resolvePathText(text, ctx);
    if (r.reason) return { reason: `the field ${r.reason}` };
    return { binding: { kind: 'ref', path: r.path }, value: r.value };
}

function verifyTemplate(text, ctx) {
    // Edge whitespace is a model's habit, never the author's intent.
    const src = String(text || '').trim();
    if (src.length > MAX_TEMPLATE_CHARS) return { reason: 'the text is too long' };
    const parts = scanTemplate(src);
    const refs = parts.filter((p) => p.type === 'ref');
    if (!refs.length) return { reason: 'the text holds no field — a fixed text is not a mapping' };
    // One placeholder and nothing around it is a field (or a formula).
    if (parts.length === 1) {
        return parsePath(refs[0].inner) ? verifyRef(refs[0].inner, ctx) : verifyExpr(refs[0].inner, ctx);
    }
    let out = '';
    for (const p of parts) {
        if (p.type === 'text') {
            if (/\{\{|\}\}/.test(p.value)) return { reason: 'the text has stray {{ }}' };
            out += p.value;
            continue;
        }
        if (!parsePath(p.inner)) return { reason: `{{${p.inner.slice(0, 60)}}} is a formula inside text, which cannot be shown as a field pill` };
        const r = resolvePathText(p.inner, ctx);
        if (r.reason) return { reason: `{{${p.inner.slice(0, 60)}}} ${r.reason}` };
        const kind = valueKind(r.value);
        if (kind === 'group' || kind === 'table') return { reason: `{{${p.inner.slice(0, 60)}}} would put ${KIND_WORDS[kind]} into the text` };
        out += `{{${r.path}}}`;
    }
    return { binding: { kind: 'template', value: out }, value: interpolateTemplate(out, ctx.runState) };
}

/** Flatten `a + " " + b` / concat(a, " ", b) into its operands, or null. */
function concatOperands(node) {
    if (node?.kind === 'binop' && node.op === '+') {
        const a = concatOperands(node.a);
        const b = concatOperands(node.b);
        return a && b ? [...a, ...b] : null;
    }
    if (node?.kind === 'call' && node.name === 'concat') {
        const all = node.args.map(concatOperands);
        return all.every(Boolean) ? all.flat() : null;
    }
    if (node?.kind === 'str' || node?.kind === 'path') return [node];
    return null;
}

function verifyExpr(text, ctx) {
    const src = String(text || '').trim().replace(/^=\s*/, '');
    if (!src) return { reason: 'the formula is empty' };
    if (src.length > MAX_EXPR_CHARS) return { reason: 'the formula is too long' };
    let ast;
    try { ast = parseExpr(src); } catch (e) { return { reason: `the formula does not compile (${String(e.message).slice(0, 80)})` }; }

    // A plain path written as a formula is a field: a ref, one pill.
    const plain = astPathTokens(ast);
    if (plain) return verifyRef(appendTokens('', plain), ctx);

    if (ast.kind === 'call' && Object.prototype.hasOwnProperty.call(PILL_TRANSFORMS, ast.name)) {
        const spec = PILL_TRANSFORMS[ast.name];
        const [first, ...rest] = ast.args;
        const tokens = astPathTokens(first);
        if (!tokens) return { reason: `${ast.name}() of anything but one field cannot be shown as pills` };
        if (rest.length < spec.args[0] || rest.length > spec.args[1] || !rest.every((a) => a.kind === 'str')) {
            return { reason: `${ast.name}() with these arguments cannot be shown as pills` };
        }
        const args = rest.map((a) => a.v);
        if (spec.check && !args.every(spec.check)) return { reason: `${ast.name}() with these arguments cannot be shown as pills` };
        const r = resolvePathText(appendTokens('', tokens), ctx);
        if (r.reason) return { reason: `the field ${r.reason}` };
        if (!pillPathInCall(r.path)) return { reason: 'the field cannot be shown as a pill inside a transform' };
        const rebuilt = `${ast.name}(${r.path}${args.map((a) => `, "${escapeExprString(a)}"`).join('')})`;
        let value;
        try { value = evaluate(rebuilt, ctx.runState); } catch (e) { return { reason: `the formula fails on the sample data (${String(e.message).slice(0, 80)})` }; }
        if (value === undefined) return { reason: 'the formula gives no value on the sample data' };
        if (NOOP_WHEN_EQUAL.has(ast.name) && value === r.value) return { binding: { kind: 'ref', path: r.path }, value: r.value };
        return { binding: { kind: 'expr', value: rebuilt }, value };
    }

    // Text glued with `+` or concat(): the same text as a template, when the
    // template gives exactly what the formula gives on the sample.
    const ops = concatOperands(ast);
    if (ops && ops.some((o) => o.kind === 'path') && ops.some((o) => o.kind === 'str')) {
        if (ops.some((o) => o.kind === 'str' && /\{\{|\}\}/.test(o.v))) return { reason: 'would show as a raw formula, not as field pills' };
        const tpl = ops.map((o) => (o.kind === 'str' ? o.v : `{{${appendTokens('', astPathTokens(o) || [])}}}`)).join('');
        const t = verifyTemplate(tpl, ctx);
        if (t.binding) {
            let direct;
            try { direct = evaluate(src, ctx.runState); } catch { direct = undefined; }
            if (typeof direct === 'string' && direct === t.value) return t;
        }
        return { reason: 'would show as a raw formula, not as field pills' };
    }
    return { reason: 'would show as a raw formula, not as field pills' };
}

/** What kind of binding the model meant, from what it filled in. */
function readProposal(raw) {
    const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    const value = typeof raw.value === 'string' ? raw.value : '';
    const text = kind === 'ref' ? (path || value.trim()) : (value || path);
    // `{{ }}` only ever means text with fields, whatever kind was claimed;
    // verifyTemplate turns a lone placeholder back into a ref.
    if (/\{\{/.test(text)) return { kind: 'template', text };
    if (kind === 'ref' || kind === 'template' || kind === 'expr') return { kind, text };
    return { kind: parsePath(text.trim()) ? 'ref' : 'expr', text };
}

/** A short preview of a verified value, for the editor (its own data). */
function previewOf(v) {
    let s;
    try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
    s = String(s ?? '');
    return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s;
}

/**
 * The model's proposals, reduced to the ones that are real and render as
 * pills. Pure (tests). Returns { suggestions: [{ key, binding, reason,
 * sampleValue }], rejected: [{ key, reason }] }.
 */
function verifySuggestions(rawBindings, { params, sources }) {
    const ctx = { sources, runState: buildRunState(sources), json: new WeakMap(), loopMatch: new Map() };
    const byKey = new Map(params.map((p) => [p.key, p]));
    const suggestions = [];
    const rejected = [];
    const done = new Set();
    for (const raw of (Array.isArray(rawBindings) ? rawBindings : [])) {
        if (!isPlainObject(raw)) continue;
        const key = typeof raw.key === 'string' ? raw.key.trim() : '';
        if (!key || done.has(key)) continue;
        const param = byKey.get(key);
        if (!param) { rejected.push({ key: key.slice(0, 200), reason: 'is not one of the inputs to fill' }); continue; }
        done.add(key);
        const { kind, text } = readProposal(raw);
        if (!text) { rejected.push({ key, reason: 'the answer was empty' }); continue; }
        let r;
        if (kind === 'ref') r = verifyRef(text, ctx);
        else if (kind === 'template') r = verifyTemplate(text, ctx);
        else r = verifyExpr(text, ctx);
        if (r.reason) { rejected.push({ key, reason: r.reason }); continue; }

        const expected = expectedKind(param);
        if (r.binding.kind === 'template' && !['text', 'email', 'date', 'choice', 'unknown'].includes(expected)) {
            rejected.push({ key, reason: `gives text, the input takes ${KIND_WORDS[expected]}` });
            continue;
        }
        const fit = judgeFit(expected, r.value, param);
        if (!fit.ok) { rejected.push({ key, reason: `the value ${fit.reason}` }); continue; }
        if (fit.wrap) {
            // One transform makes it fit — only on a bare field, so it stays
            // one pill and one chip.
            if (r.binding.kind !== 'ref') { rejected.push({ key, reason: `the value is ${KIND_WORDS[valueKind(r.value)]}, the input takes ${KIND_WORDS[expected]}` }); continue; }
            const wrapped = verifyExpr(fit.wrap === 'join' ? `join(${r.binding.path}, ", ")` : `number(${r.binding.path})`, ctx);
            if (wrapped.reason) { rejected.push({ key, reason: wrapped.reason }); continue; }
            r = wrapped;
        }
        const reason = typeof raw.reason === 'string' ? raw.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS) : '';
        suggestions.push({ key, binding: r.binding, reason, sampleValue: previewOf(r.value) });
    }
    return { suggestions, rejected };
}

module.exports = {
    verifySuggestions,
    expectedKind,
    valueKind,
    judgeFit,
    isPlainObject,
    isScalar,
    secretEntryNameKey,
    KIND_WORDS,
    PLACEHOLDER_RE,
    PILL_TRANSFORMS,
    SECRET_KEY_RE,
    PAIR_NAME_KEYS,
    PAIR_VALUE_KEYS,
};
