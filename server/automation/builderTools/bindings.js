/**
 * Builder tools — binding canonicalization and repair. Coerces the AI's
 * input bindings into canonical form, self-repairs the common ref-path
 * mistakes against the draft's trigger fields, and validates the optional
 * per-step `forEach` spec. Required from within automation/builderTools/
 * and re-exported (for tests) via the ../builderTools facade.
 */

const { triggerFieldsFor } = require('./triggerCatalog');
const { formatPath, readPath, scanTemplate } = require('../expr');
const { normalizeAiPath, hasPlaceholder } = require('./aiPaths');
const { checkRefTokens, describeProblem } = require('./refCheck');

/**
 * Coerce a step's inputs into canonical binding form.
 *
 * Tolerates the AI's common mistakes:
 *   - raw strings/numbers/booleans/arrays passed where a binding wrapper
 *     was expected → wrapped as { kind: 'literal', value: ... }
 *   - strings that look like template paths "{{...}}" → upgraded to template
 *   - already-canonical bindings → passed through unchanged
 *
 * Lossless: anything already valid keeps its shape. Anything ambiguous
 * defaults to literal so the runtime won't crash on bad refs.
 */
function canonicalizeInputs(inputs) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return {};
    const out = {};
    for (const [k, v] of Object.entries(inputs)) {
        out[k] = canonicalizeBinding(v);
    }
    return out;
}

// A ref path as the AI wrote it → the path the run reads (aiPaths.js). A
// path the run can read keeps its meaning: `[0]`, `[*]`, `["Story Points"]`
// and `[name="Subject"]` survive, only the spelling becomes canonical. What
// the run cannot read is repaired in the smallest way — a leading `$` or
// dot, stray whitespace, `steps[x]`, a key with spaces — and JSON debris
// after the path (the Gemma-4-on-llama.cpp signature, findings F1
// 2026-09-17: a valid path followed by escape/punctuation the model cannot
// stop emitting) is trimmed after the LONGEST valid prefix.
//
// This used to turn every bracket into a dot and cut at the first character
// outside [A-Za-z0-9_.$] — `value[0].from` became `value.0.from`,
// `fields["Story Points"]` became `fields.Story`, `["price-with-tax"]` became
// `.price` (another field) — and builder_update_step ran it over the user's
// own untouched mappings (findings C1, 2026-10).
function _normalizeRefPath(path) {
    if (typeof path !== 'string') return path;
    return normalizeAiPath(path).path;
}

/**
 * Is this member itself a binding — canonical, or the kind-less `{path}` /
 * `{value}` shape a weaker model emits? Used to tell a map of BINDINGS from a
 * map of plain data, which decides whether the map is resolved member by
 * member or frozen whole as a literal.
 */
function _looksLikeBinding(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    if (typeof m.kind === 'string' && ['literal', 'ref', 'template', 'expr'].includes(m.kind)) return true;
    return typeof m.path === 'string';
}

function canonicalizeBinding(v) {
    // Already a binding wrapper with a recognised kind — normalise ref/template values then pass through.
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.kind === 'string'
        && ['literal', 'ref', 'template', 'expr'].includes(v.kind)) {
        if (v.kind === 'ref' && typeof v.path === 'string') {
            const normalised = _normalizeRefPath(v.path);
            if (normalised !== v.path) return { ...v, path: normalised };
        }
        return v;
    }
    // Wrapper with no kind but has a discriminating field — infer the kind.
    // Weaker models often emit { value: "..." } or { path: "..." } without
    // the kind tag; we recover those instead of silently flattening to literal.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (typeof v.path === 'string') {
            return { kind: 'ref', path: _normalizeRefPath(v.path) };
        }
        if ('value' in v && Object.keys(v).every(k => k === 'value' || k === 'kind')) {
            const val = v.value;
            if (hasPlaceholder(val)) {
                return { kind: 'template', value: val };
            }
            return { kind: 'literal', value: val };
        }
        // A MAP whose members are bindings — `nextcloud_tables_create_row`'s
        // `values: {"Datum": {kind:"ref", …}, …}` is the archetype. Wrapping
        // that as one literal froze the descriptors into the payload: the row
        // arrived at Nextcloud with `{"kind":"ref","path":"…"}` in every cell
        // (2026-09-12). Canonicalise member by member and hand back a BARE
        // object; the runtime's resolveValue() sends a wrapper-less object to
        // resolveDeep, which resolves each member against the run state.
        const entries = Object.entries(v);
        if (entries.length && entries.some(([, m]) => _looksLikeBinding(m))) {
            const out = {};
            for (const [k, m] of entries) out[k] = canonicalizeBinding(m);
            return out;
        }
        // Unrecognised object shape → wrap as literal so the runtime
        // doesn't see an opaque blob. The LLM gets a repair hint via
        // validateAndFixBindings so it learns the right shape.
    }
    // Same for a LIST of bindings, e.g. an input that takes several refs.
    if (Array.isArray(v) && v.some(_looksLikeBinding)) {
        return v.map(canonicalizeBinding);
    }
    // String containing {{...}} → template (quote-aware: `{{ x["a}b"] }}`).
    if (hasPlaceholder(v)) {
        return { kind: 'template', value: v };
    }
    // Anything else → literal. This is the safe, runtime-friendly choice.
    return { kind: 'literal', value: v };
}

