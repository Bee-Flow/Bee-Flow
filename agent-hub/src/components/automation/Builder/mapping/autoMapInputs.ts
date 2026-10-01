/**
 * Automatic input mapping for the automation builder.
 *
 * When the user connects A → B (or drops B downstream of A), fill B's
 * still-empty inputs with bindings to matching upstream outputs. CONSERVATIVE
 * by design (the user's explicit choice): only name matches, gated by type,
 * never overwriting a field the user set. Every map is surfaced to the user
 * (toast + per-field badge) and is trivially reversible — so a wrong guess is
 * cheap, but we avoid them.
 *
 * WHICH name matches is not decided here: matchInputs in the shared mapping
 * core is the one rule, and the AI builder's auto-bind (server
 * builderTools/stepBuilders/inputBindings.js) uses it too. This file only
 * says what the candidates are and what a match is written as.
 *
 * Auto-map never makes a step run once per item. That is the author's call,
 * made in the step's Advanced section (StepRepeatSection). When the step
 * already repeats (a `repeat`, or a legacy `forEach`), the fields of the
 * current item are its nearest candidates, and a match reads that item.
 */

import {
    isSecretLikeKey, itemMatchScope, matchFromItem, matchInputs, normalizeKey, sampleType,
} from '@shared/mapping/index.mjs';
import type { ItemMatchScope, MappingSource, MatchCandidate, MatchInput } from '@shared/mapping/index.mjs';
import { isEmptyBinding } from './partitionInputs';
import { buildSampleRoot } from './realOutputs';
import { computeUpstreamGroups, buildToolOutputMap, inferLoopItemSample } from './upstream';
import { getLayerContract } from '../flow/flowletScope';
import { reconcileRouteEdges } from '../flow/routeEdges';

export { normalizeKey, sampleType, isSecretLikeKey };

type Json = Record<string, unknown>;
type Binding = Json;
type Inputs = Record<string, unknown>;

interface InputSchema {
    properties?: Record<string, { type?: string | string[] } | undefined> | null;
    required?: string[];
}

interface UpstreamField {
    key: string;
    path: string;
    sample?: unknown;
    perIteration?: boolean;
    children?: UpstreamField[];
}

interface UpstreamGroup {
    id: string;
    basePath?: string;
    kind?: string;
    forEach?: boolean;
    sample?: unknown;
    fields?: UpstreamField[];
}

interface Step extends Json {
    id: string;
    type: string;
    tool?: string;
    inputs?: Inputs;
    fields?: Inputs;
    forEach?: { overRef?: string; itemVar?: string; maxIterations?: number } | null;
    repeat?: { over?: MappingSource; max?: number } | null;
    autoMapped?: string[];
}

interface Definition extends Json {
    steps?: Step[];
}

interface AutoMapOpts {
    maxPerStep?: number;
    realOutputById?: Map<string, unknown> | null;
}

/** Resolve a tool's inputSchema from the catalog. */
export function findInputSchemaForTool(catalog: { apps?: Array<{ actions?: Array<{ name?: string; inputSchema?: InputSchema }> }> } | null | undefined, tool: string | undefined): InputSchema | null {
    for (const app of (catalog?.apps || [])) {
        for (const action of (app.actions || [])) {
            if (action?.name === tool) return action.inputSchema || null;
        }
    }
    return null;
}

/**
 * The fields of the upstream groups (and one nesting level) a top-level input
 * may be bound to. `near` is the group's index: the closest step wins a tie.
 */
function groupCandidates(groups: UpstreamGroup[]): MatchCandidate[] {
    const out: MatchCandidate[] = [];
    (groups || []).forEach((g, gi) => {
        for (const f of (g.fields || [])) {
            // A per-iteration field (upstream wrapGroupForEach) resolves to
            // ONE VALUE PER ITERATION, so auto-mapping it into a scalar param
            // would be wrong. It stays pickable by hand (BFSF-369).
            if (f.perIteration) continue;
            out.push({ key: f.key, path: f.path, type: sampleType(f.sample), near: gi });
            for (const c of (f.children || [])) {
                // Element children (`items[*].<key>`) carry a SCALAR sample but
                // resolve to an ARRAY at runtime ([*] flatten-maps) — the same
                // reason as above. They stay pickable by hand.
                if (/\[\*\]/.test(c.path)) continue;
                out.push({ key: c.key, path: c.path, type: sampleType(c.sample), near: gi });
            }
        }
    });
    return out;
}

