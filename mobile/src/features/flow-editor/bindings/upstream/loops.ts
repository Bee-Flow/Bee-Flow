/**
 * Iteration: what a Loop, an expanded loop's "Each item" pill and a
 * `step.forEach` offer, and the inference all three rest on — the shape of
 * ONE element of the array an `overRef` points at. The three must agree: the
 * same step is authorable from several surfaces. Port of agent-hub
 * `Builder/mapping/upstream/loops.js`.
 */

import { translate as t } from '@/core/i18n';

import { isObj } from '../json';
import type { FlowDefinition, FlowNode, ToolOutputMap, VariableGroup } from '../types';
import { walkPath } from '../walkPath';
import { sampleToFields } from './sampleFields';

/**
 * A Loop seen from DOWNSTREAM: the per-item scope is gone, the output is the
 * `{ iterations, results: [{ index, item, output }] }` envelope, so element
 * fields are offered as `results[*].item.<key>`.
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
    const results = [{ index: 0, item: elementSample || {}, output: {} }];
    const itemFields = isObj(elementSample)
        ? Object.entries(elementSample).map(([k, v]) => ({
            key: k,
            path: `${base}.results[*].item.${k}`,
            sample: Array.isArray(v) ? v : [v],
        }))
        : [];
    return {
        id: node.id,
        label: node.label || t('mobile.flow.group.loop_named', 'Loop ({name})', { name: itemVar }),
        kind: 'loop',
        basePath: base,
        sample: { iterations: 0, results },
        fields: [
            { key: 'iterations', path: `${base}.iterations`, sample: 0 },
            { key: 'results', path: `${base}.results`, sample: results },
            ...itemFields,
        ],
    };
}

function currentItemLabel(itemVar: string, batched: boolean): string {
    return batched
        ? t('mobile.flow.group.current_batch', 'Current batch (loop.{name})', { name: itemVar })
        : t('mobile.flow.group.current_item', 'Current item (loop.{name})', { name: itemVar });
}

/** The per-item loop variable of a step that iterates itself (`step.forEach`). */
export function describeForEachItem(
    step: FlowNode,
    definition: FlowDefinition,
    toolToOutput: ToolOutputMap,
    sampleRoot: unknown = null,
): VariableGroup {
    const fe = step.forEach || {};
    const itemVar = fe.itemVar || 'item';
    const sample = inferLoopItemSample(fe.overRef, definition, toolToOutput, sampleRoot) || {};
    return {
        id: `${step.id}__foreach`,
        label: t('mobile.flow.group.current_item_short', 'Current item ({name})', { name: itemVar }),
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        sample,
        fields: sampleToFields(sample, `loop.${itemVar}`),
    };
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
    const elementSample = inferLoopItemSample(node.overRef, definition, toolToOutput, sampleRoot) || {};
    return {
        id: node.id,
        label: currentItemLabel(itemVar, batched),
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        sample: batched ? [elementSample] : elementSample,
        fields: batched || !isObj(elementSample) ? [] : sampleToFields(elementSample, `loop.${itemVar}`),
    };
}

/** The first plain-object element of the array at `ref` in the accumulated root. */
function elementFromRoot(ref: string, sampleRoot: unknown): unknown {
    if (!sampleRoot) return null;
    const list = walkPath(ref.trim(), sampleRoot);
    if (!Array.isArray(list) || list.length === 0) return null;
    return isObj(list[0]) ? list[0] : null;
}

/** One path segment of the catalog-sample fallback (`key`, `key[*]`, `key[3]`). */
function stepSegment(cur: unknown, segment: string): unknown {
    const isWild = /\[\*\]$/.test(segment);
    const idxMatch = /\[(\d+)\]$/.exec(segment);
    const key = segment.replace(/\[(?:\*|\d+)\]$/, '');
    let next = cur;
    if (key) next = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
    if (next == null) return null;
    if (isWild) return Array.isArray(next) ? next[0] : null;
    if (idxMatch) return Array.isArray(next) ? next[Number(idxMatch[1])] : null;
    return next;
}

function catalogRoot(node: FlowNode, sample: unknown): unknown {
    if (!node.forEach?.overRef) return sample;
    return { iterations: 0, succeeded: 0, failed: 0, results: [{ index: 0, item: {}, output: sample, status: 'success' }] };
}

/** Fallback: walk the source step's catalog outputSample (forEach-aware). */
function elementFromCatalog(ref: string, definition: FlowDefinition, toolToOutput: ToolOutputMap): unknown {
    const m = /^steps\.([^.]+)\.output(?:\.(.+))?$/.exec(ref);
    if (!m) return null;
    const node = (definition.steps || []).find((s) => s.id === m[1]);
    if (!node) return null;
    const meta = toolToOutput.get(node.tool as string);
    if (meta?.sample == null) return null;
    let cur = catalogRoot(node, meta.sample);
    for (const segment of m[2] ? m[2].split('.') : []) {
        if (cur == null) return null;
        cur = stepSegment(cur, segment);
        if (cur == null) return null;
    }
    if (Array.isArray(cur)) return cur.length > 0 ? cur[0] : null;
    return cur && typeof cur === 'object' ? cur : null;
}

/**
 * `steps.s1.output.results` → the shape of one element: first from the
 * accumulated design-time root (covers every node type), then from the source
 * step's catalog sample. Null when it cannot be resolved.
 */
export function inferLoopItemSample(
    overRef: unknown,
    definition: FlowDefinition,
    toolToOutput: ToolOutputMap,
    sampleRoot: unknown = null,
): unknown {
    if (typeof overRef !== 'string' || !overRef) return null;
    const fromRoot = elementFromRoot(overRef, sampleRoot);
    if (fromRoot) return fromRoot;
    return elementFromCatalog(overRef, definition, toolToOutput);
}

/** `results` → `result`, `categories` → `category`: a loop variable name. */
export function suggestItemVar(key: unknown): string {
    const s = String(key || '').trim();
    if (!s) return 'item';
    if (/ies$/.test(s)) return s.slice(0, -3) + 'y';
    if (/(s|es)$/.test(s) && s.length > 2) return s.replace(/(es|s)$/, '');
    return s;
}