// Was the raw value already in canonical binding shape? Used by
// validateAndFixBindings to decide which inputs need a "you sent a bare
// string, I wrapped it as literal" repair hint sent back to the LLM.
function _isCanonicalBinding(v) {
    return v && typeof v === 'object' && !Array.isArray(v)
        && typeof v.kind === 'string'
        && ['literal', 'ref', 'template', 'expr'].includes(v.kind);
}

const VALID_REF_ROOTS = new Set(['trigger', 'steps', 'vars', 'secrets', 'loop']);
const P = key => ({ type: 'prop', key });

/**
 * A path whose root is not one of VALID_REF_ROOTS, re-rooted when the head
 * is a field of this draft's trigger: `from` / `output.from` / `attachments[0]
 * .filename` → `trigger.output.…`. Returns the new tokens or null.
 */
function rerootTriggerField(tokens, triggerFields) {
    const head = String(tokens[0].key);
    if (triggerFields.has(head)) return [P('trigger'), P('output'), ...tokens];
    if (head === 'output' && tokens[1] && tokens[1].type === 'prop' && triggerFields.has(String(tokens[1].key))) {
        return [P('trigger'), ...tokens];
    }
    return null;
}

/**
 * Canonicalise a step's input bindings and check every ref and `{{…}}`
 * placeholder in them: the root, and — where the draft knows the shape of
 * what is read — the whole path (refCheck.js). Returns
 *   { inputs, error, repairs, notes, _suggestedPatch? }
 * `repairs` lists every server-side rewrite (the older wrapper repairs too);
 * `notes` is the part the model MUST read back on a success: each path that
 * was rewritten and each path a non-authoritative shape cannot find. A path
 * an authoritative shape cannot find is an `error`, with a "did you mean".
 *
 * opts: { draftWrap }    runtime shapes (dry run this turn, the tool cache)
 *       { wantList }     the binding must be a LIST (forEach.overRef,
 *                        arrayRef): a key on a list repairs to `[*]`, an
 *                        object with one list in it to that list
 *       { lenientRoots } a placeholder with an unknown root is a note, not
 *                        an error (free text: checkTextPlaceholders)
 *
 * `loop.<var>` paths are checked by checkLoopBindings once the step's
 * forEach is known.
 */