/** The inputs a schema (or, without one, the existing keys) asks to fill, empty ones only. */
function emptyInputs(schema: InputSchema | null, existing: Inputs): MatchInput[] {
    const properties = schema?.properties || null;
    const required = new Set(schema?.required || []);
    // Generic (no schema): only keys that already exist on the step, never
    // invented ones; schema mode: every declared property.
    const keys = properties ? Object.keys(properties) : Object.keys(existing || {});
    return keys
        .filter(key => isEmptyBinding((existing || {})[key]))
        .map(key => ({ key, type: properties?.[key]?.type, required: required.has(key) }));
}

/**
 * @param targetInputSchema  { properties, required } or null (generic)
 * @param existingInputs     current inputs map (never overwritten)
 * @param upstreamGroups     computeUpstreamGroups output (nearest last)
 * @returns partial inputs patch — only NEW {kind:'ref'} bindings
 */
export function autoMapInputs(targetInputSchema: InputSchema | null, existingInputs: Inputs, upstreamGroups: UpstreamGroup[], opts: AutoMapOpts = {}): Record<string, Binding> {
    const { maxPerStep = 12 } = opts;
    const candidates = groupCandidates(upstreamGroups);
    if (!candidates.length) return {};
    const { matches } = matchInputs(emptyInputs(targetInputSchema, existingInputs), candidates, { skipSecrets: true, max: maxPerStep });
    return Object.fromEntries(matches.map(m => [m.key, { kind: 'ref', path: m.path }]));
}

const ARRAY_NAME_RE = /items|results|rows|records|data|list|messages|emails|events|files|entries/i;

/**
 * Nearest upstream list (for a loop's overRef or a list op's arrayRef).
 *
 * A step that ran once per item (a forEach group) IS a list: its `results`,
 * one entry per item. Its own fields are per-item columns, and skipping them
 * used to walk past the step to an older list two steps back — the wrong
 * list, silently.
 */
export function nearestArrayRef(groups: UpstreamGroup[]): string | null {
    for (let gi = (groups || []).length - 1; gi >= 0; gi--) {
        const g = groups[gi];
        if (g.forEach && g.basePath) return `${g.basePath}.results`;
        // A per-iteration column is an array only because it has one entry per
        // iteration — "loop over the counts an earlier loop produced" is never
        // what the author meant, so it is not a candidate source (BFSF-369).
        const fields = (g.fields || []).filter(f => !f.perIteration);
        const preferred = fields.find(f => sampleType(f.sample) === 'array' && ARRAY_NAME_RE.test(f.key));
        if (preferred) return preferred.path;
        const anyArr = fields.find(f => sampleType(f.sample) === 'array');
        if (anyArr) return anyArr.path;
    }
    return null;
}

// Field names that carry the free text a person actually wrote — where
// personal data lives, as opposed to an id or a status flag.
//
// ORDERED, not one alternation: a mail has both `subject` and `body`, and
// whichever came first in the field list would win. The long-form fields are
// where a name or an address actually turns up, so they are preferred over a
// one-line subject.
const SCANNABLE_NAME_RES = [
    /^(body|text|content|transcript|full_?text)$/i,
    /body|text|content|transcript|message|description|summary|notes?|comment|answer|html/i,
    /subject|title|name/i,
];

/**
 * The nearest upstream value worth handing a PII detector.
 *
 * Prefers a text field by name, then any string, and falls back to the whole
 * output of the nearest step — an object is scanned as its JSON, so "check
 * everything that step produced" is a real answer rather than a guess.
 */
