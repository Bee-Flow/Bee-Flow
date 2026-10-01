/**
 * Builder tools — model-facing payload helpers: the step-id echoes appended
 * to every mutation result, sample compaction, the dry-run projection and
 * the JSON-safe tool-result truncator. Shared by the ../builderTools facade,
 * the builder route and flowletAgent.js.
 */

const { formatPath } = require('../../shared/mapping/index.mjs');

/**
 * Build a tiny summary of the current draft's step IDs so every mutation
 * result reminds the LLM of the exact ids it must use for downstream
 * `afterStepId` / refs / template paths. Without this the model
 * fabricated short ids like "step_1" that didn't exist in the draft —
 * the dry-run then ran with broken bindings and the AI had to spend
 * extra iterations un-tangling its own mistake.
 */
/**
 * The ids and types inside a loop's body, or undefined for any other step.
 * Kept to id/type/tool so it stays cheap on an echo that repeats after every
 * mutation — enough for the model to address a body step by id and to see that
 * its last write landed.
 */
function bodyDigest(step) {
    if (!step || step.type !== 'loop') return undefined;
    const body = Array.isArray(step.body) ? step.body : [];
    if (!body.length) return [];
    return body.map(b => ({ id: b?.id, type: b?.type, tool: b?.tool || undefined }));
}

/**
 * One step's line in the structured echo — shared by the main flow and the
 * per-flowlet sections so the two never drift apart.
 *
 * A datatable step shows its op, table and value keys, and an extraction its
 * declared field names: the two steps the model chains most (extract → save
 * one row per file) are exactly the two whose echo used to be a bare
 * `{id, type}`. It had no way to confirm, from the echo, that the op it
 * meant was stored, which table the step resolved to, or which field names
 * the next step may bind — so it re-inspected or guessed.
 */
function stepDigest(s) {
    const d = {
        id: s.id,
        type: s.type,
        tool: s.tool || undefined,
        layerKey: s.type === 'call_layer' ? (s.layerKey || undefined) : undefined,
        forEach: s.forEach?.overRef ? `over ${s.forEach.overRef} as loop.${s.forEach.itemVar || 'item'}` : undefined,
        // A forEach "Koppelingen bijwerken" made a repeat: the same fan-out
        // (`results`, one entry per item), its item read by `each` picks.
        repeat: s.repeat?.over ? `over ${formatPath(s.repeat.over) || 'a list'}, once per item` : undefined,
        // A loop's body steps used to be invisible in every model-facing
        // view (this echo rendered only the loop itself, and the summary a
        // bare count). The model was editing a structure it could not see,
        // could not confirm its own writes against, and was told about only
        // through validation errors naming `lb_…` ids it had never met.
        body: bodyDigest(s),
        label: s.label || undefined,
    };
    if (s.type === 'datatable') {
        d.op = s.op || undefined;
        d.table = s.datatableKey
            ? `${s.datatableKey} (${s.datatableId || 'unlinked'})`
            : (s.datatableId || 'unlinked');
        d.values = Object.keys((s.values && typeof s.values === 'object' && !Array.isArray(s.values)) ? s.values : {});
        if (s.matchColumn) d.matchColumn = s.matchColumn;
    }
    if (s.type === 'data_extraction') {
        d.fields = (Array.isArray(s.fields) ? s.fields : []).map(f => (f && typeof f === 'object' ? f.name : f));
    }
    return d;
}

function summariseDraftSteps(draft) {
    const list = [];
    if (draft?.trigger?.id) list.push({ id: draft.trigger.id, type: 'trigger', kind: draft.trigger.kind });
    // Additional entry points — listed beside the primary so the model wires
    // their steps with afterStepId:<trigger id> instead of chaining them onto
    // the primary's tail.
    for (const t of (Array.isArray(draft?.triggers) ? draft.triggers : [])) {
        if (!t?.id) continue;
        list.push({
            id: t.id, type: 'trigger', kind: t.kind, additional: true,
            event: t.appEvent ? `${t.appEvent.provider}.${t.appEvent.event}` : undefined,
            cron: t.schedule?.cron || undefined,
            label: t.label || undefined,
        });
    }
    for (const s of (draft?.steps || [])) list.push(stepDigest(s));
    // Per-flowlet sections so the model can target scoped mutations: each
    // entry reminds it of the flowlet key, its input params (bound inside as
    // trigger.output.<param>) and the live step ids within that scope.
    for (const [key, g] of Object.entries(draft?.layers || {})) {
        if (!g || typeof g !== 'object') continue;
        const steps = [{
            id: g.trigger?.id || 'trg',
            type: 'trigger',
            kind: 'layer_input',
            params: (Array.isArray(g.trigger?.params) ? g.trigger.params : []).map(p => p?.name).filter(Boolean),
        }];
        for (const s of (g.steps || [])) steps.push(stepDigest(s));
        list.push({ layer: key, title: g.title || undefined, steps });
    }
    return list;
}