function validateAndFixBindings(rawInputs, draft, opts = {}) {
    const fixed = canonicalizeInputs(rawInputs || {});
    const triggerFields = new Set(triggerFieldsFor(draft));
    const errors = [];
    const repairs = [];
    const notes = [];
    const say = (line) => { repairs.push(line); notes.push(line); };

    // Repairs the normaliser made (canonicalizeInputs already applied them;
    // this pass only NAMES them — doctrine: nothing is coerced silently). The
    // tail-trim keeps its own sentence: the debris is the Gemma-4 signature
    // the model cannot help resending, and the clean path is what to teach.
    const named = [];
    const collectNamed = (label, node, depth) => {
        if (!node || typeof node !== 'object') return;
        if (_looksLikeBinding(node)) {
            if (typeof node.path === 'string' && (!node.kind || node.kind === 'ref')) {
                const n = normalizeAiPath(node.path);
                if (n.debris) named.push(`${label}: ref path "${n.path}${n.debris}" carried JSON debris after the real path — read as "${n.path}".`);
                else if (n.notes.length) named.push(`${label}: read "${node.path.trim()}" as "${n.path}" — ${n.notes.join('; ')}.`);
            }
            return;
        }
        if (depth >= 3) return;
        if (Array.isArray(node)) { node.forEach((m, i) => collectNamed(`${label}[${i}]`, m, depth + 1)); return; }
        for (const [key, m] of Object.entries(node)) collectNamed(`${label}.${key}`, m, depth + 1);
    };
    for (const [k, v] of Object.entries(rawInputs || {})) collectNamed(`inputs.${k}`, v, 0);
    for (const line of named) say(line);

    // Record auto-wrapping: if the caller passed a bare value (string, number,
    // boolean, plain {value:...}) for a key, canonicalizeBinding already wrapped
    // it as literal. Surface this to the LLM as a repair hint so the next call
    // uses the binding shape directly.
    for (const [k, raw] of Object.entries(rawInputs || {})) {
        if (!_isCanonicalBinding(raw)) {
            const cur = fixed[k];
            if (cur && cur.kind === 'literal') {
                repairs.push(`inputs.${k}: wrapped bare value as {kind:"literal", value:…}. Use the binding shape next time.`);
            } else if (cur && cur.kind === 'template') {
                repairs.push(`inputs.${k}: detected {{…}} placeholders in a bare string; wrapped as {kind:"template", value:…}.`);
            } else if (cur && cur.kind === 'ref') {
                repairs.push(`inputs.${k}: inferred ref shape from {path:…}; wrapped as {kind:"ref", path:…}.`);
            }
        }
    }

    // Walk the inputs as (label, binding) pairs, descending into the bare maps
    // and lists canonicalizeBinding now leaves unwrapped. Without this pass a
    // ref inside `values: {...}` was never checked — which is how a path with
    // quotes and braces in it ("loop.ai.output.totaal\"}}},label:") reached a
    // saved step and only failed at run time (2026-09-12).
    const pairs = [];
    const collect = (label, node, depth) => {
        if (!node || typeof node !== 'object') return;
        if (_isCanonicalBinding(node)) { pairs.push([label, node]); return; }
        if (depth >= 3) return;
        if (Array.isArray(node)) {
            node.forEach((m, i) => collect(`${label}[${i}]`, m, depth + 1));
            return;
        }
        for (const [key, m] of Object.entries(node)) collect(`${label}.${key}`, m, depth + 1);
    };
    for (const [k, v] of Object.entries(fixed)) collect(`inputs.${k}`, v, 0);

    const checkOpts = { draftWrap: opts.draftWrap, wantList: !!opts.wantList };
    const suggestedOps = [];
    for (const [label, v] of pairs) {
        // `k` is the label the messages below already used; nested bindings get
        // the full path ("inputs.values.Datum") so the model can find them.
        const k = label.replace(/^inputs\./, '');

        if (v.kind === 'ref' && typeof v.path === 'string') {
            let tokens = normalizeAiPath(v.path).tokens;
            if (!tokens) {
                errors.push(`inputs.${k}: ref path "${v.path}" is not a path. Write it as e.g. steps.<id>.output.<field>, trigger.output.<field> or loop.<itemVar>.<field>.`);
                continue;
            }
            if (!VALID_REF_ROOTS.has(String(tokens[0].key))) {
                const rerooted = rerootTriggerField(tokens, triggerFields);
                if (!rerooted) {
                    const root = String(tokens[0].key);
                    errors.push(
                        `inputs.${k}: ref path "${v.path}" has unknown root "${root}". `
                        + `Valid roots: trigger, steps, vars, secrets, loop. `
                        + (triggerFields.size
                            ? `For this trigger use trigger.output.<field>, e.g. trigger.output.${triggerFields.has(root) ? root : 'subject'}.`
                            : 'Use e.g. trigger.output.<field> or steps.<id>.output.<field>.')
                    );
                    continue;
                }
                const before = v.path;
                tokens = rerooted;
                v.path = formatPath(tokens);
                repairs.push(`inputs.${k}: prepended root → "${v.path}" (was "${before}"). Always start ref paths with trigger/steps/vars/secrets/loop.`);
            }
            const chk = checkRefTokens(draft, tokens, checkOpts);
            const checked = formatPath(chk.tokens);
            if (checked !== v.path) {
                const before = v.path;
                v.path = checked;
                say(`inputs.${k}: read "${before}" as "${v.path}"${chk.fixes.length ? ` — ${chk.fixes.join('; ')}` : ''}.`);
            }
            for (const a of chk.advice || []) notes.push(`inputs.${k}: ${a}.`);
            if (chk.problem) {
                const line = `inputs.${k}: ${describeProblem(chk.problem, v.path)}`;
                if (chk.problem.sure) {
                    errors.push(line);
                    // The one fix that keeps the meaning (the same key found
                    // in exactly one other place, refCheck.suggestionsFor) is
                    // carried machine-readably, so the build loop can apply
                    // it when the identical call comes back (README §2). A
                    // did-you-mean by spelling (`cc` → `id`) never is: the
                    // resend would bind another field without anyone choosing.
                    const only = chk.problem.patch || null;
                    if (only && /^[A-Za-z_$][\w$]*$/.test(k)) suggestedOps.push({ op: 'set', path: `inputs.${k}`, value: { ...v, path: only } });
                } else {
                    notes.push(`${line} (What is known of this shape is not complete — one observed run or the tool's description — so the binding was kept; fix it if it is wrong.)`);
                }
            }
            continue;
        }

        if (v.kind === 'template' && typeof v.value === 'string') {
            // Every {{…}} placeholder: re-rooted when a bare trigger field
            // (`{{ from }}` → `{{trigger.output.from}}`), canonicalised, and
            // checked like a ref. Quote-aware (scanTemplate): a `}` inside a
            // bracket-quoted key does not end the placeholder.
            const bad = [];
            const rewrites = [];
            const notPaths = [];
            const read = [];
            v.value = scanTemplate(v.value).map((part) => {
                if (part.type === 'text') return part.value;
                const n = normalizeAiPath(part.inner, { trimDebris: false });
                if (!n.tokens) {
                    const head = readPath(part.inner.replace(/^[.$]+/, '').trim(), 0);
                    if (head && VALID_REF_ROOTS.has(String(head.tokens[0].key))) notPaths.push(part.inner);
                    else bad.push(part.inner);
                    return part.raw;
                }
                let tokens = n.tokens;
                if (!VALID_REF_ROOTS.has(String(tokens[0].key))) {
                    const rerooted = rerootTriggerField(tokens, triggerFields);
                    if (!rerooted) { bad.push(part.inner); return part.raw; }
                    rewrites.push(part.inner);
                    tokens = rerooted;
                }
                const chk = checkRefTokens(draft, tokens, { draftWrap: opts.draftWrap });
                const fixes = [...n.notes, ...chk.fixes];
                const out = formatPath(chk.tokens);
                if (chk.fixes.length || n.notes.length) read.push(`{{${part.inner}}} as {{${out}}} — ${fixes.join('; ')}`);
                for (const a of chk.advice || []) notes.push(`inputs.${k}: ${a}.`);
                if (chk.problem) {
                    const line = `inputs.${k}: ${describeProblem(chk.problem, out)}`;
                    if (chk.problem.sure) errors.push(line);
                    else notes.push(line);
                }
                return `{{${out}}}`;
            }).join('');
            if (rewrites.length) {
                repairs.push(`inputs.${k}: template placeholders ${rewrites.map(s => `"${s}"`).join(', ')} prepended with trigger.output.`);
            }
            if (read.length) say(`inputs.${k}: read ${read.join('; ')}.`);
            if (notPaths.length) {
                notes.push(`inputs.${k}: ${notPaths.map(s => `{{${s}}}`).join(', ')} is not a path — a {{…}} placeholder reads ONE value by path and renders nothing for anything else. Use {kind:"expr", …} for a calculation.`);
            }
            if (bad.length) {
                const line = `inputs.${k}: template references ${bad.map(s => `"${s}"`).join(', ')} which has unknown root. `
                    + `Use {{trigger.output.<field>}} or {{steps.<id>.output.<field>}}.`;
                // A free-text field (a prompt) may hold braces for another
                // reason; there the unknown root is said, not refused.
                if (opts.lenientRoots) notes.push(`${line} It renders as nothing at run time.`);
                else errors.push(line);
            }
        }
    }

    return {
        inputs: fixed,
        error: errors.length ? errors.join(' ') : null,
        repairs: repairs.length ? repairs : undefined,
        notes: notes.length ? notes : undefined,
        // Only when the refusal has exactly one cause and one fix.
        ...(errors.length === 1 && suggestedOps.length === 1 ? { _suggestedPatch: { ops: suggestedOps } } : {}),
    };
}

