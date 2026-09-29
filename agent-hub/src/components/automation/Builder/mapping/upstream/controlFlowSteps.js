/**
 * The steps that decide where the run goes next or who it waits on: Condition,
 * Switch, Wait, Approval, and the Flowlet call whose output shape is the
 * flowlet's own declared contract.
 */
import { sampleToFields, samplePlaceholderFor } from './sampleFields';

export function describeCondition(node) {
    // Mirrors execCondition's real output: { branch, value, expr } (C24) —
    // `value` (the boolean) and `expr` were real but invisible to the picker.
    const sample = { branch: 'then', value: true, expr: node.expr || '' };
    return {
        id: node.id,
        label: node.label || 'Condition',
        kind: 'condition',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

export function describeSwitch(node) {
    const base = `steps.${node.id}.output`;
    const caseNames = (Array.isArray(node.cases) ? node.cases : []).map(c => c?.name).filter(Boolean);
    // Collection mode (switch on a table column, e.g. results[*].subject):
    // the matching ROWS land per case at output.matchesByCase.<name> — offer
    // those as bindable lists so a downstream Loop/Lists node can consume
    // exactly the rows that matched.
    const matchesByCase = Object.fromEntries([...caseNames, 'default'].map(n => [n, []]));
    const sample = { matched: caseNames[0] || 'case1', value: null, branch: `case:${caseNames[0] || 'case1'}`, matchesByCase };
    return {
        id: node.id,
        label: node.label || 'Switch',
        kind: 'switch',
        basePath: base,
        sample,
        fields: [
            { key: 'matched', path: `${base}.matched`, sample: sample.matched },
            { key: 'value', path: `${base}.value`, sample: null },
            { key: 'branch', path: `${base}.branch`, sample: sample.branch },
            ...[...caseNames, 'default'].map(n => ({
                key: `matchesByCase.${n}`,
                path: `${base}.matchesByCase.${n}`,
                sample: [],
            })),
        ],
    };
}

export function describeWait(node) {
    const sample = { waitedSeconds: node.seconds || 0 };
    return {
        id: node.id,
        label: node.label || 'Wait',
        kind: 'wait',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

/**
 * An approval's output is the DECISION, mirroring the object the approve route
 * builds and the runner injects at the resume boundary.
 *
 * `approved` is always true for anything downstream: a rejection ends the run,
 * so no step after this one ever executes with approved:false. Binding a
 * "rejected" branch off this field is therefore a branch that can never fire —
 * worth knowing before someone builds one.
 */
export function describeApproval(node) {
    const sample = {
        approved: true,
        by: 'usr_a1b2c3',
        reason: 'Checked with finance',
        decidedAt: '2026-01-31T09:15:00.000Z',
    };
    return {
        id: node.id,
        label: node.label || 'Approval',
        kind: 'approval',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

/**
 * A call_layer node's output is the referenced flowlet's layer_output
 * field set, derived live from `definition.layers[layerKey]` (inline
 * flowlets — no denormalised contracts on the step). When the definition
 * in hand carries no layers map (scoped inside a flowlet, where a sibling
 * call_layer can appear upstream) the field list is empty; the user can
 * still bind by typing a path manually.
 */
export function describeCallLayer(node, definition) {
    const layer = definition?.layers?.[node.layerKey];
    const out = layer ? (layer.steps || []).find(s => s?.type === 'layer_output') : null;
    const fieldNames = out?.fields && typeof out.fields === 'object' ? Object.keys(out.fields) : [];
    const sample = Object.fromEntries(fieldNames.map(name => [name, samplePlaceholderFor('string')]));
    return {
        id: node.id,
        label: node.label || layer?.title || 'Flowlet',
        kind: 'call_layer',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}
