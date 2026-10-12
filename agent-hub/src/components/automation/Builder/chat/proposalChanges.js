import { deepEqual } from '../../../../utils/deepEqual';

export function proposalChanges(base, next) {
    const changes = [];
    function graph(a = {}, b = {}, scope = '') {
        const before = [a.trigger, ...(a.triggers || []), ...(a.steps || [])].filter(Boolean);
        const after = [b.trigger, ...(b.triggers || []), ...(b.steps || [])].filter(Boolean);
        for (const step of after) {
            const old = before.find(s => s.id === step.id);
            if (!old || !deepEqual(old, step)) changes.push({ id: step.id, scope, kind: old ? 'changed' : 'added', label: step.label || step.type || step.kind, before: old, after: step });
        }
        for (const step of before) if (!after.some(s => s.id === step.id)) changes.push({ id: step.id, scope, kind: 'removed', label: step.label || step.type || step.kind, before: step });
        for (const key of new Set([...Object.keys(a.layers || {}), ...Object.keys(b.layers || {})])) graph(a.layers?.[key], b.layers?.[key], key);
    }
    graph(base || {}, next || {});
    return changes;
}

// Bindings are one editable field, rather than separate kind/path/value edits.
export function fieldChanges(before, after, path = []) {
    if (deepEqual(before, after)) return [];
    const object = value => value && typeof value === 'object' && !Array.isArray(value) && !value.kind;
    if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .flatMap(key => fieldChanges(before[key], after[key], [...path, key]));
    return [{ path, before, after }];
}

export function proposalFields(change) {
    if (change.kind !== 'changed') return [];
    return ['settings', 'input'].flatMap(key => fieldChanges(change.before[key] || {}, change.after[key] || {}, [key]));
}

export function reviewedProposal(proposal, excluded) {
    const definition = structuredClone(proposal.definition);
    for (const change of proposalChanges(proposal.baseDefinition, proposal.definition)) {
        const graph = change.scope ? definition.layers?.[change.scope] : definition;
        const node = [graph?.trigger, ...(graph?.triggers || []), ...(graph?.steps || [])].find(n => n?.id === change.id);
        if (!node) continue;
        for (const field of proposalFields(change)) {
            if (!excluded.has(`${change.scope}:${change.id}:${field.path.join('.')}`)) continue;
            let target = node;
            for (const key of field.path.slice(0, -1)) { target[key] ||= {}; target = target[key]; }
            const key = field.path.at(-1);
            if (field.before === undefined) delete target[key];
            else target[key] = structuredClone(field.before);
        }
    }
    return definition;
}
