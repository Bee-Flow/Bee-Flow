/**
 * The steps that hand a COLLECTION downstream — Filter, Limit, Dedupe,
 * Aggregate, Summarize; Set and Date & Time in list mode; Parse JSON in its
 * grouped mode. Most emit the `{ items, count }` wrapper, and
 * `collectionItemsFields` keeps the source element's fields visible through it
 * as `…output.items[*].<key>`. Port of agent-hub
 * `Builder/mapping/upstream/collectionSteps.js`.
 */

import { translate as t } from '@/core/i18n';
import { nodeDefaultLabel } from '@/features/flow-editor/model/nodeDefs';
import { SET_STEP_NAME } from '@/features/flow-editor/model/stepDisplayName';

import { datetimeTargetColumn, isDateTimeListMode } from '../flowDeps/datetimeTarget';
import { applyOpsToSampleRow } from '../flowDeps/setOperations';
import { isObj } from '../json';
import type { FlowNode, VariableField, VariableGroup } from '../types';
import { walkPath } from '../walkPath';
import { resolveElementSample, stepGroup } from './sampleFields';

export { describeParseJson } from './parseJsonStep';

function collectionItemsFields(node: FlowNode, elementSample: unknown, wrapperSample: Record<string, unknown>): VariableField[] {
    const base = `steps.${node.id}.output`;
    return Object.entries(wrapperSample).map(([k, v]) => {
        const field: VariableField = { key: k, path: `${base}.${k}`, sample: v };
        if (k === 'items' && isObj(elementSample)) {
            field.children = Object.entries(elementSample).map(([ck, cv]) => ({ key: ck, path: `${base}.items[*].${ck}`, sample: cv }));
        }
        return field;
    });
}

/** A Set field's binding, previewed against the accumulated sample tree (C25). */
function resolveSetValue(v: unknown, root: unknown): unknown {
    if (v == null) return '<set>';
    if (typeof v !== 'object') return v;
    const b = v as { kind?: string; path?: unknown; value?: unknown };
    if (b.kind === 'literal') return b.value ?? '<set>';
    if (b.kind === 'ref' && root) {
        const resolved = walkPath(String(b.path || ''), root);
        if (resolved !== undefined) return resolved;
    }
    if (b.kind === 'template' || b.kind === 'expr') return '<text>';
    return '<set>';
}

function baseRowOf(element: unknown): Record<string, unknown> {
    if (isObj(element)) return { ...element };
    return element != null ? { value: element } : {};
}

/** LIST MODE: `{items, count}`, each row the source element + fields, reshaped by the operations. */
function describeSetList(node: FlowNode, entries: [string, unknown][], sampleRoot: unknown, label: string): VariableGroup {
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const rowRoot = { ...(isObj(sampleRoot) ? sampleRoot : {}), item: element, _index: 0 };
    const added = Object.fromEntries(entries.map(([k, v]) => [k, resolveSetValue(v, rowRoot)]));
    const row = applyOpsToSampleRow({ ...baseRowOf(element), ...added }, node.operations);
    const hasRow = Object.keys(row).length > 0;
    const sample = { items: hasRow ? [row] : [], count: 0 };
    return stepGroup(node, { label, kind: 'set' }, sample, collectionItemsFields(node, hasRow ? row : null, sample));
}

/** Set output = the assembled fields; list mode = the edited rows. */
export function describeSet(node: FlowNode, sampleRoot: unknown = null): VariableGroup {
    const entries = node.fields && typeof node.fields === 'object' ? Object.entries(node.fields) : [];
    const label = node.label || SET_STEP_NAME;
    if (typeof node.arrayRef === 'string') return describeSetList(node, entries, sampleRoot, label);
    const sample = Object.fromEntries(entries.map(([k, v]) => [k, resolveSetValue(v, sampleRoot)]));
    return stepGroup(node, { label, kind: 'set' }, sample);
}

function dateTimeSample(node: FlowNode): Record<string, unknown> {
    const op = node.op || 'now';
    if (op === 'diff') return { value: 0, unit: node.unit || 'days' };
    if (op === 'extract') return { value: 0, part: node.part || 'year' };
    return { iso: '2026-05-13T09:00:00.000Z', value: '2026-05-13T09:00:00.000Z' };
}

/** Date & Time: one date, or in list mode each source row plus one new column. */
export function describeDateTime(node: FlowNode, sampleRoot: unknown = null): VariableGroup {
    const sample = dateTimeSample(node);
    const label = node.label || t('mobile.flow.group.datetime', 'Date & Time');
    if (!isDateTimeListMode(node)) return stepGroup(node, { label, kind: 'datetime' }, sample);
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const row = { ...baseRowOf(element), [datetimeTargetColumn(node)]: sample.value };
    const listSample = { items: [row], count: 0 };
    return stepGroup(node, { label, kind: 'datetime' }, listSample, collectionItemsFields(node, row, listSample));
}

/** Filter / Limit keep the source element's shape inside `{ items, count }`. */
export function describeCollectionItems(node: FlowNode, label: string, sampleRoot: unknown = null): VariableGroup {
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const sample = { items: element != null ? [element] : [], count: 0 };
    return stepGroup(node, { label: node.label || label, kind: 'collection' }, sample, collectionItemsFields(node, element, sample));
}

export function describeDedupe(node: FlowNode, sampleRoot: unknown = null): VariableGroup {
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const sample = { items: element != null ? [element] : [], removed: 0 };
    const label = node.label || nodeDefaultLabel('dedupe', t);
    return stepGroup(node, { label, kind: 'collection' }, sample, collectionItemsFields(node, element, sample));
}

export function describeAggregate(node: FlowNode, sampleRoot: unknown = null): VariableGroup {
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const field = node.field as string | undefined;
    const plucked = element && typeof element === 'object' && field ? (element as Record<string, unknown>)[field] : undefined;
    const sample = { values: plucked !== undefined ? [plucked] : [], count: 0 };
    return stepGroup(node, { label: node.label || t('mobile.flow.group.aggregate', 'Aggregate'), kind: 'collection' }, sample);
}

export function describeSummarize(node: FlowNode): VariableGroup {
    const sample = { result: 0, op: node.op || 'sum', count: 0 };
    return stepGroup(node, { label: node.label || t('mobile.flow.group.summarize', 'Summarize'), kind: 'collection' }, sample);
}