/**
 * The draft's real wiring, as `from→to(label)` per edge.
 *
 * A definition is a DAG, but every model-facing echo used to render it in
 * steps[] ARRAY order with no edges at all — so a fan-out (two steps both
 * hanging off one anchor) read to the model as a straight chain, and a step
 * that could never see another step's output looked like its direct
 * successor. The model then re-derived the topology from first principles on
 * every round, and guessed wrong. Cheap to carry: ~12 chars per edge.
 */
function renderEdgeLine(draft) {
    const parts = [];
    const render = (g) => (Array.isArray(g?.edges) ? g.edges : [])
        .filter(e => e && e.from && e.to)
        .map(e => `${e.from}→${e.to}${e.label ? `(${e.label})` : ''}`)
        .join(', ');
    const main = render(draft);
    parts.push(`main: ${main || '(no edges yet)'}`);
    for (const [key, g] of Object.entries(draft?.layers || {})) {
        if (!g || typeof g !== 'object') continue;
        const inner = render(g);
        if (inner) parts.push(`flowlet ${key}: ${inner}`);
    }
    return parts.join(' | ');
}

/**
 * One-line step-id reminder (~5 tokens/step vs ~25 for the structured
 * `_draftSteps` list). Used on pure-append mutation results where the model
 * only needs the live ids kept in front of it — the anti-fabrication purpose
 * of the echo — not every step's settings.
 */
function renderStepIdLine(draft) {
    const token = (s) => `${s.id}(${s.tool || s.type})`;
    const parts = [];
    const main = [];
    if (draft?.trigger?.id) main.push(`${draft.trigger.id}(${draft.trigger.kind || 'trigger'})`);
    const extra = (Array.isArray(draft?.triggers) ? draft.triggers : []).filter(t => t?.id)
        .map(t => `${t.id}(${t.kind}${t.appEvent ? `:${t.appEvent.provider}.${t.appEvent.event}` : ''}${t.schedule?.cron ? `:${t.schedule.cron}` : ''})`);
    if (extra.length) main.push(`[+triggers ${extra.join(', ')}]`);
    for (const s of (draft?.steps || [])) main.push(token(s));
    // Comma-joined, NOT ' > '. This line is an id INVENTORY, not an order:
    // it renders steps[] array order, which on any branched graph is not the
    // execution order. The real order is in renderEdgeLine.
    parts.push(`main: ${main.join(', ') || '(empty)'}`);
    for (const [key, g] of Object.entries(draft?.layers || {})) {
        if (!g || typeof g !== 'object') continue;
        const params = (Array.isArray(g.trigger?.params) ? g.trigger.params : []).map(p => p?.name).filter(Boolean);
        const steps = [`${g.trigger?.id || 'trg'}[${params.join(',')}]`, ...(g.steps || []).map(token)];
        parts.push(`flowlet ${key}: ${steps.join(', ')}`);
    }
    return parts.join(' | ');
}

/**
 * Bound a value for a model-facing echo: arrays keep the first `maxArray`
 * item(s) plus an "+N more" marker, strings are capped, objects depth-capped.
 * Returns null when even the compacted form exceeds `maxChars` — callers
 * drop the field and keep the (one-line) shape hint instead.
 */
