/**
 * The output schema of a schemaless AI step, read off how later steps use it.
 *
 * An ai_step without an outputSchema answers free text, and every
 * `steps.<id>.output.<field>` read of it resolves to nothing. The runner
 * therefore asks the model for the fields later steps read. It used to keep
 * only the first name after `.output.` and type every field "string": a step
 * read as `customer.contacts[0].email`, looped over as `line_items` and picked
 * as `["Story Points"]` asked for `{"line_items":"string","customer":"string"}`,
 * and a model that obeyed broke both the loop and the nested read, while the
 * bracket read was not seen at all.
 *
 * Here every consumer path is read with the shared grammar (shared/expr
 * path.mjs for paths and templates, the expression parser for formulas) and
 * turned into a JSON Schema that follows it:
 *   - `.key` / `["key"]` after a field makes it a record with that key;
 *   - `[0]`, `[-1]`, `[*]` or `[key="v"]` after it makes it a list;
 *   - a field a step loops over (forEach / loop overRef, arrayRef, the first
 *     argument of join(), first(), …) is a list, and what the loop body reads
 *     off its item (`loop.<item>.x`) describes the list's items;
 *   - count() measures text and records too, so it makes a field a list only
 *     when nothing else reads that field whole or as a record;
 *   - anything read whole stays text ("string"), as before.
 * A per-item AI step (forEach) is read through its envelope:
 * `results[*].output.<x>` and the fan-out's `loop.<e>.output.<x>` both mean
 * field `<x>` of one answer. That holds wherever the step sits, also in a
 * loop body or a parallel branch (the runner hands nested steps the ROOT
 * definition).
 *
 * Only real reads count: bindings, `{{ }}` placeholders, reference paths and
 * formulas in the fields the runner resolves. A canvas note, a code step's
 * source, extraction instructions, a verbatim system prompt and parse_json's
 * relative paths are read by nothing (portability.js leaves them alone for
 * the same reason); a `steps.<id>.output.x` mentioned there must not turn a
 * free-text answer into JSON. Bare paths in prose are only taken from the
 * fields the runner always scanned that way (prompt, title, body, message,
 * url, headers, and the reference/formula fields).
 *
 * Pure: no I/O, no runner state. The validator can use the same function so
 * its warning shows the schema the run will really ask for.
 */
'use strict';

const { parsePath, readPath, scanTemplate, parseExpr, formatPath } = require('../../automation/expr');

// Keys whose path names a LIST the step iterates or splits.
const LIST_KEYS = new Set(['overRef', 'arrayRef']);
// Keys that hold a reference PATH (walkPath at run time) and keys that hold an
// EXPRESSION (the engine at run time). The difference matters for a name
// with a hyphen: as a path `steps.a.output.count-1` reads a field "count-1",
// in a condition it reads `count`, minus one.
const PATH_KEYS = new Set(['overRef', 'arrayRef', 'sourceRef', 'itemsRef']);
const EXPR_KEYS = new Set(['expr', 'condition']);
// Never consumer positions on a step: identity, presentation, DATA the author
// stored on the step (a pinned output is a sample, not a read) and a code
// step's source (JavaScript reads its `inputs`, never `steps`). Only a STEP's
// own keys: an input called `id` or `description` is a read like any other.
const SKIP_KEYS = new Set([
    'id', 'type', 'label', 'description', 'notes', 'outputSchema', 'position', 'layerKey', 'code',
    'pinnedOutput', 'pinnedAt', 'pinnedSource',
]);
// Per step type: text nothing resolves at run time (as portability.js
// VERBATIM_FIELDS). Instructions and a system prompt go to the model as
// written; parse_json's `fields` and `itemsRef` are paths RELATIVE to the
// parsed value, where `steps` would be a key of that value.
const NEVER_READ = {
    data_extraction: new Set(['instructions']),
    parse_json: new Set(['fields', 'itemsRef']),
    ai_step: new Set(['systemPrompt']),
};
// The step fields whose prose was always scanned for bare `steps.…` paths
// (no braces): the template texts and the reference/formula fields. Anywhere
// else a string counts only as a whole path, a placeholder or a formula.
const LOOSE_KEYS = new Set(['prompt', 'title', 'body', 'message', 'url', 'headers', 'input', 'input2', ...PATH_KEYS, ...EXPR_KEYS]);
// Functions whose first argument is a list. count() is not one of them: it
// also measures text and records (see scanAst).
const LIST_FUNCTIONS = new Set(['sum', 'avg', 'join', 'first', 'last', 'includes', 'at', 'index_of', 'pluck', 'find', 'asTable']);
const BINDING_KINDS = new Set(['literal', 'ref', 'template', 'expr']);

