/**
 * Builder tools — binding canonicalization and repair. Coerces the AI's
 * input bindings into canonical form, self-repairs the common ref-path
 * mistakes against the draft's trigger fields, and validates the optional
 * per-step `forEach` spec. Required from within automation/builderTools/
 * and re-exported (for tests) via the ../builderTools facade.
 */

const { triggerFieldsFor } = require('./triggerCatalog');

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

// Normalise a ref path the way weaker models tend to mangle it:
//   $steps.x.output.y   → steps.x.output.y     (leading $ for "expression")
//   steps[x].output[y]  → steps.x.output.y     (bracket access)
//   .steps.x.output.y   → steps.x.output.y     (leading dot)
//   steps . x . output  → steps.x.output       (stray whitespace)
//   loop.x.output.a\"}}}},tempId: → loop.x.output.a   (JSON debris after the path)
//
// The last one is the tail-trim, and it runs LAST (brackets convert first, so
// nothing valid is over-trimmed; `$` stays legal for steps.$tempId refs). It is
// the Gemma-4-on-llama.cpp signature (measured 2026-09-17 — findings F1): a
// valid path followed by escape/punctuation debris the model literally cannot
// stop emitting, so it resent the same corruption until the ladder stopped the
// turn. `trimTail:false` exists so validateAndFixBindings can tell THIS repair
// apart from the older, deliberately silent ones and give it a _warnings note.
function _normalizeRefPath(path, { trimTail = true } = {}) {
    if (typeof path !== 'string') return path;
    const out = path
        .trim()
        .replace(/^\$+/, '')
        .replace(/\[\s*['"]?([^\]'"]+)['"]?\s*\]/g, '.$1')
        .replace(/^\.+/, '')
        .replace(/\s*\.\s*/g, '.')
        .replace(/\.{2,}/g, '.');
    return trimTail ? out.replace(/[^A-Za-z0-9_.$].*$/, '') : out;
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
            if (typeof val === 'string' && /\{\{[^}]+\}\}/.test(val)) {
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
    // String containing {{...}} → template.
    if (typeof v === 'string' && /\{\{[^}]+\}\}/.test(v)) {
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

// Trigger output fields the LLM commonly mis-roots — when a ref path is bare
// ("from", "subject", …) we can confidently prepend `trigger.output.` instead
// of bouncing the call back to the model. Keyed by `<provider>.<event>`.
function validateAndFixBindings(rawInputs, draft) {
    const fixed = canonicalizeInputs(rawInputs || {});
    const triggerFields = new Set(triggerFieldsFor(draft));
    const errors = [];
    const repairs = [];

    // The ONE ref-path repair worth a note is the tail-trim: the debris is
    // the Gemma-4 signature the model cannot help resending, and the clean
    // path is the thing to teach. The older transforms stay silent, as they
    // always were. canonicalizeInputs already applied the repair; this pass
    // only NAMES it (doctrine: nothing is coerced silently).
    const debris = [];
    const collectDebris = (label, node, depth) => {
        if (!node || typeof node !== 'object') return;
        if (_looksLikeBinding(node)) {
            if (typeof node.path === 'string') {
                const untrimmed = _normalizeRefPath(node.path, { trimTail: false });
                const clean = _normalizeRefPath(node.path);
                if (clean !== untrimmed) debris.push([label, untrimmed, clean]);
            }
            return;
        }
        if (depth >= 3) return;
        if (Array.isArray(node)) { node.forEach((m, i) => collectDebris(`${label}[${i}]`, m, depth + 1)); return; }
        for (const [key, m] of Object.entries(node)) collectDebris(`${label}.${key}`, m, depth + 1);
    };
    for (const [k, v] of Object.entries(rawInputs || {})) collectDebris(`inputs.${k}`, v, 0);
    for (const [label, raw, clean] of debris) {
        repairs.push(`${label}: ref path "${raw}" carried JSON debris after the real path — read as "${clean}".`);
    }

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

    for (const [label, v] of pairs) {
        // `k` is the label the messages below already used; nested bindings get
        // the full path ("inputs.values.Datum") so the model can find them.
        const k = label.replace(/^inputs\./, '');

        if (v.kind === 'ref' && typeof v.path === 'string') {
            const cleaned = v.path.replace(/^\.+/, '').trim();
            const root = cleaned.split('.')[0];
            // Handle "trigger.<field>" (skipping the .output. segment) BEFORE the
            // VALID_REF_ROOTS short-circuit, because 'trigger' is itself a valid
            // root and the short-circuit would otherwise leave the path broken.
            const segments = cleaned.split('.');
            if (root === 'trigger' && segments.length === 2 && segments[1] !== 'output' && triggerFields.has(segments[1])) {
                v.path = `trigger.output.${segments[1]}`;
                repairs.push(`inputs.${k}: inserted .output. segment → "${v.path}".`);
                continue;
            }
            if (VALID_REF_ROOTS.has(root)) {
                if (cleaned !== v.path) {
                    v.path = cleaned;
                    repairs.push(`inputs.${k}: cleaned ref path to "${cleaned}".`);
                }
                continue;
            }
            if (triggerFields.has(cleaned)) {
                v.path = `trigger.output.${cleaned}`;
                repairs.push(`inputs.${k}: prepended root → "${v.path}". Always start ref paths with trigger/steps/vars/secrets/loop.`);
                continue;
            }
            // "output.foo" → "trigger.output.foo" (when foo is a known trigger field).
            if (cleaned.startsWith('output.') && triggerFields.has(cleaned.slice('output.'.length))) {
                v.path = `trigger.${cleaned}`;
                repairs.push(`inputs.${k}: prepended trigger root → "${v.path}".`);
                continue;
            }
            errors.push(
                `inputs.${k}: ref path "${v.path}" has unknown root "${root}". `
                + `Valid roots: trigger, steps, vars, secrets, loop. `
                + (triggerFields.size
                    ? `For this trigger use trigger.output.<field>, e.g. trigger.output.${triggerFields.has(cleaned) ? cleaned : 'subject'}.`
                    : 'Use e.g. trigger.output.<field> or steps.<id>.output.<field>.')
            );
        }

        if (v.kind === 'template' && typeof v.value === 'string') {
            // Re-write {{ from }} → {{ trigger.output.from }} when the bare
            // identifier matches a known trigger field. Reject anything else
            // that has an unknown root.
            const bad = [];
            const rewrites = [];
            v.value = v.value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, expr) => {
                const cleaned = expr.replace(/^\.+/, '').trim();
                const root = cleaned.split('.')[0];
                if (VALID_REF_ROOTS.has(root)) return `{{${cleaned}}}`;
                if (triggerFields.has(cleaned)) {
                    rewrites.push(cleaned);
                    return `{{trigger.output.${cleaned}}}`;
                }
                bad.push(expr);
                return full;
            });
            if (rewrites.length) {
                repairs.push(`inputs.${k}: template placeholders ${rewrites.map(s => `"${s}"`).join(', ')} prepended with trigger.output.`);
            }
            if (bad.length) {
                errors.push(
                    `inputs.${k}: template references ${bad.map(s => `"${s}"`).join(', ')} which has unknown root. `
                    + `Use {{trigger.output.<field>}} or {{steps.<id>.output.<field>}}.`
                );
            }
        }
    }

    return {
        inputs: fixed,
        error: errors.length ? errors.join(' ') : null,
        repairs: repairs.length ? repairs : undefined,
    };
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
function sanitizeForEach(raw, graph) {
    if (raw === undefined || raw === null) return { forEach: undefined };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: 'forEach must be an object { overRef, itemVar, maxIterations? }, or omitted.' };
    }
    if (!raw.overRef || typeof raw.overRef !== 'string') {
        return { error: 'forEach requires `overRef` — a ref to an upstream array, e.g. "steps.<id>.output.results".' };
    }
    const { inputs, error } = validateAndFixBindings({ overRef: { kind: 'ref', path: raw.overRef } }, graph);
    if (error) return { error: `forEach.overRef: ${error}` };
    const itemVar = (typeof raw.itemVar === 'string' && raw.itemVar.trim()) ? raw.itemVar.trim() : 'item';
    const forEach = { overRef: inputs.overRef.path, itemVar };
    if (raw.maxIterations !== undefined) {
        const n = Number(raw.maxIterations);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
            return { error: 'forEach.maxIterations must be an integer between 1 and 1000.' };
        }
        forEach.maxIterations = n;
    }
    return { forEach };
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
        const m = /^\s*loop\.([A-Za-z_$][\w$]*)/.exec(value);
        if (m) out.push({ v: m[1], path: value.trim() });
        return out;
    }
    if (typeof value !== 'object') return out;
    if (value.kind === 'ref' && typeof value.path === 'string') return loopVarsReadBy(value.path, out, depth + 1);
    if (value.kind === 'template' && typeof value.value === 'string') {
        const re = /\{\{\s*([^}]+?)\s*\}\}/g;
        let m; while ((m = re.exec(value.value))) loopVarsReadBy(m[1], out, depth + 1);
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
 * validator passed it, and the routine finalised; at run time every cell
 * would have been empty. The var is only bound inside the step's own
 * forEach (the add tools build top-level steps — a loop body's steps are
 * built by builder_add_loop and never pass through here), so a mismatch is
 * refused where the model can still fix it in one call.
 */
function unboundLoopVarError(bindings, forEach, { what = 'inputs' } = {}) {
    const own = forEach && typeof forEach.itemVar === 'string' ? forEach.itemVar : null;
    // `loop._index` (and any other runner-injected key) is bound exactly
    // where the itemVar is: with a forEach it never mismatches; without one
    // it is as unbound as the item and stays in the list.
    const reads = loopVarsReadBy(bindings).filter(r => !(LOOP_RUNTIME_KEYS.has(r.v) && own));
    if (!reads.length) return null;
    const bad = reads.find(r => r.v !== own);
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
    sanitizeForEach,
    loopVarsReadBy,
    unboundLoopVarError,
    LOOP_RUNTIME_KEYS,
};