function compactSample(value, { maxArray = 1, maxDepth = 4, maxString = 120, maxChars = 2000 } = {}) {
    const walk = (v, depth) => {
        if (v == null) return v;
        if (typeof v === 'string') return v.length > maxString ? `${v.slice(0, maxString)}…` : v;
        if (typeof v !== 'object') return v;
        if (depth >= maxDepth) return Array.isArray(v) ? `<array:${v.length}>` : '<object>';
        if (Array.isArray(v)) {
            const head = v.slice(0, maxArray).map(x => walk(x, depth + 1));
            if (v.length > maxArray) head.push(`…+${v.length - maxArray} more`);
            return head;
        }
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = walk(val, depth + 1);
        return out;
    };
    const compacted = walk(value, 0);
    try {
        if (JSON.stringify(compacted).length > maxChars) return null;
    } catch (_) { return null; }
    return compacted;
}

/**
 * Model-facing projection of a dry-run result: what went WRONG, and the
 * shape of what went right — never the payloads.
 *
 * The FULL {run, steps} keeps flowing to the client (SSE `dryrun` event, and
 * `dryrun_started` before it so the canvas can follow the run live). What goes
 * back into the LLM context used to be every step's `outputHead` — a sample
 * of each output — which on a clean run is tokens the model reads only to
 * conclude "fine" (and in a dry run most of it is synthesised anyway:
 * `_dryRunSynthesised`). Owner, 2026-09-18: show the run, and hand the model
 * only what failed. So:
 *   - the `_hint` (output type, top-level keys, one-line shape) stays on EVERY
 *     step — it is the binding signal, and a missing column still shows as a
 *     key missing from the shape;
 *   - a failed step keeps its `error`, `errorClass` and a compacted `input`;
 *   - a forEach step whose ITEMS failed reports them (`items.failedItems`,
 *     first 5) even though the step itself succeeded;
 *   - a successful step that produced NOTHING (`empty: true` — an empty
 *     list, `count: 0`, a forEach over zero items) is flagged, and so is an
 *     extraction or AI step whose top-level fields came back `null`
 *     (`nullKeys`): a routine that runs clean and does nothing is the quiet
 *     failure a person cannot see either;
 *   - `ok` + `note` say in one line whether there is anything to fix.
 */
const MAX_ITEM_FAILURES = 5;
const NULL_SIGNAL_TYPES = new Set(['data_extraction', 'ai_step']);

function isFailedStatus(status) {
    return /fail|error/i.test(String(status || ''));
}

/** A forEach output ({iterations, succeeded, failed, results}) summarised — null for anything else. */
function forEachSummary(output) {
    if (!output || typeof output !== 'object' || Array.isArray(output) || !Array.isArray(output.results)) return null;
    if (!('iterations' in output) && !('succeeded' in output) && !('failed' in output)) return null;
    const results = output.results;
    const failedItems = [];
    for (let i = 0; i < results.length && failedItems.length < MAX_ITEM_FAILURES; i += 1) {
        const r = results[i];
        if (r && typeof r === 'object' && isFailedStatus(r.status)) {
            failedItems.push({ index: Number.isFinite(r.index) ? r.index : i, error: typeof r.error === 'string' ? r.error.slice(0, 300) : (r.error ? JSON.stringify(r.error).slice(0, 300) : 'failed') });
        }
    }
    const failed = Number.isFinite(output.failed) ? output.failed : results.filter(r => r && isFailedStatus(r.status)).length;
    return {
        iterations: Number.isFinite(output.iterations) ? output.iterations : results.length,
        succeeded: Number.isFinite(output.succeeded) ? output.succeeded : results.length - failed,
        failed,
        ...(failedItems.length ? { failedItems } : {}),
    };
}

/** True when a successful step's output is an empty result: nothing listed, found or iterated. */
function looksEmpty(output) {
    if (Array.isArray(output)) return output.length === 0;
    if (!output || typeof output !== 'object') return false;
    if (Array.isArray(output.results) && 'iterations' in output) return output.results.length === 0;
    for (const k of ['items', 'rows', 'results', 'files', 'messages', 'records']) {
        if (Array.isArray(output[k])) return output[k].length === 0;
    }
    if (Number.isFinite(output.count)) return output.count === 0;
    return false;
}