const isIndexKey = (k) => typeof k === 'number' || /^-?[0-9]+$/.test(String(k));

/** Tokens of an expression AST path node, in path.mjs's token shape. */
function astPathTokens(node, visitExpr) {
    const out = [];
    for (const s of node.segments || []) {
        if (s.kind === 'name') out.push({ type: 'prop', key: s.v });
        else if (s.kind === 'wildcard') out.push({ type: 'wild' });
        else if (s.kind === 'match') out.push({ type: 'match', key: s.key, value: s.value });
        else if (s.kind === 'index') {
            const e = s.expr || {};
            if (e.kind === 'str') out.push({ type: 'prop', key: e.v });
            else if (e.kind === 'num') out.push({ type: 'prop', key: e.v });
            else if (e.kind === 'unop' && e.op === '-' && e.a && e.a.kind === 'num') out.push({ type: 'prop', key: -e.a.v });
            else {
                // A computed index reads the run itself, and indexes a list.
                visitExpr(e, false);
                out.push({ type: 'prop', key: 0 });
            }
        } else if (s.kind === 'root') return null;
    }
    return out;
}

/** An expression's paths; false when the text is not an expression. */
function scanExpr(text, report) {
    let ast = null;
    try { ast = parseExpr(text); } catch { return false; }
    scanAst(ast, report, false);
    return true;
}

/**
 * Every path a value reads, handed to `report(tokens, list)`.
 * `as`: 'path' (a reference), 'expr' (a formula) or 'text' (unknown: a
 * template, a bare reference, a formula or prose). `listHint`: the string
 * sits where a list is expected. `loose`: bare paths inside prose count too
 * (only in LOOSE_KEYS).
 */
function scanText(text, report, listHint, as = 'text', loose = false) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an alternation of two fixed literals, no repeats: linear
    if (typeof text !== 'string' || !/steps|loop/.test(text)) return;
    if (as === 'expr' && scanExpr(text, report)) return;
    const whole = as === 'expr' ? null : parsePath(text);
    if (whole) { report(whole, listHint); return; }
    const parts = scanTemplate(text);
    const refs = parts.filter(p => p.type === 'ref');
    if (refs.length) {
        for (const r of refs) {
            const t = parsePath(r.inner);
            if (t) report(t, false);
        }
        if (loose) scanLoose(parts.filter(p => p.type === 'text').map(p => p.value).join(' '), report);
        return;
    }
    if ((as === 'expr' || !scanExpr(text, report)) && loose) scanLoose(text, report);
}

/** Bare `steps.…` / `loop.…` paths inside prose (no braces). */
function scanLoose(text, report) {
    const re = /(steps|loop)(?=[.[])/g;
    let m;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- two fixed literals and a one-character lookahead, no repeats: linear
    while ((m = re.exec(text)) !== null) {
        const before = m.index > 0 ? text[m.index - 1] : '';
        if (before && /[\p{L}\p{N}_$@.\]-]/u.test(before)) continue;
        const r = readPath(text, m.index);
        if (r && r.tokens.length > 1) {
            report(r.tokens, false);
            re.lastIndex = Math.max(re.lastIndex, r.end);
        }
    }
}

function scanAst(node, report, listCtx) {
    if (!node || typeof node !== 'object') return;
    const visit = (n, l) => scanAst(n, report, l);
    if (node.kind === 'path') {
        const tokens = astPathTokens(node, visit);
        if (tokens) report(tokens, listCtx);
        return;
    }
    if (node.kind === 'call' || node.kind === 'hostcall') {
        // count() of a field: a list, unless the field is also read whole or
        // as a record (count('abc') is 3) — a WEAK hint, settled in toSchema.
        const hint = (name) => (name === 'count' ? 'weak' : LIST_FUNCTIONS.has(name));
        (node.args || []).forEach((a, i) => visit(a, i === 0 && hint(node.name)));
        return;
    }
    for (const k of ['cond', 'a', 'b', 'expr']) if (node[k]) visit(node[k], false);
}