/**
 * A step field that stores TEXT with `{{…}}` placeholders (an ai_step
 * prompt, a notification title/body, an http_request url/body) gets the
 * check a template input gets: placeholders canonicalised, bare trigger
 * fields re-rooted, deep paths checked and repaired. Returns
 * { text, notes, error } with the messages labelled `<label>: …`; text that
 * is not a string or holds no placeholder comes back untouched. An unknown
 * root is a note here, not a refusal: prose may hold braces for its own
 * reasons. A path an authoritative shape cannot find is still refused.
 */
function checkTextPlaceholders(text, graph, { draftWrap, label = 'text' } = {}) {
    if (!hasPlaceholder(text)) return { text, notes: [], error: null };
    const r = validateAndFixBindings({ [label]: { kind: 'template', value: text } }, graph, { draftWrap, lenientRoots: true });
    const relabel = l => (l.startsWith(`inputs.${label}`) ? l.slice('inputs.'.length) : l);
    return {
        text: r.inputs[label] && typeof r.inputs[label].value === 'string' ? r.inputs[label].value : text,
        notes: (r.notes || []).map(relabel),
        error: r.error ? r.error.split(`inputs.${label}`).join(label) : null,
    };
}

/**
 * Check every `loop.<itemVar>…` a step binds — refs and `{{…}}`
 * placeholders, in inputs, field maps and text — against what its forEach
 * iterates (outputFields.checkLoopRef: deep, token-based, the fan-out
 * envelope, the union of the list's entries). One obvious fix is applied and
 * named; a miss the item's shape is authoritative about is refused
 * (`refuse: false` makes it a warning); an unknown item stays silent.
 *
 * `value` is a binding map, one binding, or a text string. Returns
 * { value, notes, error } with `value` rebuilt only where something was
 * repaired. Labels: `${label}.<key>` for a map, `label` otherwise.
 */