/** Top-level keys whose value is null — on a forEach, of the FIRST item's output. */
function nullKeysOf(output) {
    let obj = output;
    if (obj && typeof obj === 'object' && Array.isArray(obj.results) && 'iterations' in obj) {
        const first = obj.results.find(r => r && typeof r === 'object' && r.output && typeof r.output === 'object');
        obj = first ? first.output : null;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.entries(obj).filter(([k, v]) => v === null && !k.startsWith('_')).map(([k]) => k);
}

function compactDryRunForModel(result) {
    if (!result || !result.run) return result;
    const run = result.run;
    const steps = Array.isArray(result.steps) ? result.steps : [];
    let failedSteps = 0;
    let failedItems = 0;
    const projected = steps.map(s => {
        const base = {
            stepId: s.stepId,
            stepType: s.stepType || undefined,
            status: s.status,
            ...(s.parentStepId ? { parentStepId: s.parentStepId } : {}),
            _hint: s._hint,
        };
        if (s.error || isFailedStatus(s.status)) {
            failedSteps += 1;
            return { ...base, error: s.error || undefined, errorClass: s.errorClass || undefined, input: compactSample(s.input, { maxChars: 1500, maxString: 300 }) };
        }
        const items = forEachSummary(s.output);
        if (items && items.failed > 0) {
            failedItems += items.failed;
            return { ...base, items };
        }
        // Only where a null means "not found": an extraction or AI answer. A
        // previewed datatable write has `id: null` by design in a dry run.
        const nullKeys = NULL_SIGNAL_TYPES.has(s.stepType) ? nullKeysOf(s.output) : [];
        return {
            ...base,
            ...(looksEmpty(s.output) ? { empty: true } : {}),
            ...(nullKeys.length ? { nullKeys } : {}),
        };
    });
    const runFailed = !!run.error || isFailedStatus(run.status);
    const ok = !runFailed && failedSteps === 0 && failedItems === 0;
    const problems = [];
    if (runFailed) problems.push(`the run ended ${run.status || 'in error'}${run.error ? ` (${String(run.error).slice(0, 200)})` : ''}`);
    if (failedSteps) problems.push(`${failedSteps} step${failedSteps === 1 ? '' : 's'} failed`);
    if (failedItems) problems.push(`${failedItems} forEach item${failedItems === 1 ? '' : 's'} failed`);
    const emptySteps = projected.filter(p => p.empty).map(p => p.stepId);
    return {
        run: {
            id: run.id,
            status: run.status,
            ...(run.error ? { error: run.error } : {}),
            startedAt: run.startedAt || undefined,
            finishedAt: run.finishedAt || undefined,
            stepCount: steps.length,
        },
        ok,
        note: ok
            ? `Clean run: every step succeeded${emptySteps.length ? ` — but ${emptySteps.join(', ')} produced nothing (empty: true); check its inputs before you finish` : ''}. Nothing to fix: finish with builder_finalize.`
            : `${problems.join('; ')}. Fix each failed step with builder_update_step and dry-run again; the steps below carry the error and the input that caused it.`,
        steps: projected,
    };
}

/**
 * JSON-safe replacement for the old blind `JSON.stringify(x).slice(0, 30k)`
 * on model-facing tool messages (which could cut mid-JSON and hand the model
 * an unparseable blob). Guarantees the returned string is valid JSON: first
 * drops the `_draftSteps` echo, then trims a `steps` array from the tail with
 * an explicit `_truncated` marker, and as a last resort wraps a preview.
 */
function truncateToolResultJson(result, maxChars = 30_000) {
    let s;
    try { s = JSON.stringify(result); } catch (_) { return JSON.stringify({ error: 'unserializable tool result' }); }
    if (typeof s !== 'string') return JSON.stringify(null);
    if (s.length <= maxChars) return s;
    const clone = (result && typeof result === 'object' && !Array.isArray(result)) ? { ...result } : null;
    if (clone) {
        delete clone._draftSteps;
        s = JSON.stringify(clone);
        if (s.length <= maxChars) return s;
        if (Array.isArray(clone.steps) && clone.steps.length > 1) {
            const total = clone.steps.length;
            for (let keep = total - 1; keep >= 1; keep--) {
                const candidate = { ...clone, steps: clone.steps.slice(0, keep), _truncated: true, omittedSteps: total - keep };
                s = JSON.stringify(candidate);
                if (s.length <= maxChars) return s;
            }
        }
    }
    return JSON.stringify({ _truncated: true, preview: s.slice(0, Math.max(0, maxChars - 200)) });
}

module.exports = {
    summariseDraftSteps,
    renderStepIdLine,
    renderEdgeLine,
    compactSample,
    compactDryRunForModel,
    truncateToolResultJson,
};
