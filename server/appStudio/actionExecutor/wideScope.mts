/**
 * App Studio action executor — the WIDE server scope (schema version 3, `definition.serverScope: 'wide'`).
 *
 * In the base a server step's formula reads `screen`, `forms` and `actions` as empty. An app that opts in
 * gets them from the browser with each server step of a click:
 *
 *   screenParams   { <name>: value }                       → screen.params.<name>
 *   forms          { <formId>: { <field>: value } }        → forms.<formId>.<field>
 *   actionResults  { <actionId>: { status, result, error } } → actions.<actionId>.result
 *
 * All three are VIEWER INPUT, at the trust level of `form`, `vars`, `item` and `value`: they reach formulas
 * and nothing else. Who the viewer is (ctx.viewerId, ctx.role, ctx.viewer), the row rules and every table
 * or field name come from the session and the definition, never from here. Each bag is bounded in fan-out
 * here; the 64KB body guard of the step routes bounds the bytes.
 *
 * A definition without the flag gets NO key from wideScopeInput, so its ctx and its scope are what they were.
 */

type Obj = Record<string, unknown>;

export interface WideScope {
    screen: { params: Obj };
    forms: Record<string, Obj>;
    actions: Record<string, { status: string | null; result: unknown; error: string | null }>;
}

const MAX_KEYS = 100;
const MAX_KEY_LEN = 100;
const MAX_FORMS = 50;
const MAX_ACTION_RESULTS = 50;
const MAX_STATUS_LEN = 20;
const MAX_ERROR_LEN = 500;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True when the definition opted in to the wide server scope. */
export function isWideScope(definition: unknown): boolean {
    return isObject(definition) && definition.serverScope === 'wide';
}

/** A plain object with a bounded number of bounded keys; anything else is {}. Null-prototype: only own keys are values. */
function bag(raw: unknown, maxKeys: number = MAX_KEYS): Obj {
    const out: Obj = Object.create(null);
    if (!isObject(raw)) return out;
    let count = 0;
    for (const [key, value] of Object.entries(raw)) {
        if (count >= maxKeys) break;
        if (key.length > MAX_KEY_LEN) continue;
        out[key] = value;
        count += 1;
    }
    return out;
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

function formsOf(raw: unknown): WideScope['forms'] {
    const out: WideScope['forms'] = Object.create(null);
    for (const [formId, values] of Object.entries(bag(raw, MAX_FORMS))) out[formId] = bag(values);
    return out;
}

function actionsOf(raw: unknown): WideScope['actions'] {
    const out: WideScope['actions'] = Object.create(null);
    for (const [actionId, entry] of Object.entries(bag(raw, MAX_ACTION_RESULTS))) {
        if (!isObject(entry)) continue;
        out[actionId] = { status: text(entry.status, MAX_STATUS_LEN), result: entry.result ?? null, error: text(entry.error, MAX_ERROR_LEN) };
    }
    return out;
}

/**
 * What a step route adds to the executor's ctx: `{ wideScope }` for a definition that opted in, and
 * nothing at all for any other (whatever the body carries).
 */
export function wideScopeInput(definition: unknown, body: unknown): { wideScope?: WideScope } {
    if (!isWideScope(definition)) return {};
    const b = isObject(body) ? body : {};
    return { wideScope: { screen: { params: bag(b.screenParams) }, forms: formsOf(b.forms), actions: actionsOf(b.actionResults) } };
}
