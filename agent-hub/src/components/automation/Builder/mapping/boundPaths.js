/**
 * boundPaths — which upstream paths a step already uses (artboard 2b:
 * "2 fields · 1 already in use").
 *
 * Pure. Scans the step's own configuration — every binding, template,
 * expression and bare path string it carries — for the reference roots the
 * runtime knows (`trigger.output…`, `steps.<id>.output…`, `loop.<var>…`) and
 * returns them as a Set. Deliberately syntactic: it reads the same text the
 * server's binder reads, so a path counts as "in use" exactly when the run
 * would resolve it.
 */
const REF_RE = /(?:steps\.[A-Za-z0-9_-]+\.output|trigger\.output|loop\.[A-Za-z0-9_]+)(?:\.[A-Za-z0-9_]+|\[\*\]|\[\d+\]|\["[^"]*"\])*/g;

/** Every reference path written anywhere in `step` (excluding its id/position). */
export function usedPathsIn(step) {
    const out = new Set();
    if (!step || typeof step !== 'object') return out;
    // Keep the position and identity out: they never hold a reference, and a
    // step whose label happens to read "steps.x.output" is not a binding.
    const { id, position, label, ...rest } = step; // eslint-disable-line no-unused-vars
    let text = '';
    try { text = JSON.stringify(rest) || ''; } catch { return out; }
    for (const m of text.matchAll(REF_RE)) out.add(m[0]);
    return out;
}

/** Is `path` (or one of its parents) among the used paths? */
export function pathInUse(path, used) {
    if (!used || !path) return false;
    if (used.has(path)) return true;
    // `steps.a.output.results` is in use when `steps.a.output.results[*].subject` is.
    for (const p of used) if (p.startsWith(`${path}.`) || p.startsWith(`${path}[`)) return true;
    return false;
}

/** How many of a group's fields (top level) this step already uses. */
export function countInUse(fields, used) {
    if (!used || !used.size) return 0;
    let n = 0;
    for (const f of fields || []) if (f?.path && pathInUse(f.path, used)) n += 1;
    return n;
}

/** The named binding maps a step declares — `{ slotName: binding }`. */
const SLOT_MAPS = ['inputs', 'fields'];

/**
 * Nothing typed, nothing picked. The ONE answer both value editors, the
 * empty-slot note and the footer's "still empty" count read, so a slot cannot
 * look filled in one place and empty in another.
 */
export function isEmptyValue(b) {
    if (b == null) return true;
    if (typeof b !== 'object') return String(b).trim() === '';
    if (b.kind === 'literal') return b.value == null || String(b.value).trim() === '';
    if (b.kind === 'ref') return !String(b.path || '').trim();
    if (b.kind === 'template' || b.kind === 'expr') return !String(b.value || '').trim();
    return false;
}

/**
 * The INVERSE of the above: of the slots this step DECLARES, how many hold
 * nothing? It is what the settings footer's "1 field still empty" pill counts
 * (artboard 2b, where 6 template places have 5 bound).
 *
 * A declared slot is:
 *   - a key in one of the step's own binding maps (`inputs`, `fields`) — the
 *     Set step and the layer output keep a named field even when it is empty,
 *     which is exactly the case the pill exists for; and
 *   - a REQUIRED parameter of the tool's schema, whether or not `inputs` has a
 *     key for it — ToolInputForm DELETES a tool param whose value is cleared,
 *     so an unfilled required param leaves no trace in the definition at all.
 *
 * Optional schema properties are deliberately NOT counted: a tool with thirty
 * optional parameters is not "thirty fields still empty", and a pill that says
 * so teaches people to ignore it.
 *
 * THE THIRD ANSWER. For a tool step the required list is the only thing that
 * makes this count COMPLETE, and it can be missing: the catalog is fetched,
 * both fetch sites swallow the error, and a 401 or a hiccup leaves it null for
 * the rest of the session. Counted the same way, that gave "1 field still
 * empty" — or, for an untouched step, silence — on a step with three unfilled
 * required parameters, because ToolInputForm DELETES a cleared parameter and
 * an unfilled one leaves no trace at all. "I cannot check" then looked exactly
 * like "nothing is wrong", which is the one thing it may never look like. So
 * the caller says whether the schema was RESOLVED, and an unresolved one comes
 * back as `unknown: true` for the footer to say out loud.
 *
 * @param {object} step
 * @param {{ inputSchema?: object|null, schemaKnown?: boolean }} opts
 *        `schemaKnown: false` = this step has a schema and we could not read
 *        it. Default true: a step that declares no tool has nothing to miss.
 * @returns {{ declared: number, empty: number, keys: string[], unknown: boolean }}
 */
export function emptySlotsIn(step, { inputSchema = null, schemaKnown = true } = {}) {
    const keys = [];
    let declared = 0;
    const seen = new Set();
    for (const map of SLOT_MAPS) {
        const slots = step?.[map];
        if (!slots || typeof slots !== 'object' || Array.isArray(slots)) continue;
        for (const [k, v] of Object.entries(slots)) {
            const id = `${map}.${k}`;
            if (seen.has(id)) continue;
            seen.add(id);
            declared += 1;
            if (isEmptyValue(v)) keys.push(k);
        }
    }
    const required = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
    for (const k of required) {
        const id = `inputs.${k}`;
        if (seen.has(id)) continue;
        seen.add(id);
        declared += 1;
        keys.push(k);
    }
    return { declared, empty: keys.length, keys, unknown: !schemaKnown };
}
