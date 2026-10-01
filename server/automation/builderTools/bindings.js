/**
 * Builder tools — binding canonicalization and repair. Coerces the AI's
 * input bindings into canonical form, self-repairs the common ref-path
 * mistakes against the draft's trigger fields, and validates the optional
 * per-step `forEach` spec. Required from within automation/builderTools/
 * and re-exported (for tests) via the ../builderTools facade.
 *
 * The model is taught picks (`{pick:"steps.x.output.items.email",
 * take:"all"}`) and composes; they are stored in the shared core's v2 form,
 * labelled (picks.js), with the same path repairs a ref gets. A ref or a
 * template the model writes is accepted and kept as it is.
 */

const { triggerFieldsFor } = require('./triggerCatalog');
const {
    REF_RE, RUNTIME_ROOTS, TRIGGER_RUN_KEYS, repairLegacyPath, tokenizePath,
    pickProblems, composeProblems, normalizePick, describeSource, isPick, picksIn,
} = require('../../shared/mapping/index.mjs');
const { canonicalMapping, isCompactPick: _isCompactPick, isCompactCompose, isMappingShape } = require('./picks');

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

// The ref-path repair, for the ways weaker models mangle a path:
//   $steps.x.output.y          → steps.x.output.y        (leading $ for "expression")
//   steps[x].output[y]         → steps.x.output.y        (bracket access)
//   .steps.x.output.y          → steps.x.output.y        (leading dot)
//   steps . x . output         → steps.x.output          (stray whitespace)
//   {{steps.x.output.y}}       → steps.x.output.y        (template braces on a ref)
//   items.0.name               → items[0].name           (dotted index)
//   body.content-type          → body["content-type"]    (key the grammar must quote)
//   loop.x.output.a\"}}}},tempId: → loop.x.output.a      (JSON debris after the path)
//
// A path the runtime already reads (REF_RE) keeps its spelling: `items[0]`,
// `results[*].output.a` and `row["Due date"]` are valid. The old normaliser
// turned every bracket into a dot and then cut at the first character it did
// not expect, so it rewrote all three into paths that resolve to undefined. Everything else goes through the shared
// core's reader (repairLegacyPath), so the canonical spelling is the one the
// editor and the runtime use too.
//
// The debris case is the Gemma-4-on-llama.cpp signature (measured 2026-09-17,
// findings F1): a valid path followed by escape/punctuation debris the model
// cannot stop emitting, so it resent the same corruption until the ladder
// stopped the turn. `debris` is what was cut off, so validateAndFixBindings can
// name that repair in a _warnings note.
const DEBRIS_START = /^\s*[\\"'{}()<>,;:|`=+!?&]/;

function repairRefPath(path) {
    if (typeof path !== 'string') return { path, debris: '' };
    // Cleaning a path that is already canonical changes nothing, so a valid
    // path comes back unchanged; `$steps.x` passes REF_RE (`$` is an
    // identifier character) but names no root, so it is cleaned first.
    const cleaned = path
        .trim()
        .replace(/^\{\{\s*([^{}]*?)\s*\}\}$/, '$1')
        .replace(/^\$+/, '')
        .replace(/^\.+/, '');
    if (REF_RE.test(cleaned)) return { path: cleaned, debris: '' };
    const { path: repaired, rest } = repairLegacyPath(cleaned);
    // Not even a root reads, or what follows the readable part is not debris
    // (`items[0` with its bracket unclosed): no guess. The path is left as
    // it is, for the checks in validateAndFixBindings to refuse.
    if (!repaired || (rest && !DEBRIS_START.test(rest))) return { path: cleaned, debris: '' };
    return { path: repaired, debris: rest };
}

/** The identifier a path starts with ('steps' for 'steps["x"].output'). */
function rootOfPath(path) {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(path);
    return m ? m[0] : '';
}

/**
 * Is `{path: …}` (with no `kind`) a ref the model forgot to tag? Only when
 * `path` is its ONLY key, and it is not a file-system path: a slash or a
 * backslash outside a ref root makes it data, so a file `{path: '/Invoices/a.pdf',
 * name: 'a.pdf'}` or `{path: 'Invoices/a.pdf'}` is a literal (it used to be cut
 * to the empty path '' and refused). Every other lone `{path}` is taken as a
 * ref, even one that does not read as one — `{path: 'subject'}` on a trigger
 * without that field, a mistyped root (`step.x.output.y`), an unclosed
 * `items[0` — so validateAndFixBindings refuses it with an error the model can
 * act on. Kept as a literal, the tool would have received the object
 * `{path: 'subject'}` as its argument.
 */
function _isKindlessRef(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    const keys = Object.keys(m);
    if (keys.length !== 1 || keys[0] !== 'path' || typeof m.path !== 'string') return false;
    const { path } = repairRefPath(m.path);
    return !(/[/\\]/.test(path) && !VALID_REF_ROOTS.has(rootOfPath(path)));
}

/**
 * Is this member itself a binding — canonical, or the kind-less `{path}` /
 * `{value}` shape a weaker model emits? Used to tell a map of BINDINGS from a
 * map of plain data, which decides whether the map is resolved member by
 * member or frozen whole as a literal.
 */
function _looksLikeBinding(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    if (typeof m.kind === 'string' && ['literal', 'ref', 'template', 'expr', 'pick', 'compose'].includes(m.kind)) return true;
    return _isKindlessRef(m) || _isCompactPick(m) || isCompactCompose(m);
}

function canonicalizeBinding(v) {
    // A v2 binding (pick, compose, or the compact `{pick: …}` / `{compose: […]}`):
    // its stored form, every pick in it labelled (picks.js).
    if (isMappingShape(v)) return canonicalMapping(v);
    // Already a binding wrapper with a recognised kind — repair a mangled ref path, then pass through.
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.kind === 'string'
        && ['literal', 'ref', 'template', 'expr'].includes(v.kind)) {
        if (v.kind === 'ref' && typeof v.path === 'string') {
            const { path } = repairRefPath(v.path);
            if (path !== v.path) return { ...v, path };
        }
        return v;
    }
    // Wrapper with no kind but has a discriminating field — infer the kind.
    // Weaker models often emit { value: "..." } or { path: "..." } without
    // the kind tag; we recover those instead of silently flattening to literal.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (_isKindlessRef(v)) {
            return { kind: 'ref', path: repairRefPath(v.path).path };
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
    if (Array.isArray(v) && v.some(m => _looksLikeBinding(m))) {
        return v.map(m => canonicalizeBinding(m));
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
        && ['literal', 'ref', 'template', 'expr', 'pick', 'compose'].includes(v.kind);
}

const VALID_REF_ROOTS = new Set(['trigger', 'steps', 'vars', 'secrets', 'loop']);

/**
 * The rooting repairs a path the model wrote gets, for a ref and a pick
 * alike (one rule, each caller words its own note):
 *   insert_output    `trigger.<field>` → `trigger.output.<field>`. That
 *                    is undefined at run time for every key that is not the
 *                    payload (output), the headers or a metadata key, so the
 *                    payload is the only reading; a metadata key the
 *                    trigger's payload declares too (`id` on a spreadsheet
 *                    trigger, `kind` on a Nextcloud file trigger) means the
 *                    payload's field, as it always has here: left alone it
 *                    reads the trigger node's id or 'app_event'.
 *   prepend_root     a bare trigger field (`subject`) → `trigger.output.subject`.
 *   prepend_trigger  `output.<field>` of a trigger field → `trigger.output.<field>`.
 * `kind` is null (and `path` the path given) when none applies.
 * @param {string} cleaned — the path, its spelling already repaired
 * @param {Set<string>} triggerFields
 * @returns {{ path: string, kind: 'insert_output'|'prepend_root'|'prepend_trigger'|null }}
 */
function repairTriggerRooting(cleaned, triggerFields) {
    const root = rootOfPath(cleaned);
    if (root === 'trigger') {
        // Any depth: 'trigger.attachments[0].filename' too.
        const second = REF_RE.test(cleaned) ? tokenizePath(cleaned)[1] : null;
        if (second && second.type === 'prop' && typeof second.key === 'string' && second.key !== 'output'
            && (!TRIGGER_RUN_KEYS.includes(second.key) || triggerFields.has(second.key))) {
            return { path: `trigger.output${cleaned.slice('trigger'.length)}`, kind: 'insert_output' };
        }
        return { path: cleaned, kind: null };
    }
    if (VALID_REF_ROOTS.has(root)) return { path: cleaned, kind: null };
    if (triggerFields.has(cleaned)) return { path: `trigger.output.${cleaned}`, kind: 'prepend_root' };
    if (cleaned.startsWith('output.') && triggerFields.has(cleaned.slice('output.'.length))) {
        return { path: `trigger.${cleaned}`, kind: 'prepend_trigger' };
    }
    return { path: cleaned, kind: null };
}

/**
 * The path of a pick the model wrote as text (`{pick:"…"}`, a part of a
 * compose, a `from` given as a string), repaired the way a ref path is:
 * the spelling (repairRefPath), then the rooting (repairTriggerRooting).
 * `note` names a repair worth teaching.
 * @returns {{ path: string, note: string|null }}
 */
function repairPickPath(path, triggerFields) {
    const { path: cleaned, debris } = repairRefPath(path);
    const { path: rooted, kind } = repairTriggerRooting(cleaned, triggerFields);
    if (kind === 'insert_output') return { path: rooted, note: `inserted .output. → "${rooted}" (what the trigger received is under trigger.output)` };
    if (kind === 'prepend_root') return { path: rooted, note: `prepended trigger.output. → "${rooted}"` };
    if (kind === 'prepend_trigger') return { path: rooted, note: `prepended trigger. → "${rooted}"` };
    if (debris) return { path: cleaned, note: `the path carried JSON debris after it — read as "${cleaned}"` };
    return { path: cleaned, note: null };
}

/**
 * The raw inputs with every pick path the model wrote as text repaired
 * (repairPickPath), and a note per repair. Only picks are touched; refs and
 * templates get their own repairs below.
 */
function repairRawPicks(raw, triggerFields, repairs) {
    const fixPick = (label, node, key) => {
        if (typeof node[key] !== 'string') return node;
        const { path, note } = repairPickPath(node[key], triggerFields);
        if (path === node[key]) return node;
        if (note) repairs.push(`${label}: pick path "${node[key].trim()}" ${note}.`);
        return { ...node, [key]: path };
    };
    const fixPart = (label, p) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
        if (typeof p.pick === 'string') return fixPick(label, p, 'pick');
        if (typeof p.from === 'string') return fixPick(label, p, 'from');
        return p;
    };
    const walk = (label, node, depth) => {
        if (!node || typeof node !== 'object' || depth > 3) return node;
        if (Array.isArray(node)) return node.map((m, i) => walk(`${label}[${i}]`, m, depth + 1));
        if (isCompactCompose(node)) return { compose: node.compose.map((p, i) => fixPart(`${label}.compose[${i}]`, p)) };
        if (node.kind === 'compose' && Array.isArray(node.parts)) return { ...node, parts: node.parts.map((p, i) => fixPart(`${label}.parts[${i}]`, p)) };
        if (_isCompactPick(node) || node.kind === 'pick') return fixPart(label, node);
        if (typeof node.kind === 'string') return node;
        const out = {};
        for (const [k, m] of Object.entries(node)) out[k] = walk(`${label}.${k}`, m, depth + 1);
        return out;
    };
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = walk(`inputs.${k}`, v, 0);
    return out;
}