function checkLoopBindings(value, graph, forEach, draftWrap, { label = 'inputs', refuse = true } = {}) {
    const notes = [];
    const errors = [];
    if (!forEach || typeof forEach.overRef !== 'string' || typeof forEach.itemVar !== 'string') {
        return { value, notes, error: null };
    }
    const { checkLoopRef } = require('./outputFields');
    const own = `loop.${forEach.itemVar}`;
    const checkPath = (where, path) => {
        if (typeof path !== 'string' || !path.trim().startsWith(own)) return path;
        const chk = checkLoopRef(graph, path, forEach, draftWrap);
        if (chk.ok && chk.path) { notes.push(`${where}: ${chk.note}`); return chk.path; }
        if (!chk.ok && chk.message) {
            const line = `${where}: ${chk.message}`;
            if (refuse && (chk.sure || chk.ambiguous)) errors.push(line);
            // A shape that is not complete (one observed run, a description)
            // cannot say the field is never there.
            else notes.push(`${line} ${chk.sure ? 'It would be empty at run time.' : 'It may be empty at run time — what is known of the item is not complete.'}`);
        }
        return path;
    };
    const checkText = (where, text) => scanTemplate(text).map(p => (p.type === 'text' ? p.value : (() => {
        const fixed = checkPath(where, p.inner);
        return fixed === p.inner ? p.raw : `{{${fixed}}}`;
    })())).join('');
    const visit = (where, node, depth) => {
        if (typeof node === 'string') return hasPlaceholder(node) ? checkText(where, node) : node;
        if (!node || typeof node !== 'object' || depth > 4) return node;
        if (Array.isArray(node)) return node.map((m, i) => visit(`${where}[${i}]`, m, depth + 1));
        if (node.kind === 'ref' && typeof node.path === 'string') {
            const p = checkPath(where, node.path);
            return p === node.path ? node : { ...node, path: p };
        }
        if (node.kind === 'template' && typeof node.value === 'string') {
            const t = checkText(where, node.value);
            return t === node.value ? node : { ...node, value: t };
        }
        if (node.kind === 'literal' || node.kind === 'expr') return node;
        const out = {};
        for (const [k, m] of Object.entries(node)) out[k] = visit(`${where}.${k}`, m, depth + 1);
        return out;
    };
    const isMap = value && typeof value === 'object' && !Array.isArray(value) && !_looksLikeBinding(value);
    const out = isMap
        ? Object.fromEntries(Object.entries(value).map(([k, m]) => [k, visit(`${label}.${k}`, m, 0)]))
        : visit(label, value, 0);
    return { value: out, notes, error: errors.length ? errors.join(' ') : null };
}

