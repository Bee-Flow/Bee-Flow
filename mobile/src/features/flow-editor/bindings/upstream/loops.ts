/**
 * Iteration: what a Loop, an expanded loop's "Each item" pill and a
 * `step.forEach` offer, and the inference all three rest on — the shape of
 * ONE element of the array an `overRef` points at. The three must agree: the
 * same step is authorable from several surfaces. Port of agent-hub
 * `Builder/mapping/upstream/loops.js`.
 *
 * Every path is written with the runtime grammar's own writer (appendKey), so
 * an item key such as `Story Points`, `@odata.etag` or `line-items` is offered
 * as `["Story Points"]` — the spelling the run resolves.
 */

import { translate as t } from '@/core/i18n';
import { appendKey, appendWildcard, getPath, parsePath, walkTokens } from '@/shared/expr';

import { asValue, firstItemOver, isRecord, mergeElementSamples } from '../deepFields';
import type { FlowDefinition, FlowNode, ToolOutputMap, VariableField, VariableGroup } from '../types';
import { describeNode } from './describeNode';
import { forEachOutputPath, perIterationField, rebaseFields } from './forEachShape';
import { sampleToFieldsReal } from './realOverlay';
import { sampleToFields } from './sampleFields';

/** A group the step reads as its OWN item: never a list source for that step. */
type OwnGroup = VariableGroup & { ownItem: boolean };

/**
 * A Loop seen from DOWNSTREAM: the per-item scope is gone, the output is the
 * `{ iterations, results: [{ index, item, output }] }` envelope, so element
 * fields are offered as `results[*].item.<key>`, and what each iteration
 * produced (the body's last step) as `results[*].output.<key>`.
 */
export function describeLoop(
    node: FlowNode,
    toolToOutput: ToolOutputMap,
    definition: FlowDefinition,
    sampleRoot: unknown = null,
): VariableGroup {
    const itemVar = node.itemVar || 'item';
    const elementSample = inferLoopItemSample(node.overRef, definition, toolToOutput, sampleRoot);
    const base = `steps.${node.id}.output`;
    const resultsPath = appendKey(base, 'results');
    const itemBase = appendKey(appendWildcard(resultsPath), 'item');
    const body = describeBodyOutput(node, definition, toolToOutput, sampleRoot);
    const results = [{ index: 0, item: elementSample || {}, output: body ? body.sample : {} }];
    const itemFields = isRecord(elementSample)
        ? Object.entries(elementSample).map(([k, v]) => ({ key: k, path: appendKey(itemBase, k), sample: Array.isArray(v) ? v : [v] }))
        : [];
    const outputFields = body ? rebaseFields(body.fields || [], body.basePath, forEachOutputPath(base)).map(perIterationField) : [];
    return {
        id: node.id,
        label: node.label || t('mobile.flow.group.loop_named', 'Loop ({name})', { name: itemVar }),
        kind: 'loop',
        basePath: base,
        sample: { iterations: 0, results },
        fields: [
            { key: 'iterations', path: appendKey(base, 'iterations'), sample: 0 },
            { key: 'results', path: resultsPath, sample: results },
            ...itemFields,
            ...outputFields,
        ],
    };
}

/** The group of the body step each iteration records (the last that runs: not a note, not a wait). */
function describeBodyOutput(loopNode: FlowNode, definition: FlowDefinition, toolToOutput: ToolOutputMap, sampleRoot: unknown): VariableGroup | null {
    const body = Array.isArray(loopNode.body) ? (loopNode.body as FlowNode[]) : [];
    const last = [...body].reverse().find((s) => s && s.type !== 'note' && s.type !== 'wait');
    if (!last) return null;
    const g = describeNode(last, { definition, toolToOutput, triggerOutputs: {}, sampleRoot, catalog: null });
    if (!g || !g.basePath) return null;
    if (!last.forEach || !last.forEach.overRef) return g;
    const outBase = forEachOutputPath(g.basePath);
    const counters: VariableField[] = ['iterations', 'succeeded', 'failed'].map((key) => ({ key, path: appendKey(g.basePath, key), sample: 0 }));
    return {
        ...g,
        sample: { iterations: 0, succeeded: 0, failed: 0, results: [{ index: 0, item: {}, output: g.sample || {}, status: 'success' }] },
        fields: [...counters, ...rebaseFields(g.fields || [], g.basePath, outBase).map(perIterationField)],
    };
}

function currentItemLabel(itemVar: string, batched: boolean): string {
    return batched
        ? t('mobile.flow.group.current_batch', 'Current batch (loop.{name})', { name: itemVar })
        : t('mobile.flow.group.current_item', 'Current item (loop.{name})', { name: itemVar });
}

