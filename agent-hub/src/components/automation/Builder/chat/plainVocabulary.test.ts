import { describe, it, expect } from 'vitest';
import { describeBinding, fieldPathLabel, plainTerm, plainText, stepLabelsOf } from './plainVocabulary';
import { nodeTypeLabel } from '../flow/nodeDefs';

describe('the plain vocabulary', () => {
    const labels = new Map([['trg', 'How it starts'], ['read_1', 'Read the form'], ['mail_2', 'Send the reply']]);

    it('names the builder\'s own terms in the person\'s words, through keys', () => {
        expect(plainTerm('trigger')).toBe('how it starts');
        expect(plainTerm('dry_run')).toBe('test run');
        expect(plainTerm('proposal')).toBe('preview');
        expect(plainTerm('apply')).toBe('make the change');
        expect(plainTerm('finalize')).toBe('saved, not switched on yet');
        expect(plainTerm('uses_from', null, { field: 'Email', source: '"Read the form"' })).toBe('uses Email from "Read the form"');
        const seen: string[] = [];
        plainTerm('trigger', (k, d) => { seen.push(k); return d; });
        expect(seen).toEqual(['handover.vocab.trigger']);
    });

    it('reads a reference as "uses … from …", never as its path', () => {
        expect(describeBinding({ kind: 'ref', path: 'steps.read_1.output.email' }, labels)).toBe('uses Email from "Read the form"');
        expect(describeBinding({ kind: 'ref', path: 'trigger.output.sender' }, labels)).toBe('uses Sender from how it starts');
        expect(describeBinding({ kind: 'ref', path: 'steps.read_1.output' }, labels)).toBe('uses what "Read the form" gave');
        expect(describeBinding({ kind: 'ref', path: 'loop.line.sku' }, labels)).toBe('uses Sku from each line');
        // A step that is gone has no name to give: no id instead.
        expect(describeBinding({ kind: 'ref', path: 'steps.gone_9.output.x' }, labels)).toBe('uses X from an earlier step');
    });

    it('names references inside a template and a formula, and leaves a fixed value alone', () => {
        expect(describeBinding({ kind: 'template', value: 'Hi {{steps.read_1.output.name}}' }, labels)).not.toContain('steps.');
        expect(describeBinding({ kind: 'expr', value: 'steps.read_1.output.total > 10' }, labels)).not.toContain('read_1');
        expect(describeBinding({ kind: 'literal', value: 'Hello' })).toBe('Hello');
        expect(describeBinding('Plain text')).toBe('Plain text');
        expect(describeBinding(undefined)).toBe('—');
    });

    it('names a changed field by its key, not its storage path', () => {
        expect(fieldPathLabel(['settings', 'to'])).toBe('To');
        expect(fieldPathLabel(['input', 'from', 'emailAddress'])).toBe('From › Email address');
    });

    it('labels steps by id: the label, the palette label, or "How it starts" for a trigger', () => {
        const map = stepLabelsOf({ trigger: { id: 't', type: 'trigger' }, steps: [{ id: 'a', label: 'Fetch' }, { id: 'b', type: 'http_request' }] });
        expect(map.get('t')).toBe('How it starts');
        expect(map.get('a')).toBe('Fetch');
        expect(map.get('b')).toBe(nodeTypeLabel('http_request'));
    });

    it('rewrites step references and known ids in a refusal, and nothing else', () => {
        expect(plainText('Field steps.read_1.output.email is empty in mail_2.', labels)).toBe('Field Email from "Read the form" is empty in "Send the reply".');
        expect(plainText('The trigger has no schedule.', labels)).toBe('The trigger has no schedule.');
        expect(plainText('steps.unknown.output.x', labels)).toBe('steps.unknown.output.x');
        expect(plainText('x', null)).toBe('x');
    });
});