/**
 * The `arrayRef` of a list step (filter, limit, dedupe, aggregate, summarize,
 * a set in list mode): a ref to a LIST, canonicalised and checked like
 * forEach.overRef. Returns { arrayRef, notes, error }; a non-string comes
 * back untouched for the step's own validation to report. `strictRoot`
 * refuses an unknown root (the set step always did); elsewhere it is a note.
 */
function sanitizeArrayRef(raw, graph, { draftWrap, strictRoot = false } = {}) {
    if (typeof raw !== 'string' || !raw.trim()) return { arrayRef: raw, notes: [], error: null };
    const r = validateAndFixBindings({ arrayRef: { kind: 'ref', path: raw.trim() } }, graph, { draftWrap, wantList: true });
    const relabel = l => l.replace(/^inputs\.arrayRef/, 'arrayRef');
    if (r.error) {
        if (strictRoot || !/unknown root/.test(r.error)) return { arrayRef: raw, notes: [], error: relabel(r.error) };
        return { arrayRef: normalizeAiPath(raw).path, notes: [relabel(r.error)], error: null };
    }
    return { arrayRef: r.inputs.arrayRef.path, notes: (r.notes || []).map(relabel), error: null };
}

/**
 * Validate an optional per-step `forEach` spec. A leaf step (integration_action
 * / ai_step / code / notification / set) can run once per item of an upstream
 * array WITHOUT a wrapping `loop` container — the runner iterates the step and
 * its body refers to the current item as `loop.<itemVar>`. The `overRef` is
 * validated exactly like an input ref (root must be trigger/steps/vars/secrets/
 * loop) so it self-repairs and errors consistently with everything else.
 *
 * Returns `{ forEach }` (forEach === undefined when `raw` is absent) or `{ error }`.
 */
function sanitizeForEach(raw, graph, draftWrap) {
    if (raw === undefined || raw === null) return { forEach: undefined };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: 'forEach must be an object { overRef, itemVar, maxIterations? }, or omitted.' };
    }
    if (!raw.overRef || typeof raw.overRef !== 'string') {
        return { error: 'forEach requires `overRef` — a ref to an upstream array, e.g. "steps.<id>.output.results".' };
    }
    // A LIST is wanted here: `results.attachments` repairs to
    // `results[*].attachments` (every entry's), and an object with one list
    // in it to that list.
    const { inputs, error, notes } = validateAndFixBindings({ overRef: { kind: 'ref', path: raw.overRef } }, graph, { draftWrap, wantList: true });
    if (error) return { error: `forEach.overRef: ${error.replace(/inputs\.overRef: /g, '')}` };
    const itemVar = (typeof raw.itemVar === 'string' && raw.itemVar.trim()) ? raw.itemVar.trim() : 'item';
    const forEach = { overRef: inputs.overRef.path, itemVar };
    // Outer lists a step over a list inside a list keeps, when they are still
    // outer parts of the (repaired) overRef; anything else is dropped.
    const { usableParents } = require('../validate/stepRules/iterationRules');
    const parents = Array.isArray(raw.parents) ? usableParents({ ...forEach, parents: raw.parents }).map(p => ({ itemVar: p.itemVar, overRef: p.overRef })) : [];
    if (parents.length) forEach.parents = parents;
    if (raw.maxIterations !== undefined) {
        const n = Number(raw.maxIterations);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
            return { error: 'forEach.maxIterations must be an integer between 1 and 1000.' };
        }
        forEach.maxIterations = n;
    }
    return { forEach, ...(notes ? { notes: notes.map(l => l.replace(/^inputs\.overRef/, 'forEach.overRef')) } : {}) };
}

/**
 * Every `loop.<var>` a set of canonical bindings reads — ref paths and the
 * {{…}} placeholders inside templates — with the var name.
 */
const { LOOP_RUNTIME_KEYS } = require('../validate/constants');

