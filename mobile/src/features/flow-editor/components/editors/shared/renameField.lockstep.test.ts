/**
 * The binding rename, run beside the web's own (agent-hub
 * `Builder/flow/renameFormField.js`, pure, required as it is) on the same
 * definitions: a field renamed on page one and on a later page, in refs,
 * templates and expressions, in a flowlet, inside string literals that must
 * not move, and names that must be refused.
 */

import path from 'node:path';

import { fieldNameTaken, isValidFieldName, renameFieldPath, renameFormField } from './renameField';

const WEB = path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow/renameFormField.js');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const web = require(WEB);

const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'form', form: { fields: [{ name: 'naam', label: 'Naam' }, { name: 'naam_bedrijf' }] } },
    steps: [
        { id: 'fp_2', type: 'form_page', form: { fields: [{ name: 'naam' }] } },
        {
            id: 'n1',
            type: 'notification',
            title: { kind: 'template', value: 'Dag {{ trigger.output.naam }} van {{trigger.output.naam_bedrijf}}' },
            inputs: {
                a: { kind: 'ref', path: 'trigger.output.naam.text' },
                b: { kind: 'ref', path: "trigger.output['naam']" },
                c: { kind: 'expr', value: 'trigger.output.naam == "trigger.output.naam" && steps.x.output.trigger.output.naam' },
                d: { kind: 'literal', value: 'trigger.output.naam' },
                e: { kind: 'ref', path: 'steps.fp_2.output.naam' },
            },
        },
        { id: 'loop', type: 'loop', body: [{ id: 'b1', type: 'set', fields: { x: { kind: 'template', value: '{{steps.fp_2.output.naam}}' } } }] },
    ],
    edges: [],
    layers: { l1: { trigger: { id: 'lt' }, steps: [{ id: 'fp_2', form: { fields: [{ name: 'naam' }] } }], edges: [] } },
};

describe('renameFormField against the web', () => {
    it.each([
        ['trigger.output', 'naam', 'contact'],
        ['steps.fp_2.output', 'naam', 'antwoord'],
        ['trigger.output', 'naam', 'naam'],
        ['trigger.output', 'naam', '2nd'],
        ['trigger.output', 'missing', 'other'],
        ['', 'naam', 'x'],
    ])('base %s: %s → %s', (base, from, to) => {
        expect(renameFormField(DEF, { base, from, to })).toEqual(web.renameFormField(DEF, { base, from, to }));
    });

    it('refuses what the web refuses', () => {
        expect(renameFormField(null, { base: 'trigger.output', from: 'a', to: 'b' })).toEqual(web.renameFormField(null, { base: 'trigger.output', from: 'a', to: 'b' }));
    });

    it('never mutates the definition', () => {
        const before = JSON.stringify(DEF);
        renameFormField(DEF, { base: 'trigger.output', from: 'naam', to: 'contact' });
        expect(JSON.stringify(DEF)).toBe(before);
    });

    it.each([
        ['trigger.output.naam', 'trigger.output', 'naam', 'x'],
        ['trigger.output.naam_x', 'trigger.output', 'naam', 'x'],
        ['trigger.output["naam"].y', 'trigger.output', 'naam', 'x'],
        [42, 'trigger.output', 'naam', 'x'],
    ])('renameFieldPath(%j)', (p, base, from, to) => {
        expect(renameFieldPath(p, base, from, to)).toEqual(web.renameFieldPath(p, base, from, to));
    });

    it.each(['a', 'A_1', '_a', '1a', 'a-b', '', 'x'.repeat(61)])('isValidFieldName(%j)', (name) => {
        expect(isValidFieldName(name)).toBe(web.isValidFieldName(name));
    });

    it('fieldNameTaken', () => {
        const fields = [{ name: 'a' }, { name: 'b' }];
        for (const [to, from] of [['a', 'b'], ['a', 'a'], ['c', 'a']]) {
            expect(fieldNameTaken(fields, to as string, from as string)).toBe(web.fieldNameTaken(fields, to, from));
        }
    });
});