// Trigger output fields the LLM commonly mis-roots — when a ref path is bare
// ("from", "subject", …) we can confidently prepend `trigger.output.` instead
// of bouncing the call back to the model. Keyed by `<provider>.<event>`.
function validateAndFixBindings(rawInputsIn, draft) {
    const triggerFields = new Set(triggerFieldsFor(draft));
    const errors = [];
    const repairs = [];
    const rawInputs = rawInputsIn && typeof rawInputsIn === 'object' && !Array.isArray(rawInputsIn)
        ? repairRawPicks(rawInputsIn, triggerFields, repairs)
        : rawInputsIn;
    const fixed = canonicalizeInputs(rawInputs || {});

    // Two ref-path repairs are worth a note. The tail-trim: the debris is the
    // Gemma-4 signature the model cannot help resending, and the clean path
    // is the thing to teach. And the spelling repair (`items.0` → `items[0]`,
    // `body.content-type` → `body["content-type"]`): the model learns the one
    // spelling the runtime reads. The older transforms ($, leading dot,
    // whitespace, steps[x]) stay silent, as they always were.
    // canonicalizeInputs already applied the repair; this pass only NAMES it
    // (doctrine: nothing is coerced silently).
    const bracketCount = (p) => (p.match(/\[/g) || []).length;
    const collectPathNotes = (label, node, depth) => {
        if (!node || typeof node !== 'object') return;
        if (_looksLikeBinding(node)) {
            // The compact pick and compose are the forms the model is taught
            // (builderPrompt.js): expanding them is no repair to name.
            if (typeof node.path === 'string' && !_isCompactPick(node)) {
                const { path: clean, debris } = repairRefPath(node.path);
                if (debris) {
                    repairs.push(`${label}: ref path "${node.path.trim()}" carried JSON debris after the real path — read as "${clean}".`);
                } else if (clean !== node.path && bracketCount(clean) > bracketCount(node.path)) {
                    repairs.push(`${label}: ref path "${node.path.trim()}" read as "${clean}" — write an index as [0] and a key with spaces or dashes as ["key"]; a dotted .0 or .content-type resolves to nothing at run time.`);
                }
            }
            return;
        }
        if (depth >= 3) return;
        if (Array.isArray(node)) { node.forEach((m, i) => collectPathNotes(`${label}[${i}]`, m, depth + 1)); return; }
        for (const [key, m] of Object.entries(node)) collectPathNotes(`${label}.${key}`, m, depth + 1);
    };
    for (const [k, v] of Object.entries(rawInputs || {})) collectPathNotes(`inputs.${k}`, v, 0);

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

        if (v.kind === 'pick' || v.kind === 'compose') {
            const problems = v.kind === 'pick' ? pickProblems(v) : composeProblems(v);
            if (problems.length) {
                const unread = v.kind === 'pick' && typeof v.from === 'string'
                    ? ` The path "${v.from}" is not one the runtime can read: start it with trigger/steps/vars/loop, e.g. steps.<id>.output.<field>.`
                    : '';
                const badPart = v.kind === 'compose' && Array.isArray(v.parts)
                    ? v.parts.find(p => p && typeof p === 'object' && typeof p.pick === 'string')
                    : null;
                const unreadPart = badPart ? ` The path "${badPart.pick}" is not one the runtime can read: start it with trigger/steps/vars/loop, e.g. steps.<id>.output.<field>.` : '';
                errors.push(`inputs.${k}: the ${v.kind} binding is not valid (${problems.join(', ')}).${unread}${unreadPart} A pick is {"pick": "steps.<id>.output.<field>", "take": "one"|"all"|"first"|"last"|"count", "as": "native"|"text"|"list"|"number"|"date"|"yesno"|"json"}; a compose is {"compose": ["text ", {"pick": "…"}, " more text"]}.`);
            }
            continue;
        }

        if (v.kind === 'ref' && typeof v.path === 'string') {
            const cleaned = v.path.replace(/^\.+/, '').trim();
            const root = rootOfPath(cleaned);
            // The rooting repairs (repairTriggerRooting) come BEFORE the
            // VALID_REF_ROOTS short-circuit, because 'trigger' is itself a
            // valid root and the short-circuit would otherwise leave
            // `trigger.<field>` broken.
            const rooting = repairTriggerRooting(cleaned, triggerFields);
            if (rooting.kind === 'insert_output') {
                v.path = rooting.path;
                repairs.push(`inputs.${k}: inserted .output. segment → "${v.path}".`);
                continue;
            }
            if (VALID_REF_ROOTS.has(root)) {
                if (!REF_RE.test(cleaned)) {
                    errors.push(`inputs.${k}: ref path "${v.path}" is not a path the runtime can read. Write steps.<id>.output.<field>, an index as [0] and a key with spaces or dashes as ["key"].`);
                    continue;
                }
                if (cleaned !== v.path) {
                    v.path = cleaned;
                    repairs.push(`inputs.${k}: cleaned ref path to "${cleaned}".`);
                }
                continue;
            }
            if (rooting.kind === 'prepend_root') {
                v.path = rooting.path;
                repairs.push(`inputs.${k}: prepended root → "${v.path}". Always start ref paths with trigger/steps/vars/secrets/loop.`);
                continue;
            }
            // "output.foo" → "trigger.output.foo" (when foo is a known trigger field).
            if (rooting.kind === 'prepend_trigger') {
                v.path = rooting.path;
                repairs.push(`inputs.${k}: prepended trigger root → "${v.path}".`);
                continue;
            }
            errors.push(
                `inputs.${k}: ref path "${v.path}" has unknown root "${root}". `
                + `Valid roots: trigger, steps, vars, secrets, loop. `
                + (triggerFields.size
                    ? `For this trigger use trigger.output.<field>, e.g. trigger.output.${triggerFields.has(cleaned) ? cleaned : 'subject'}.`
                    : 'Use e.g. trigger.output.<field> or steps.<id>.output.<field>.')
                + ' If this is data rather than a reference, send it as {kind:"literal", value:…}.'
            );
        }

        if (v.kind === 'template' && typeof v.value === 'string') {
            // Re-write {{ from }} → {{ trigger.output.from }} when the bare
            // identifier matches a known trigger field. Reject anything else
            // that has an unknown root.
            const bad = [];
            const rewrites = [];
            const respelled = [];
            v.value = v.value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, expr) => {
                const cleaned = expr.replace(/^\.+/, '').trim();
                const root = rootOfPath(cleaned);
                if (VALID_REF_ROOTS.has(root)) {
                    // The same spelling repair a ref gets, but only when the
                    // whole placeholder reads as one path: `{{a.b + 1}}` is
                    // not a path, and stays as it was.
                    if (!REF_RE.test(cleaned)) {
                        const { path: repaired, debris } = repairRefPath(cleaned);
                        if (!debris && REF_RE.test(repaired)) {
                            respelled.push([cleaned, repaired]);
                            return `{{${repaired}}}`;
                        }
                    }
                    return `{{${cleaned}}}`;
                }
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
            for (const [from, to] of respelled) {
                repairs.push(`inputs.${k}: template placeholder "{{${from}}}" read as "{{${to}}}" — write an index as [0] and a key with spaces or dashes as ["key"].`);
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
 * An ai_step input may not be named after a data root (trigger, steps, vars,
 * loop, secrets). The prompt's `{{name}}` reads the step's inputs by name AND
 * the roots, and the roots win (execAi aiPromptScope), so such an input could
 * never be read from the prompt; refused here, where the model can rename it
 * in one call.
 */
function rootShadowError(inputs) {
    const name = Object.keys(inputs && typeof inputs === 'object' ? inputs : {}).find(k => RUNTIME_ROOTS.includes(k));
    if (!name) return null;
    return {
        error: `inputs.${name}: an ai_step input cannot be named "${name}" — that is a data root the prompt reads {{${name}.…}} from. Rename the input (e.g. "${name}Data") and use that name in the prompt.`,
        _fixHint: 'Reject reason: an ai_step input is named after a data root. Rename that input and resend the step — the other fields were fine.',
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
    // The list given as a pick (`overRef:{pick:"steps.x.output.items"}`, the
    // form the model is taught for values): the path it names. The loop
    // reads overRef with the LEGACY walk (execFlow), where a key on a list
    // is undefined and only `[*]` crosses one, so a path written as text is
    // kept as written (repaired, its `[*]` kept): a Source has no `[*]`, and
    // `results[*].attachments` spelled from it would loop over nothing.
    if (raw.overRef && typeof raw.overRef === 'object' && !Array.isArray(raw.overRef)) {
        const o = raw.overRef;
        const written = typeof o.pick === 'string' ? o.pick : (o.kind === 'pick' && typeof o.from === 'string' ? o.from : null);
        if (written !== null) {
            raw = { ...raw, overRef: repairPickPath(written, new Set(triggerFieldsFor(graph))).path };
        } else {
            const pick = normalizePick(o);
            if (pick && isPick(pick)) raw = { ...raw, overRef: describeSource(pick.from) };
        }
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
 * Every `loop.<var>` a set of canonical bindings reads — ref paths, the
 * {{…}} placeholders inside templates and the picks of a loop item — with
 * the var name.
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
    // A pick of the loop item (`{root:'loop', id:<var>}`), alone or as a
    // part of a compose, reads loop.<var> just as a ref to it does.
    if (value.kind === 'pick' || value.kind === 'compose') {
        for (const p of picksIn(value)) {
            if (p.from && p.from.root === 'loop' && typeof p.from.id === 'string') out.push({ v: p.from.id, path: describeSource(p.from) });
        }
        return out;
    }
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
    repairRefPath,
    rootShadowError,
    loopVarsReadBy,
    unboundLoopVarError,
    LOOP_RUNTIME_KEYS,
};
