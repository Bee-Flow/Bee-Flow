/**
 * The steps that decide where the run goes next or who it waits on: Condition,
 * Switch, Wait, Approval, and the Flowlet call whose output shape is the
 * flowlet's own declared contract.
 */
import { appendKey } from '@shared/expr/path.mjs';
import { fieldFor, isRecord } from './fieldTree';
import { routeFieldLabel } from './routeFieldLabel';
import { resolveElementSample, sampleToFields, samplePlaceholderFor } from './sampleFields';

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

/**
 * A Switch's output. Decided for the whole run it is `{ matched, value,
 * branch, matchesByCase }`. Working through a list (W6) it has no `value`:
 * the rows of the source list land per output at `matchesByCase.<name>` and
 * `matchesByCase.default` (Otherwise), each row with the source list's item
 * fields, next to `total`, `branch` and `matched`.
 */
export function describeSwitch(node, sampleRoot = null) {
    const base = `steps.${node.id}.output`;
    const caseNames = (Array.isArray(node.cases) ? node.cases : []).map(c => c?.name).filter(Boolean);
    const outputs = [...caseNames, 'default'];
    const listMode = typeof node.arrayRef === 'string' && node.arrayRef.trim() !== '';
    const element = listMode ? resolveElementSample(node.arrayRef, sampleRoot) : null;
    const rows = element != null ? [element] : [];
    const matchesByCase = Object.fromEntries(outputs.map(n => [n, rows]));
    const matched = caseNames[0] || 'case1';
    const branch = `case:${matched}`;
    // A case is named in plain words ("High priority"): its path is built by
    // the runtime grammar's writer, never by concatenation. Each carries its
    // output's name as its label ("pdf", "Otherwise"), never the key.
    const caseFields = outputs.map((n) => {
        const path = appendKey(appendKey(base, 'matchesByCase'), n);
        return isRecord(element) ? fieldFor(`matchesByCase.${n}`, path, rows) : { key: `matchesByCase.${n}`, path, sample: rows, ...routeFieldLabel(path) };
    });
    if (listMode) {
        return {
            id: node.id,
            label: node.label || 'Switch',
            kind: 'switch',
            basePath: base,
            sample: { matched, branch, total: 0, matchesByCase },
            fields: [
                { key: 'matched', path: `${base}.matched`, sample: matched },
                { key: 'branch', path: `${base}.branch`, sample: branch },
                { key: 'total', path: `${base}.total`, sample: 0 },
                ...caseFields,
            ],
        };
    }
    return {
        id: node.id,
        label: node.label || 'Switch',
        kind: 'switch',
        basePath: base,
        sample: { matched, value: null, branch, matchesByCase },
        fields: [
            { key: 'matched', path: `${base}.matched`, sample: matched },
            { key: 'value', path: `${base}.value`, sample: null },
            { key: 'branch', path: `${base}.branch`, sample: branch },
            ...caseFields,
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
