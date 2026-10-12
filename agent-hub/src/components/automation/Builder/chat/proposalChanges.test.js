import { describe, expect, it } from 'vitest';
import { proposalChanges, proposalFields, reviewedProposal } from './proposalChanges';

describe('proposal review', () => {
    const baseDefinition = { trigger: { id: 'trigger' }, steps: [{ id: 'mail', label: 'Send email', settings: { to: { kind: 'ref', path: 'trigger.output.sender' }, subject: 'Old' } }], layers: {} };
    const definition = structuredClone(baseDefinition);
    definition.steps[0].settings.to = { kind: 'ref', path: 'steps.reader.output.email' };
    definition.steps[0].settings.subject = 'New';
    definition.steps.push({ id: 'log', label: 'Log result', settings: {} });
    const proposal = { baseDefinition, definition };

    it('groups binding edits into one field and reports added steps', () => {
        const changes = proposalChanges(baseDefinition, definition);
        expect(changes.map(c => c.kind)).toEqual(['changed', 'added']);
        expect(proposalFields(changes[0]).map(f => f.path)).toEqual([['settings', 'to'], ['settings', 'subject']]);
    });

    it('applies only checked fields while keeping structural changes and the original immutable', () => {
        const reviewed = reviewedProposal(proposal, new Set([':mail:settings.to']));
        expect(reviewed.steps[0].settings.to).toEqual(baseDefinition.steps[0].settings.to);
        expect(reviewed.steps[0].settings.subject).toBe('New');
        expect(reviewed.steps[1].id).toBe('log');
        expect(definition.steps[0].settings.to.path).toBe('steps.reader.output.email');
        expect(baseDefinition.steps[0].settings.subject).toBe('Old');
    });

    it('can skip additions and removals of individual settings', () => {
        const next = structuredClone(baseDefinition);
        delete next.steps[0].settings.subject;
        next.steps[0].settings.cc = 'cc@example.test';
        const reviewed = reviewedProposal({ baseDefinition, definition: next }, new Set([':mail:settings.subject', ':mail:settings.cc']));
        expect(reviewed).toEqual(baseDefinition);
    });

    it('reviews mappings inside flowlets without changing the root step', () => {
        const before = { ...baseDefinition, layers: { child: { steps: [{ id: 'inside', settings: { value: 'old' } }] } } };
        const after = structuredClone(before);
        after.layers.child.steps[0].settings.value = 'new';
        expect(reviewedProposal({ baseDefinition: before, definition: after }, new Set(['child:inside:settings.value']))).toEqual(before);
    });
});
