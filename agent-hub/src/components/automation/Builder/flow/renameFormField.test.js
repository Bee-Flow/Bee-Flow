// @vitest-environment node
/**
 * Renaming a form question's binding name.
 *
 * The rename is only safe because it is the SAME edit as the rewrite, so most
 * of what is pinned here is the rewrite's aim: it must catch every spelling a
 * binding can use, and must not catch anything that merely looks like one.
 */

import { describe, it, expect } from 'vitest';
import { renameFormField, renameFieldPath, isValidFieldName, fieldNameTaken } from './renameFormField';

const def = () => ({
    trigger: {
        id: 'trg',
        type: 'trigger',
        kind: 'form',
        form: {
            title: 'Contact',
            fields: [
                { name: 'naam', type: 'text', label: 'Jouw naam' },
                { name: 'naam_bedrijf', type: 'text', label: 'Bedrijf' },
            ],
        },
    },
    steps: [
        {
            id: 'ai_1',
            type: 'ai_step',
            inputs: {
                who: { kind: 'ref', path: 'trigger.output.naam' },
                greet: { kind: 'template', value: 'Dag {{trigger.output.naam}}, van {{ trigger.output.naam_bedrijf }}' },
                deep: { nested: [{ kind: 'ref', path: 'trigger.output.naam.text' }] },
            },
        },
        {
            id: 'if_1',
            type: 'condition',
            when: { kind: 'expr', value: 'trigger.output.naam == "trigger.output.naam"' },
        },
    ],
    layers: {
        L1: {
            steps: [
                { id: 'ai_2', type: 'ai_step', inputs: { x: { kind: 'ref', path: 'trigger.output["naam"]' } } },
            ],
        },
    },
});

describe('renameFormField — the declaration and the references move together', () => {
    it('renames the field and every binding that points at it', () => {
        const { definition, rewritten, ok } = renameFormField(def(), { base: 'trigger.output', from: 'naam', to: 'contactpersoon' });
        expect(ok).toBe(true);
        expect(definition.trigger.form.fields[0].name).toBe('contactpersoon');
        expect(definition.steps[0].inputs.who.path).toBe('trigger.output.contactpersoon');
        expect(definition.steps[0].inputs.deep.nested[0].path).toBe('trigger.output.contactpersoon.text');
        expect(definition.layers.L1.steps[0].inputs.x.path).toBe('trigger.output["contactpersoon"]');
        // ref + template + deep ref + expr + the flowlet's ref
        expect(rewritten).toBe(5);
    });

    it('never touches a name that merely starts the same', () => {
        // `naam_bedrijf` is a different question; a substring rewrite would
        // quietly repoint it at a field that does not exist.
        const { definition } = renameFormField(def(), { base: 'trigger.output', from: 'naam', to: 'contactpersoon' });
        expect(definition.trigger.form.fields[1].name).toBe('naam_bedrijf');
        expect(definition.steps[0].inputs.greet.value).toBe('Dag {{trigger.output.contactpersoon}}, van {{ trigger.output.naam_bedrijf }}');
    });

    it('leaves string literals inside an expression alone', () => {
        const { definition } = renameFormField(def(), { base: 'trigger.output', from: 'naam', to: 'contactpersoon' });
        expect(definition.steps[1].when.value).toBe('trigger.output.contactpersoon == "trigger.output.naam"');
    });

    it('does not mutate the definition it was given', () => {
        const original = def();
        renameFormField(original, { base: 'trigger.output', from: 'naam', to: 'contactpersoon' });
        expect(original.trigger.form.fields[0].name).toBe('naam');
        expect(original.steps[0].inputs.who.path).toBe('trigger.output.naam');
    });

    it('only renames the page it was asked about', () => {
        // Two questions on two pages can share a slug; they are different
        // answers and a rename of one must leave the other where it is.
        const two = {
            trigger: { id: 'trg', kind: 'form', form: { fields: [{ name: 'antwoord', type: 'text', label: 'A' }] } },
            steps: [
                { id: 'fp_2', type: 'form_page', form: { fields: [{ name: 'antwoord', type: 'text', label: 'B' }] } },
                { id: 'ai_1', type: 'ai_step', inputs: {
                    a: { kind: 'ref', path: 'trigger.output.antwoord' },
                    b: { kind: 'ref', path: 'steps.fp_2.output.antwoord' },
                } },
            ],
        };
        const { definition, rewritten } = renameFormField(two, { base: 'steps.fp_2.output', from: 'antwoord', to: 'adres' });
        expect(rewritten).toBe(1);
        expect(definition.steps[0].form.fields[0].name).toBe('adres');
        expect(definition.trigger.form.fields[0].name).toBe('antwoord');
        expect(definition.steps[1].inputs.a.path).toBe('trigger.output.antwoord');
        expect(definition.steps[1].inputs.b.path).toBe('steps.fp_2.output.adres');
    });

    it('moves a pick and the value parts of a composed text, on this base only', () => {
        const from = (root, path, id) => (id ? { root, id, path } : { root, path });
        const d = {
            trigger: { kind: 'form', form: { fields: [{ name: 'naam', type: 'text', label: 'N' }] } },
            steps: [
                { id: 'fp_2', type: 'form_page', form: { fields: [{ name: 'naam', type: 'text', label: 'M' }] } },
                { id: 'ai_1', type: 'ai_step', inputs: {
                    who: { kind: 'pick', v: 1, from: from('trigger', ['naam']), take: 'one', as: 'native' },
                    page: { kind: 'pick', v: 1, from: from('steps', ['naam'], 'fp_2'), take: 'one', as: 'native' },
                    other: { kind: 'pick', v: 1, from: from('trigger', ['naam_bedrijf']), take: 'one', as: 'native' },
                    deep: { kind: 'pick', v: 1, from: from('trigger', ['x', 'naam']), take: 'one', as: 'native' },
                    hi: { kind: 'compose', v: 1, parts: ['Dag ', { from: from('trigger', ['naam', 'voor']), take: 'one', as: 'text' }, '!'] },
                } },
            ],
        };
        const { definition, rewritten } = renameFormField(d, { base: 'trigger.output', from: 'naam', to: 'voornaam' });
        const inputs = definition.steps[1].inputs;
        expect(inputs.who.from).toEqual(from('trigger', ['voornaam']));
        expect(inputs.hi.parts).toEqual(['Dag ', { from: from('trigger', ['voornaam', 'voor']), take: 'one', as: 'text' }, '!']);
        expect(inputs.page.from).toEqual(from('steps', ['naam'], 'fp_2'));
        expect(inputs.other.from.path).toEqual(['naam_bedrijf']);
        expect(inputs.deep.from.path).toEqual(['x', 'naam']);
        expect(rewritten).toBe(2);
        const page = renameFormField(d, { base: 'steps.fp_2.output', from: 'naam', to: 'adres' });
        expect(page.definition.steps[1].inputs.page.from).toEqual(from('steps', ['adres'], 'fp_2'));
        expect(page.definition.steps[1].inputs.who.from).toEqual(from('trigger', ['naam']));
        expect(page.rewritten).toBe(1);
    });

    it('leaves a literal payload verbatim — it ships as typed', () => {
        const d = { trigger: { kind: 'form', form: { fields: [{ name: 'naam', type: 'text', label: 'N' }] } },
            steps: [{ id: 's', inputs: { note: { kind: 'literal', value: 'zie trigger.output.naam' } } }] };
        const { definition } = renameFormField(d, { base: 'trigger.output', from: 'naam', to: 'x' });
        expect(definition.steps[0].inputs.note.value).toBe('zie trigger.output.naam');
    });

    it('refuses a name the server would reject, and changes nothing', () => {
        for (const bad of ['1naam', '_naam', 'met spatie', 'met-streep', '', 'x'.repeat(61)]) {
            const out = renameFormField(def(), { base: 'trigger.output', from: 'naam', to: bad });
            expect(out.ok).toBe(false);
            expect(out.rewritten).toBe(0);
            expect(out.definition.trigger.form.fields[0].name).toBe('naam');
        }
    });

    it('renaming to the same name is a no-op, not an error', () => {
        const out = renameFormField(def(), { base: 'trigger.output', from: 'naam', to: 'naam' });
        expect(out.ok).toBe(true);
        expect(out.rewritten).toBe(0);
    });
});