function loopVarsReadBy(value, out = [], depth = 0) {
    if (depth > 12 || value === null || value === undefined) return out;
    if (Array.isArray(value)) { for (const v of value) loopVarsReadBy(v, out, depth + 1); return out; }
    if (typeof value === 'string') {
        const t = normalizeAiPath(value, { trimDebris: false }).tokens;
        if (t && t[0].key === 'loop' && t[1] && t[1].type === 'prop') out.push({ v: String(t[1].key), path: value.trim() });
        return out;
    }
    if (typeof value !== 'object') return out;
    if (value.kind === 'ref' && typeof value.path === 'string') return loopVarsReadBy(value.path, out, depth + 1);
    if (value.kind === 'template' && typeof value.value === 'string') {
        for (const p of scanTemplate(value.value)) if (p.type === 'ref') loopVarsReadBy(p.inner, out, depth + 1);
        return out;
    }
    if (value.kind === 'literal' || value.kind === 'expr') return out;
    for (const v of Object.values(value)) loopVarsReadBy(v, out, depth + 1);
    return out;
}

/**
 * A step that reads `loop.<var>` must be the step that iterates as <var>.
 * Measured 2026-09-12: a nextcloud_tables_create_row bound every column to
 * loop.e.output.<field> with NO forEach — the builder accepted it, the
 * validator passed it, and the automation finalised; at run time every cell
 * would have been empty. The var is only bound inside the step's own
 * forEach (the add tools build top-level steps — a loop body's steps are
 * built by builder_add_loop and never pass through here), so a mismatch is
 * refused where the model can still fix it in one call.
 */
function unboundLoopVarError(bindings, forEach, { what = 'inputs' } = {}) {
    const own = forEach && typeof forEach.itemVar === 'string' ? forEach.itemVar : null;
    // The item, and the outer items a step over a list inside a list keeps
    // (`forEach.parents`, bound per item by the runner's forEachScope.js):
    // the validator counts the same names (iterationRules.forEachBoundVars).
    const { forEachBoundVars } = require('../validate/stepRules/iterationRules');
    const bound = own ? forEachBoundVars(forEach) : [];
    // `loop._index` (and any other runner-injected key) is bound exactly
    // where the itemVar is: with a forEach it never mismatches; without one
    // it is as unbound as the item and stays in the list.
    const reads = loopVarsReadBy(bindings).filter(r => !(LOOP_RUNTIME_KEYS.has(r.v) && own));
    if (!reads.length) return null;
    const bad = reads.find(r => r.v !== own && !bound.includes(r.v));
    if (!bad) return null;
    if (!own) {
        // A runner-injected key is bound by ANY forEach — the advice names
        // an itemVar, not the key itself.
        const suggestVar = LOOP_RUNTIME_KEYS.has(bad.v) ? 'item' : bad.v;
        return {
            error: `${what} read "${bad.path}", but this step has no forEach, so loop.${bad.v} is not bound here and would be empty at run time. Either add forEach:{overRef:"steps.<id>.output.results", itemVar:"${suggestVar}"} to THIS step so it runs once per item, or bind to the upstream output directly (steps.<id>.output.…).`,
            _fixHint: 'Reject reason: loop.<var> is read by a step that does not iterate. Add the forEach to this step (or change the binding) and resend it — the other fields were fine.',
        };
    }
    // The rename is one exact edit only when every loop read names the same
    // var: with reads of both loop.<own> and loop.<bad>, setting itemVar to
    // <bad> would unbind the ones that were right — that case stays prose.
    // Measured 2026-09-12: told to make the names match, the fast local model
    // resent the same step; the build loop applies this patch on that resend.
    const vars = new Set(reads.map(r => r.v));
    return {
        error: `${what} read "${bad.path}", but this step iterates as loop.${own} (forEach.itemVar) — loop.${bad.v} is not bound here. Use loop.${own}… for the current item, or set itemVar:"${bad.v}".`,
        _fixHint: 'Reject reason: the loop var in a binding does not match this step\'s forEach.itemVar. Make them the same name and resend the step.',
        ...(vars.size === 1 ? { _suggestedPatch: { ops: [{ op: 'set', path: 'forEach.itemVar', value: bad.v }] } } : {}),
    };
}

module.exports = {
    validateAndFixBindings,
    canonicalizeBinding,
    checkTextPlaceholders,
    checkLoopBindings,
    sanitizeArrayRef,
    sanitizeForEach,
    loopVarsReadBy,
    unboundLoopVarError,
    LOOP_RUNTIME_KEYS,
};