/** The step with id `stepId`, wherever it sits: top level, a loop body or a parallel branch. */
function findStep(steps, stepId) {
    for (const s of (Array.isArray(steps) ? steps : [])) {
        if (!s || typeof s !== 'object') continue;
        if (s.id === stepId) return s;
        const inBody = Array.isArray(s.body) ? findStep(s.body, stepId) : null;
        if (inBody) return inBody;
        if (Array.isArray(s.branches)) {
            for (const b of s.branches) {
                const found = findStep(Array.isArray(b) ? b : (Array.isArray(b?.steps) ? b.steps : []), stepId);
                if (found) return found;
            }
        }
    }
    return null;
}

/**
 * Every read of step `stepId`'s output anywhere in the definition, as
 * `{ path, tokens, list }` relative to the step's OUTPUT, as written: for a
 * per-item step that includes its envelope (`results[*].output.<x>`), so the
 * validator can tell an envelope read from a field read straight off the
 * step (validate/stepRules/stepContext.js). `list` marks a read that needs a
 * list there (`'weak'`: only count() says so). answerReads unwraps the
 * envelope for the schema.
 */
function collectAiStepOutputReads(definition, stepId) {
    const reads = [];
    if (!definition || !stepId) return reads;

    /** `steps.<stepId>.output…` → the tokens after `output`, else null. */
    const relative = (tokens) => {
        if (!tokens || tokens.length < 3) return null;
        const [a, b, c] = tokens;
        if (a.type !== 'prop' || a.key !== 'steps' || b.type !== 'prop' || String(b.key) !== String(stepId)) return null;
        if (c.type !== 'prop' || c.key !== 'output') return null;
        return tokens.slice(3);
    };

    const makeReporter = (env) => (tokens, list) => {
        let abs = tokens;
        if (tokens[0] && tokens[0].key === 'loop' && tokens[1] && tokens[1].type === 'prop' && env.has(String(tokens[1].key))) {
            abs = [...env.get(String(tokens[1].key)), ...tokens.slice(2)];
        }
        const rel = relative(abs);
        if (rel && rel.length) reads.push({ tokens: rel, list: list === 'weak' ? 'weak' : !!list });
    };

    /** The env for a step that iterates `overRef` as `itemVar`, after reporting the list. */
    const iterate = (env, overRef, itemVar) => {
        const t = typeof overRef === 'string' ? parsePath(overRef) : null;
        if (!t) return env;
        const report = makeReporter(env);
        const listTokens = t[t.length - 1].type === 'wild' ? t.slice(0, -1) : t;
        report(listTokens, true);
        const resolved = (listTokens[0] && listTokens[0].key === 'loop' && listTokens[1] && env.has(String(listTokens[1].key)))
            ? [...env.get(String(listTokens[1].key)), ...listTokens.slice(2)]
            : listTokens;
        const next = new Map(env);
        next.set(String(itemVar || 'item'), [...resolved, { type: 'wild' }]);
        return next;
    };

    // `loose`: the step field this value sits under scans prose (LOOSE_KEYS);
    // nested values (a header's value) inherit it.
    const walkValue = (value, key, env, loose) => {
        if (value == null) return;
        if (typeof value === 'string') {
            const as = PATH_KEYS.has(key) ? 'path' : (EXPR_KEYS.has(key) ? 'expr' : 'text');
            scanText(value, makeReporter(env), LIST_KEYS.has(key), as, loose);
            return;
        }
        if (Array.isArray(value)) { value.forEach(v => walkValue(v, key, env, loose)); return; }
        if (typeof value !== 'object') return;
        if (typeof value.kind === 'string' && BINDING_KINDS.has(value.kind)) {
            const report = makeReporter(env);
            if (value.kind === 'ref' && typeof value.path === 'string') {
                const t = parsePath(value.path);
                if (t) report(t, false);
            } else if (value.kind === 'template' && typeof value.value === 'string') {
                scanText(value.value, report, false);
            } else if (value.kind === 'expr' && typeof value.value === 'string') {
                scanText(value.value, report, false, 'expr');
            }
            return;
        }
        for (const [k, v] of Object.entries(value)) walkValue(v, k, env, loose);
    };

    const scanStep = (step, env) => {
        if (!step || typeof step !== 'object' || step.id === stepId) return;
        // A canvas annotation: text for people, read by nothing.
        if (step.type === 'note') return;
        const neverRead = NEVER_READ[step.type];
        let own = env;
        if (step.forEach && typeof step.forEach === 'object') {
            own = iterate(env, step.forEach.overRef, step.forEach.itemVar);
        }
        const isLoop = step.type === 'loop';
        const bodyEnv = isLoop ? iterate(own, step.overRef, step.itemVar) : own;
        for (const [k, v] of Object.entries(step)) {
            if (SKIP_KEYS.has(k) || k === 'forEach' || (neverRead && neverRead.has(k))) continue;
            if (isLoop && k === 'overRef') continue;
            if (k === 'body' && Array.isArray(v)) { v.forEach(s => scanStep(s, bodyEnv)); continue; }
            if (k === 'branches' && Array.isArray(v)) {
                for (const b of v) (Array.isArray(b) ? b : (Array.isArray(b?.steps) ? b.steps : [])).forEach(s => scanStep(s, own));
                continue;
            }
            walkValue(v, k, own, LOOSE_KEYS.has(k));
        }
    };

    for (const s of (definition.steps || [])) scanStep(s, new Map());
    return reads.map(r => ({ path: formatPath(r.tokens), tokens: r.tokens, list: r.list }));
}