export function nearestScannableRef(groups: UpstreamGroup[]): string | null {
    for (const re of SCANNABLE_NAME_RES) {
        for (let gi = (groups || []).length - 1; gi >= 0; gi--) {
            const fields = groups[gi].fields || [];
            const named = fields.find(f => sampleType(f.sample) === 'string' && re.test(f.key));
            if (named) return named.path;
        }
    }
    for (let gi = (groups || []).length - 1; gi >= 0; gi--) {
        const anyText = (groups[gi].fields || []).find(f => sampleType(f.sample) === 'string');
        if (anyText) return anyText.path;
    }
    const nearest = (groups || [])[(groups || []).length - 1];
    return nearest?.basePath || null;
}

// ── the item of a step that runs once per item ────────────────────────────
// Which fields the item offers and what a match is written as (an `each`
// pick under a repeat, a `loop.<itemVar>` ref under a forEach) is the shared
// core's rule (match.mjs itemMatchScope / matchFromItem), the same one the
// phone's auto-map uses. Only the item's sample is worked out here.

/** The item a repeating step reads, as the shared rule sees it; null when the step does not repeat. */
function itemScopeOf(step: Step, definition: Definition, catalog: unknown, groups: UpstreamGroup[]): ItemMatchScope | null {
    const toolToOutput = buildToolOutputMap(catalog);
    const sampleRoot = buildSampleRoot(groups);
    return itemMatchScope(step, definition, listPath => inferLoopItemSample(listPath, definition, toolToOutput, sampleRoot as never));
}

/** Bind a repeating step's empty inputs from its current item (shared matchFromItem). */
function mapFromItem(scope: ItemMatchScope, schema: InputSchema | null, existing: Inputs): Record<string, Binding> {
    return matchFromItem(scope, emptyInputs(schema, existing)) as Record<string, Binding>;
}

/**
 * Build a pseudo input-schema for a call_layer node. The contract derives
 * live from `definition.layers[step.layerKey]` (inline flowlets). When the
 * definition in hand has no layers map (e.g. the canvas is scoped inside
 * a flowlet and a sibling call_layer is being mapped), fall back to the
 * step's existing input keys — generic mode, never inventing keys.
 */
function layerParamSchema(step: Step, definition: Definition): InputSchema {
    const { params } = getLayerContract(definition, step.layerKey as string) as { params: Array<{ name: string; type?: string; required?: boolean }> };
    if (params.length) {
        return {
            properties: Object.fromEntries(params.map(p => [p.name, { type: p.type }])),
            required: params.filter(p => p.required).map(p => p.name),
        };
    }
    const keys = Object.keys(step.inputs || {});
    return { properties: Object.fromEntries(keys.map(k => [k, {}])), required: [] };
}

/**
 * Is this over/arrayRef still the palette scaffold (never user-chosen)?
 * The literal 'trigger.output.items' is the legacy seed every Lists/Loop node
 * used to carry — treating it as scaffold lets auto-map heal already-saved
 * nodes on re-connect. New nodes seed '' (C20).
 */
function isScaffoldOverRef(ref: unknown): boolean {
    return !ref || ref === 'trigger.output.items';
}

/**
 * Is this condition still the untouched palette scaffold? `buildStepFromPayload`
 * seeds `expr: 'true'` (the parser needs something valid); anything else means
 * the author has already said what the step decides, and auto-detection must
 * keep its hands off.
 */
function isScaffoldExpr(expr: unknown): boolean {
    const src = String(expr || '').trim();
    return src === '' || src === 'true';
}

export interface AutoMapResult {
    step: Step;
    mappedKeys: string[];
}

/**
 * Auto-map a single step against its upstream context. Returns the
 * (possibly) updated step plus the list of keys/fields that were mapped.
 * `definition` must already contain `step` and its incoming edge so
 * upstream resolves correctly.
 */
