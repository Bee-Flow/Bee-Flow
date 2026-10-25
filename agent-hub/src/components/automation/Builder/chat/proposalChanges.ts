import { deepEqual } from '../../../../utils/deepEqual';
import type { FlowDefinition, FlowStep } from '../flow/types';

export interface ProposalChange {
    id: string;
    scope: string;
    kind: 'added' | 'changed' | 'removed';
    label: string | undefined;
    before?: FlowStep;
    after?: FlowStep;
}

export interface FieldChange {
    path: string[];
    before: unknown;
    after: unknown;
}

interface FieldTree {
    [key: string]: unknown;
}

interface ReviewedProposalInput {
    definition: FlowDefinition;
    baseDefinition?: FlowDefinition | null;
    [key: string]: unknown;
}

export function proposalChanges(base: FlowDefinition | null | undefined, next: FlowDefinition | null | undefined): ProposalChange[] {
    const changes: ProposalChange[] = [];
    function graph(a: FlowDefinition = {}, b: FlowDefinition = {}, scope = '') {
        const before = [a.trigger, ...(a.triggers || []), ...(a.steps || [])].filter(Boolean) as FlowStep[];
        const after = [b.trigger, ...(b.triggers || []), ...(b.steps || [])].filter(Boolean) as FlowStep[];
        for (const step of after) {
            const old = before.find((s: FlowStep) => s.id === step.id);
            if (!old || !deepEqual(old, step)) changes.push({ id: step.id, scope, kind: old ? 'changed' : 'added', label: step.label || step.type || step.kind, before: old, after: step });
        }
        for (const step of before) if (!after.some((s: FlowStep) => s.id === step.id)) changes.push({ id: step.id, scope, kind: 'removed', label: step.label || step.type || step.kind, before: step });
        for (const key of new Set([...Object.keys(a.layers || {}), ...Object.keys(b.layers || {})])) graph(a.layers?.[key], b.layers?.[key], key);
    }
    graph(base || {}, next || {});
    return changes;
}

// Bindings are one editable field, rather than separate kind/path/value edits.
function fieldChanges(before: unknown, after: unknown, path: string[] = []): FieldChange[] {
    if (deepEqual(before, after)) return [];
    const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) && !(value as FieldTree).kind;
    if (object(before) && object(after)) return [...new Set([...Object.keys(before as FieldTree), ...Object.keys(after as FieldTree)])]
        .flatMap((key: string) => fieldChanges((before as FieldTree)[key], (after as FieldTree)[key], [...path, key]));
    return [{ path, before, after }];
}

export function proposalFields(change: ProposalChange): FieldChange[] {
    if (change.kind !== 'changed') return [];
    return ['settings', 'input'].flatMap((key: string) => fieldChanges((change.before as FlowStep)[key] || {}, (change.after as FlowStep)[key] || {}, [key]));
}

export function reviewedProposal(proposal: ReviewedProposalInput, excluded: Set<string>): FlowDefinition {
    const definition = structuredClone(proposal.definition);
    for (const change of proposalChanges(proposal.baseDefinition, proposal.definition)) {
        const graph = change.scope ? definition.layers?.[change.scope] : definition;
        const node = [graph?.trigger, ...(graph?.triggers || []), ...(graph?.steps || [])].find((n: FlowStep | null | undefined) => n?.id === change.id);
        if (!node) continue;
        for (const field of proposalFields(change)) {
            if (!excluded.has(`${change.scope}:${change.id}:${field.path.join('.')}`)) continue;
            let target: FieldTree = node;
            for (const key of field.path.slice(0, -1)) { target[key] ||= {}; target = target[key] as FieldTree; }
            const key = field.path.at(-1) as string;
            if (field.before === undefined) delete target[key];
            else target[key] = structuredClone(field.before);
        }
    }
    return definition;
}