/**
 * The reads relative to ONE answer of the step: its output, or for a
 * per-item step (forEach, wherever it sits) one item's output, read through
 * the envelope: `results[*].output.<x>` (or `results[0]` / `results[k="v"]`)
 * is `<x>`. A field read straight off a per-item step is no answer's field
 * (the validator reports it).
 */
function answerReads(definition, stepId) {
    const reads = collectAiStepOutputReads(definition, stepId);
    const self = definition ? findStep(definition.steps, stepId) : null;
    if (!(self && self.forEach && self.forEach.overRef)) return reads;
    const out = [];
    for (const r of reads) {
        const [res, el, o] = r.tokens;
        if (!res || res.type !== 'prop' || res.key !== 'results' || !el || !o) continue;
        const anyElement = el.type === 'wild' || el.type === 'match' || (el.type === 'prop' && isIndexKey(el.key));
        if (!anyElement || o.type !== 'prop' || o.key !== 'output') continue;
        const tokens = r.tokens.slice(3);
        if (tokens.length) out.push({ path: formatPath(tokens), tokens, list: r.list });
    }
    return out;
}

// `list`: a read needs a list here; `weakList`: only count() says so;
// `whole`: some read takes the field itself (a placeholder, a reference).
const newNode = () => ({ props: new Map(), items: null, list: false, weakList: false, whole: false });

function addRead(root, tokens, list) {
    const first = tokens[0];
    // The answer itself is a record: a read that starts with an index has
    // no field to describe.
    if (!first || first.type !== 'prop' || isIndexKey(first.key)) return;
    let cur = root;
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.type === 'prop' && !isIndexKey(tok.key)) {
            const key = String(tok.key);
            // `.length` of a field measures it; it is not a field of it.
            if (key === 'length' && i > 0 && i === tokens.length - 1) return;
            if (!cur.props.has(key)) cur.props.set(key, newNode());
            cur = cur.props.get(key);
            continue;
        }
        cur.list = true;
        if (!cur.items) cur.items = newNode();
        cur = cur.items;
        if (tok.type === 'match' && !cur.props.has(String(tok.key))) cur.props.set(String(tok.key), newNode());
    }
    if (list === 'weak') cur.weakList = true;
    else if (list) cur.list = true;
    else cur.whole = true;
}

function toSchema(n) {
    if (n.list || n.items || (n.weakList && !n.whole && !n.props.size)) {
        const s = { type: 'array' };
        if (n.items) s.items = toSchema(n.items);
        // A field looped over AND read straight off (`people.name`): the
        // fields belong to its items, not to the list.
        else if (n.props.size) s.items = toSchema({ ...newNode(), props: n.props });
        return s;
    }
    if (n.props.size) {
        const properties = {};
        for (const [k, child] of n.props) properties[k] = toSchema(child);
        return { type: 'object', properties };
    }
    return { type: 'string' };
}

/**
 * The schema to ask a schemaless AI step for.
 *
 * @returns {{ schema: object|null, fields: string[], textField: string|null }}
 *   `schema` a JSON Schema object (null when nothing reads a field),
 *   `fields` the top-level field names in first-seen order, `textField` the
 *   first of them that is text: where a prose answer is wrapped.
 */
function inferAiStepOutputSchema(definition, stepId) {
    const root = newNode();
    for (const r of answerReads(definition, stepId)) addRead(root, r.tokens, r.list);
    if (!root.props.size) return { schema: null, fields: [], textField: null };
    const schema = toSchema(root);
    const fields = [...root.props.keys()];
    const textField = fields.find(f => schema.properties[f].type === 'string') || null;
    return { schema, fields, textField };
}

module.exports = { collectAiStepOutputReads, inferAiStepOutputSchema };