export function autoMapStep(step: Step, definition: Definition, catalog: unknown, opts: AutoMapOpts = {}): AutoMapResult {
    if (!step || !definition) return { step, mappedKeys: [] };
    // opts.realOutputById (mapping/realOutputs.js) folds run/pinned outputs
    // into the groups — so a node added below a step that just produced 10
    // real records maps against those records, not against placeholders.
    const groups = computeUpstreamGroups(definition, step.id, catalog, (opts.realOutputById || null) as never) as unknown as UpstreamGroup[];
    if (!groups.length) return { step, mappedKeys: [] };

    const type = step.type;

    if (type === 'integration_action') {
        const schema = findInputSchemaForTool(catalog as never, step.tool);
        const scope = itemScopeOf(step, definition, catalog, groups);
        const fromItem = scope ? mapFromItem(scope, schema, step.inputs || {}) : {};
        const withItem: Inputs = { ...(step.inputs || {}), ...fromItem };
        // The rest from upstream; the item is not offered a second time.
        const upstream = scope?.groupId ? groups.filter(g => g.id !== scope.groupId) : groups;
        const patch = autoMapInputs(schema, withItem, upstream, opts);
        const keys = [...Object.keys(fromItem), ...Object.keys(patch)];
        if (!keys.length) return { step, mappedKeys: [] };
        return { step: { ...step, inputs: { ...withItem, ...patch } }, mappedKeys: keys };
    }

    if (type === 'call_layer') {
        const schema = layerParamSchema(step, definition);
        const patch = autoMapInputs(schema, step.inputs || {}, groups, opts);
        const keys = Object.keys(patch);
        if (!keys.length) return { step, mappedKeys: [] };
        return { step: { ...step, inputs: { ...(step.inputs || {}), ...patch } }, mappedKeys: keys };
    }

    if (type === 'ai_step') {
        // Generic: only fill existing input keys (don't invent prompt inputs).
        const patch = autoMapInputs(null, step.inputs || {}, groups, opts);
        const keys = Object.keys(patch);
        if (!keys.length) return { step, mappedKeys: [] };
        return { step: { ...step, inputs: { ...(step.inputs || {}), ...patch } }, mappedKeys: keys };
    }

    if (type === 'guard' || type === 'tokenize' || type === 'untokenize') {
        // A guard dropped below a step almost always means "check what that
        // step just produced". Binding it on arrival is the difference between
        // a node that works and one that greets you with a warning — and an
        // author who has already chosen a source is never overridden.
        if (typeof step.sourceRef === 'string' && step.sourceRef.trim()) return { step, mappedKeys: [] };
        const ref = nearestScannableRef(groups);
        if (!ref) return { step, mappedKeys: [] };
        return { step: { ...step, sourceRef: ref }, mappedKeys: ['sourceRef'] };
    }

    if (type === 'set') {
        // Auto-detect list input, mirroring the condition→filter detection
        // below: a PRISTINE scaffold (no fields, no per-item run, no arrayRef,
        // no operations — i.e. the user hasn't said anything yet) wired below
        // a step that hands it a list almost always means "edit these rows",
        // so it becomes a list-mode Edit data with the source already bound.
        // The mode stays overridable under Advanced, and a step the user has
        // touched in ANY way is left alone.
        const pristine = !Object.keys(step.fields || {}).length
            && !step.forEach
            && !step.repeat
            && typeof step.arrayRef !== 'string'
            && !(Array.isArray(step.operations) && step.operations.length);
        if (pristine) {
            const ref = nearestArrayRef(groups);
            if (ref) return { step: { ...step, arrayRef: ref }, mappedKeys: ['arrayRef'] };
        }
        // List mode with a blank source ('' — e.g. flipped on under Advanced)
        // binds like any collection op.
        if (typeof step.arrayRef === 'string' && isScaffoldOverRef(step.arrayRef)) {
            const ref = nearestArrayRef(groups);
            if (ref) return { step: { ...step, arrayRef: ref }, mappedKeys: ['arrayRef'] };
        }
        const patch = autoMapInputs(null, step.fields || {}, groups, opts);
        const keys = Object.keys(patch);
        if (!keys.length) return { step, mappedKeys: [] };
        return { step: { ...step, fields: { ...(step.fields || {}), ...patch } }, mappedKeys: keys };
    }

    if (type === 'loop') {
        if (!isScaffoldOverRef(step.overRef)) return { step, mappedKeys: [] };
        const ref = nearestArrayRef(groups);
        if (!ref) return { step, mappedKeys: [] };
        return { step: { ...step, overRef: ref }, mappedKeys: ['overRef'] };
    }

    // The Condition node detects what it is deciding ABOUT instead of asking. A
    // freshly dropped one is a `condition` (the whole run); if the step it is
    // wired to hands it a list, working through that list is what the author
    // almost always means — so it becomes a list-mode Filter with the source
    // already bound, and the form has nothing left to fill in.
    //
    // Guarded three ways so it can never fight the user: only while the
    // condition still carries its scaffold expression, only when it has no
    // outgoing edges yet (nothing to re-point), and never for a switch that
    // already declares cases. The mode stays overridable under Advanced.
    if (type === 'condition') {
        if (!isScaffoldExpr(step.expr)) return { step, mappedKeys: [] };
        const ref = nearestArrayRef(groups);
        if (!ref) return { step, mappedKeys: [] };
        return { step: { ...step, type: 'filter', arrayRef: ref }, mappedKeys: ['arrayRef'] };
    }

    // A switch already IN list mode (the key is present but blank) gets its
    // source bound like any collection op; a branch-mode switch is left alone
    // — binding a source there would silently change what it decides about.
    if (type === 'switch') {
        if (typeof step.arrayRef !== 'string' || !isScaffoldOverRef(step.arrayRef)) return { step, mappedKeys: [] };
        const ref = nearestArrayRef(groups);
        if (!ref) return { step, mappedKeys: [] };
        return { step: { ...step, arrayRef: ref }, mappedKeys: ['arrayRef'] };
    }

    if (['filter', 'limit', 'dedupe', 'aggregate', 'summarize'].includes(type)) {
        // Scaffold-aware like the loop branch above: the old `if (step.arrayRef)`
        // guard bailed on ANY truthy value, and the palette always seeded the
        // 'trigger.output.items' literal — so auto-map NEVER bound a Lists
        // node's source list, and manual/schedule-triggered flows silently ran
        // the op over a non-existent array (C20).
        if (!isScaffoldOverRef(step.arrayRef)) return { step, mappedKeys: [] };
        const ref = nearestArrayRef(groups);
        if (!ref) return { step, mappedKeys: [] };
        return { step: { ...step, arrayRef: ref }, mappedKeys: ['arrayRef'] };
    }

    // switch / code / notification / datetime / wait / stop_error /
    // return_to_app (the two TERMINAL types — flow/terminalSteps.js): no safe
    // automatic binding.
    return { step, mappedKeys: [] };
}