describe('renameFieldPath — whole segments only', () => {
    it('matches the field at the end, before a dot, and before a bracket', () => {
        expect(renameFieldPath('trigger.output.a', 'trigger.output', 'a', 'b')).toBe('trigger.output.b');
        expect(renameFieldPath('trigger.output.a.text', 'trigger.output', 'a', 'b')).toBe('trigger.output.b.text');
        expect(renameFieldPath('trigger.output.a[0]', 'trigger.output', 'a', 'b')).toBe('trigger.output.b[0]');
        expect(renameFieldPath("trigger.output['a']", 'trigger.output', 'a', 'b')).toBe("trigger.output['b']");
    });

    it('refuses a longer name, a different base, and a non-string', () => {
        expect(renameFieldPath('trigger.output.abc', 'trigger.output', 'a', 'b')).toBe('trigger.output.abc');
        expect(renameFieldPath('steps.x.output.a', 'trigger.output', 'a', 'b')).toBe('steps.x.output.a');
        expect(renameFieldPath('trigger.headers.a', 'trigger.output', 'a', 'b')).toBe('trigger.headers.a');
        expect(renameFieldPath(null, 'trigger.output', 'a', 'b')).toBe(null);
    });
});

describe('the guards around the gesture', () => {
    it('isValidFieldName mirrors the server PARAM_NAME_RE', () => {
        expect(isValidFieldName('naam')).toBe(true);
        expect(isValidFieldName('naam_2')).toBe(true);
        expect(isValidFieldName('_naam')).toBe(false);
        expect(isValidFieldName('2naam')).toBe(false);
    });

    it('a name already used on the page is taken — the server would drop one of them', () => {
        const fields = [{ name: 'a' }, { name: 'b' }];
        expect(fieldNameTaken(fields, 'b', 'a')).toBe(true);
        expect(fieldNameTaken(fields, 'a', 'a')).toBe(false);
        expect(fieldNameTaken(fields, 'c', 'a')).toBe(false);
    });
});
