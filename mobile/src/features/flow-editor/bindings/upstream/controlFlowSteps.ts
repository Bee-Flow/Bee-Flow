/**
 * The steps that decide where the run goes or who it waits on: Condition,
 * Switch, Wait, Approval, and the Flowlet call whose output is the flowlet's
 * own declared contract. Port of agent-hub
 * `Builder/mapping/upstream/controlFlowSteps.js`.
 */

import { translate as t } from '@/core/i18n';
import { nodeDefaultLabel } from '@/features/flow-editor/model/nodeDefs';
import { appendKey } from '@/shared/expr';

import { arr, isObj } from '../json';
import type { FlowDefinition, FlowNode, RouteCase, VariableGroup } from '../types';
import { fieldFor } from './fieldTree';
import { routeFieldLabel } from './routeFieldLabel';
import { resolveElementSample, samplePlaceholderFor, stepGroup } from './sampleFields';

/** execCondition's real output: `{ branch, value, expr }`. */
export function describeCondition(node: FlowNode): VariableGroup {
    const sample = { branch: 'then', value: true, expr: node.expr || '' };
    return stepGroup(node, { label: node.label || nodeDefaultLabel('condition', t), kind: 'condition' }, sample);
}

interface SwitchShape {
    base: string;
    first: string;
    all: string[];
    label: string;
}

/**
 * A Condition with several outputs working through a list (execSwitch's
 * collection mode): `{ matched, branch, total, matchesByCase }`, each output a
 * list whose rows have the source list's item fields — so the step after
 * output "pdf" is offered `matchesByCase.pdf`, never every row. No `value`:
 * list mode has none.
 */
function describeListSwitch(node: FlowNode, shape: SwitchShape, sampleRoot: unknown): VariableGroup {
    const { base, first, all, label } = shape;
    const element = resolveElementSample(node.arrayRef, sampleRoot);
    const rows = element != null ? [element] : [];
    const sample = { matched: first, branch: `case:${first}`, total: 0, matchesByCase: Object.fromEntries(all.map((n) => [n, rows])) };
    const byCase = appendKey(base, 'matchesByCase');
    return stepGroup(node, { label, kind: 'switch' }, sample, [
        { key: 'matched', path: `${base}.matched`, sample: sample.matched },
        { key: 'branch', path: `${base}.branch`, sample: sample.branch },
        { key: 'total', path: `${base}.total`, sample: 0 },
        // Each output carries its name as its label ("pdf", "Otherwise"; routeFieldLabel), never the key.
        ...all.map((n) =>
            isObj(element) ? fieldFor(`matchesByCase.${n}`, appendKey(byCase, n), rows) : { key: `matchesByCase.${n}`, path: appendKey(byCase, n), sample: rows, ...routeFieldLabel(appendKey(byCase, n)) },
        ),
    ]);
}

/** A switch's decision, plus the rows each case matched in collection mode. */
export function describeSwitch(node: FlowNode, sampleRoot: unknown = null): VariableGroup {
    const base = `steps.${node.id}.output`;
    const caseNames = arr<RouteCase>(node.cases).map((c) => c?.name).filter(Boolean) as string[];
    const first = caseNames[0] || 'case1';
    const all = [...caseNames, 'default'];
    const label = node.label || t('mobile.flow.group.switch', 'Switch');
    if (typeof node.arrayRef === 'string' && node.arrayRef.trim()) return describeListSwitch(node, { base, first, all, label }, sampleRoot);
    const sample = { matched: first, value: null, branch: `case:${first}`, matchesByCase: Object.fromEntries(all.map((n) => [n, []])) };
    return stepGroup(node, { label, kind: 'switch' }, sample, [
        { key: 'matched', path: `${base}.matched`, sample: sample.matched },
        { key: 'value', path: `${base}.value`, sample: null },
        { key: 'branch', path: `${base}.branch`, sample: sample.branch },
        // A case is named in plain words ("High priority"): the grammar's writer quotes it.
        ...all.map((n) => {
            const path = appendKey(appendKey(base, 'matchesByCase'), n);
            return { key: `matchesByCase.${n}`, path, sample: [], ...routeFieldLabel(path) };
        }),
    ]);
}

export function describeWait(node: FlowNode): VariableGroup {
    return stepGroup(node, { label: node.label || nodeDefaultLabel('wait', t), kind: 'wait' }, { waitedSeconds: node.seconds || 0 });
}

/**
 * An approval's output is the DECISION. `approved` is always true downstream:
 * a rejection ends the run.
 */
export function describeApproval(node: FlowNode): VariableGroup {
    const sample = {
        approved: true,
        by: 'usr_a1b2c3',
        reason: 'Checked with finance',
        decidedAt: '2026-01-31T09:15:00.000Z',
    };
    return stepGroup(node, { label: node.label || nodeDefaultLabel('approval', t), kind: 'approval' }, sample);
}

/**
 * A flowlet call's output is the referenced flowlet's layer_output fields,
 * derived live from `definition.layers[layerKey]`; empty when the definition in
 * hand has no layers (scoped inside a flowlet).
 */
export function describeCallLayer(node: FlowNode, definition: FlowDefinition | null | undefined): VariableGroup {
    const layer = typeof node.layerKey === 'string' ? definition?.layers?.[node.layerKey] : undefined;
    const out = layer ? (layer.steps || []).find((s) => s?.type === 'layer_output') : null;
    const fieldNames = isObj(out?.fields) ? Object.keys(out.fields) : [];
    const sample = Object.fromEntries(fieldNames.map((name) => [name, samplePlaceholderFor('string')]));
    const label = node.label || layer?.title || nodeDefaultLabel('call_layer', t);
    return stepGroup(node, { label, kind: 'call_layer' }, sample);
}