/**
 * Apply auto-mapping to one step inside a definition, returning a new
 * definition with the step updated plus the mapped key list. Records the
 * mapped *input* keys on `step.autoMapped` so the inspector can show the
 * "auto" pill (overRef/arrayRef aren't inputs, so they're excluded from
 * the marker but still counted in mappedKeys for the toast).
 */
export function applyAutoMapToStep(definition: Definition, stepId: string, catalog: unknown, opts: AutoMapOpts = {}): { definition: Definition; mappedKeys: string[] } {
    const steps = definition?.steps || [];
    const idx = steps.findIndex(s => s.id === stepId);
    if (idx === -1) return { definition, mappedKeys: [] };
    const { step: mapped, mappedKeys } = autoMapStep(steps[idx], definition, catalog, opts);
    if (!mappedKeys.length) return { definition, mappedKeys: [] };
    const inputKeys = mappedKeys.filter(k => k !== 'overRef' && k !== 'arrayRef');
    const withMarker = inputKeys.length
        ? { ...mapped, autoMapped: Array.from(new Set([...(mapped.autoMapped || []), ...inputKeys])) }
        : mapped;
    const nextSteps = steps.slice();
    nextSteps[idx] = withMarker;
    let next: Definition = { ...definition, steps: nextSteps };
    // Detecting list mode changes the Condition node's TYPE, which renames its
    // output ports (then/else → one plain continuation). Re-point its edges in
    // the same commit — a step spliced onto an existing connection already has
    // an outgoing edge by the time auto-map runs.
    if (withMarker.type !== steps[idx].type) {
        next = reconcileRouteEdges(next, stepId, steps[idx], withMarker) as Definition;
    }
    return { definition: next, mappedKeys };
}