/** The per-item loop variable of a step that iterates itself (`step.forEach`); `ownItem`: never its own list source. */
export function describeForEachItem(
    step: FlowNode,
    definition: FlowDefinition,
    toolToOutput: ToolOutputMap,
    sampleRoot: unknown = null,
): VariableGroup {
    const fe = step.forEach || {};
    const itemVar = fe.itemVar || 'item';
    const item = inferLoopItem(fe.overRef, definition, toolToOutput, sampleRoot);
    const sample = item?.value || {};
    const group: OwnGroup = {
        id: `${step.id}__foreach`,
        label: t('mobile.flow.group.current_item_short', 'Current item ({name})', { name: itemVar }),
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        ownItem: true,
        sample,
        fields: itemFields(item, `loop.${itemVar}`, sampleToFieldsReal),
    };
    return group;
}

/**
 * The outer items a step over a list INSIDE a list keeps (`forEach.parents`,
 * outermost first): the mail each attachment came from stays `loop.result`.
 * One group per parent, listed before the step's own item.
 */
export function describeForEachParents(
    step: FlowNode,
    definition: FlowDefinition,
    toolToOutput: ToolOutputMap,
    sampleRoot: unknown = null,
): VariableGroup[] {
    const fe = step.forEach || {};
    const parents = Array.isArray(fe.parents) ? (fe.parents as unknown[]) : [];
    const out: VariableGroup[] = [];
    for (const raw of parents) {
        const p = isRecord(raw) ? raw : null;
        if (!p || typeof p.itemVar !== 'string' || !p.itemVar || p.itemVar === fe.itemVar || typeof p.overRef !== 'string') continue;
        const item = inferLoopItem(p.overRef, definition, toolToOutput, sampleRoot);
        const sample = item?.value || {};
        const group: OwnGroup = {
            id: `${step.id}__parent_${p.itemVar}`,
            label: t('mobile.flow.group.outer_item', 'Outer item ({name})', { name: p.itemVar }),
            kind: 'loop',
            basePath: `loop.${p.itemVar}`,
            ownItem: true,
            sample,
            fields: itemFields(item, `loop.${p.itemVar}`, sampleToFieldsReal),
        };
        out.push(group);
    }
    return out;
}

/**
 * The "Each item" pill of an EXPANDED loop — `loop.<itemVar>`, resolved against
 * the loop's own source. A batch (batchSize > 1) binds a SLICE, so it offers
 * no single-item fields (same rule as computeLoopBodyGroups).
 */
export function describeLoopItem(
    node: FlowNode,
    definition: FlowDefinition,
    toolToOutput: ToolOutputMap,
    sampleRoot: unknown = null,
): VariableGroup {
    const itemVar = node.itemVar || 'item';
    const batched = Math.max(1, Number(node.batchSize) || 1) > 1;
    const item = inferLoopItem(node.overRef, definition, toolToOutput, sampleRoot);
    const elementSample = item?.value || {};
    return {
        id: node.id,
        label: currentItemLabel(itemVar, batched),
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        sample: batched ? [elementSample] : elementSample,
        fields: batched || !isRecord(elementSample) ? [] : itemFields(item, `loop.${itemVar}`, sampleToFields),
    };
}

/**
 * ONE item of a list, in its two roles: `value` is the item a preview shows
 * (the first, as the run's first iteration binds it), `shape` the union of the
 * rows' keys the fields are built from. A record that is not in a list is both.
 */
interface LoopItem {
    value: Record<string, unknown>;
    shape: Record<string, unknown>;
}

function itemOf(v: unknown): LoopItem | null {
    if (Array.isArray(v)) {
        const shape = mergeElementSamples(v);
        return isRecord(shape) ? { value: firstItemOver(v, shape) as Record<string, unknown>, shape } : null;
    }
    return isRecord(v) ? { value: v, shape: v } : null;
}

/**
 * The item's fields: built from its SHAPE, each field that names one place in
 * the item showing the item's OWN value there. A column (`attachments[*].id`)
 * keeps the shape's sample: one value standing for its rows.
 */
function itemFields(item: LoopItem | null, basePath: string, build: (sample: unknown, base: string) => VariableField[]): VariableField[] {
    if (!item) return [];
    const fields = build(item.shape, basePath);
    return item.value === item.shape ? fields : resampled(fields, item.value, basePath);
}

/** The fields of a list's current item, for the Loop body editor's "Current item" group; [] for no records. */
export function listItemFields(list: unknown, basePath: string): VariableField[] {
    const arr = asValue(list);
    return Array.isArray(arr) ? itemFields(itemOf(arr), basePath, sampleToFields) : [];
}

