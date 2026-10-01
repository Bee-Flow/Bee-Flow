/**
 * The steps that decide where the run goes next or who it waits on:
 * Condition, Switch, Wait, Approval, and the Flowlet call whose output shape
 * is the flowlet's own declared contract.
 */
import { samplePlaceholderFor } from '../fields.mjs';
import { groupLabel } from './env.mjs';
import { fieldAt, stepBase, stepGroup } from './sampleFields.mjs';

export function describeCondition(node, env) {
    // Mirrors execCondition's real output: { branch, value, expr }.
    const sample = { branch: 'then', value: true, expr: node.expr || '' };
    return stepGroup(node, node.label || groupLabel(env, 'node.condition', 'Condition'), 'condition', sample);
}

export function describeSwitch(node, env) {
    const caseNames = (Array.isArray(node.cases) ? node.cases : []).map(c => c?.name).filter(n => typeof n === 'string' && n);
    // Collection mode (switch on a table column): the matching ROWS land per
    // case at output.matchesByCase.<name>; offer those as bindable lists so a
    // downstream Loop/Lists node can consume exactly the rows that matched.
    const matchesByCase = Object.fromEntries([...caseNames, 'default'].map(n => [n, []]));
    const sample = { matched: caseNames[0] || 'case1', value: null, branch: `case:${caseNames[0] || 'case1'}`, matchesByCase };
    const base = stepBase(node.id);
    const fields = [
        fieldAt(base, ['matched'], sample.matched),
        fieldAt(base, ['value'], null),
        fieldAt(base, ['branch'], sample.branch),
        // A case name is written by formatSegment like any key: `Big order`
        // is `matchesByCase["Big order"]`, not a path the run rejects.
        ...[...caseNames, 'default'].map(n => {
            const f = fieldAt(base, ['matchesByCase', n], []);
            return f && { ...f, key: `matchesByCase.${n}` };
        }),
    ].filter(Boolean);
    return stepGroup(node, node.label || groupLabel(env, 'switch', 'Switch'), 'switch', sample, fields);
}

export function describeWait(node, env) {
    return stepGroup(node, node.label || groupLabel(env, 'node.wait', 'Wait'), 'wait', { waitedSeconds: node.seconds || 0 });
}

/**
 * An approval's output is the DECISION, mirroring the object the approve
 * route builds and the runner injects at the resume boundary. `approved` is
 * always true for anything downstream: a rejection ends the run.
 */
export function describeApproval(node, env) {
    const sample = {
        approved: true,
        by: 'usr_a1b2c3',
        reason: 'Checked with finance',
        decidedAt: '2026-01-31T09:15:00.000Z',
    };
    return stepGroup(node, node.label || groupLabel(env, 'node.approval', 'Approval'), 'approval', sample);
}

/**
 * A call_layer node's output is the referenced flowlet's layer_output field
 * set, derived live from `definition.layers[layerKey]`. Without a layers map
 * in hand (scoped inside a flowlet) the field list is empty.
 */
export function describeCallLayer(node, definition, env) {
    const layer = definition?.layers?.[node.layerKey];
    const out = layer ? (layer.steps || []).find(s => s?.type === 'layer_output') : null;
    const fieldNames = out?.fields && typeof out.fields === 'object' ? Object.keys(out.fields) : [];
    const sample = Object.fromEntries(fieldNames.map(name => [name, samplePlaceholderFor('string')]));
    return stepGroup(node, node.label || layer?.title || groupLabel(env, 'node.call_layer', 'Flowlet'), 'call_layer', sample);
}