function resampled(fields: VariableField[], value: unknown, basePath: string): VariableField[] {
    const depth = (parsePath(basePath) || []).length;
    return fields.map((f) => {
        const rest = ((parsePath(f.path) || []) as { type: string }[]).slice(depth);
        const own = rest.length && !rest.some((t) => t.type === 'wild') ? walkTokens(rest as Parameters<typeof walkTokens>[0], value) : undefined;
        const out: VariableField = own === undefined ? { ...f } : { ...f, sample: own };
        if (f.children) out.children = resampled(f.children, value, basePath);
        return out;
    });
}

/** The step a `steps.<id>.output…` path reads from, or null. */
function sourceStep(tokens: { type: string; key?: unknown }[], definition: FlowDefinition): FlowNode | null {
    if (tokens.length < 3 || tokens[0]?.key !== 'steps' || tokens[2]?.key !== 'output') return null;
    return (definition?.steps || []).find((s) => s.id === tokens[1]?.key) || null;
}

/** The item of a list in an integration step's catalog sample (no run, no pin). */
function itemFromCatalog(overRef: string, definition: FlowDefinition, toolToOutput: ToolOutputMap): LoopItem | null {
    const tokens = parsePath(overRef) as { type: string; key?: unknown }[] | null;
    const node = tokens ? sourceStep(tokens, definition) : null;
    const meta = node ? toolToOutput?.get?.(node.tool as string) : null;
    if (!tokens || !node || meta?.sample == null) return null;
    // A step that iterates hands on the forEach envelope.
    const root = node.forEach?.overRef
        ? { iterations: 0, succeeded: 0, failed: 0, results: [{ index: 0, item: {}, output: meta.sample, status: 'success' }] }
        : meta.sample;
    return itemOf(walkTokens(tokens.slice(3) as Parameters<typeof walkTokens>[0], root));
}

/**
 * `steps.s1.output.results` → ONE item of the list (see itemOf), first from
 * the accumulated design-time root, then from the source step's catalog
 * sample. Read with the runtime grammar. Null when unresolved.
 */
function inferLoopItem(overRef: unknown, definition: FlowDefinition, toolToOutput: ToolOutputMap, sampleRoot: unknown = null): LoopItem | null {
    if (typeof overRef !== 'string' || !overRef.trim()) return null;
    const arr = sampleRoot ? getPath(sampleRoot, overRef.trim()) : undefined;
    const fromRoot = Array.isArray(arr) && arr.length > 0 ? itemOf(arr) : null;
    return fromRoot || itemFromCatalog(overRef.trim(), definition, toolToOutput);
}

/**
 * The item a list is previewed by: its first element as the run's first
 * iteration binds it, with the keys only later rows have filled in. Null when
 * the path can't be resolved.
 */
export function inferLoopItemSample(
    overRef: unknown,
    definition: FlowDefinition,
    toolToOutput: ToolOutputMap,
    sampleRoot: unknown = null,
): Record<string, unknown> | null {
    return inferLoopItem(overRef, definition, toolToOutput, sampleRoot)?.value ?? null;
}

const RESERVED_VARS = new Set(['true', 'false', 'null', '_index']);

function singular(s: string): string {
    if (/ies$/.test(s)) return s.slice(0, -3) + 'y';
    // "-es" is a plural ending only after s/x/z/ch/sh: "lines" → "line", not "lin".
    if (/(ss|x|z|ch|sh)es$/.test(s)) return s.slice(0, -2);
    if (/(ss|us|is)$/.test(s)) return s;
    if (/s$/.test(s) && s.length > 2) return s.slice(0, -1);
    return s;
}

/**
 * `results` → `result`, `categories` → `category`: a loop variable name, and
 * always an identifier (`line-items` / `Line Items` → `line_item`), because it
 * becomes `loop.<name>` and `loop.line-item` reads as nothing at run time.
 */
export function suggestItemVar(key: unknown): string {
    const s = String(key ?? '').trim();
    if (!s) return 'item';
    const words = s.split(/[^A-Za-z0-9_]+/).filter(Boolean);
    if (!words.length) return 'item';
    const plain = words.length === 1 && words[0] === s;
    const last = singular(words[words.length - 1] as string);
    let name = plain ? last : [...words.slice(0, -1), last].join('_').toLowerCase();
    name = name.replace(/^_+|_+$/g, '') || 'item';
    if (/^[0-9]/.test(name)) name = `item_${name}`;
    return RESERVED_VARS.has(name) ? 'item' : name;
}

/** `name`, or `name_item`, `name_2`, … — the first that `taken` does not hold. */
export function uniqueItemVar(name: string, taken: (string | null | undefined)[] = []): string {
    const used = new Set(taken.filter(Boolean));
    if (!used.has(name)) return name;
    if (!used.has(`${name}_item`)) return `${name}_item`;
    for (let i = 2; ; i++) if (!used.has(`${name}_${i}`)) return `${name}_${i}`;
}

/** The last key of a path (`steps.o.output["line-items"]` → `line-items`): fieldTree's, one copy. */
export { lastPathKey } from './fieldTree';
