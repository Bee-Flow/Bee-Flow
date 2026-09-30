/**
 * The declared-parameter designer held to the web's
 * (agent-hub `Builder/flow/settings/fieldDesigner.jsx`, a component file):
 * `nameProblem`, `applyBindingRename` and its outcome sentences are cut out of
 * the web's source and run beside the port — with the web's own
 * renameFormField helpers — on the same cases; the two type lists are the
 * web's (triggerEditors.jsx), in order.
 */

import fs from 'node:fs';
import path from 'node:path';

import { addParam, APP_TRIGGER_TYPES, applyBindingRename, CONTRACT_TYPES, nameProblem, PLACEHOLDER_NAME_RE } from './paramsModel';
import type { Msg } from '../declarative/spec';

const FLOW = path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow');
const src = fs.readFileSync(path.join(FLOW, 'settings/fieldDesigner.jsx'), 'utf8');
const editors = fs.readFileSync(path.join(FLOW, 'settings/triggerEditors.jsx'), 'utf8');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const renameHelpers = require(path.join(FLOW, 'renameFormField.js'));

function cut(name: string): string {
    const at = src.indexOf(`function ${name}(`);
    if (at < 0) throw new Error(`${name} is gone from fieldDesigner.jsx`);
    const start = src.lastIndexOf('\n', at) + 1;
    return src.slice(start, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
}

const web = new Function(
    'isValidFieldName',
    'fieldNameTaken',
    `${cut('nameProblem')}\n${cut('applyBindingRename')}\n${cut('renameNote')}\nreturn { nameProblem, applyBindingRename };`,
)(renameHelpers.isValidFieldName, renameHelpers.fieldNameTaken);

/** A Msg as the English it renders. */
const english = (m: Msg | null): string => {
    if (!m) return '';
    let out = m[1];
    for (const [k, v] of Object.entries(m[2] ?? {})) out = out.split(`{${k}}`).join(String(v));
    return out;
};

describe('the parameter designer against fieldDesigner.jsx', () => {
    it('keeps the web’s placeholder rule', () => {
        const webRe = /export const PLACEHOLDER_NAME_RE = (\/.+\/);/.exec(src)?.[1];
        expect(String(PLACEHOLDER_NAME_RE)).toBe(webRe);
    });

    it.each(['', 'ok_name', '_x', '2nd', 'klant-naam', 'a'.repeat(70)])('nameProblem(%j)', (name) => {
        expect(english(nameProblem(name))).toBe(web.nameProblem(name) ?? '');
    });

    const siblings = [{ name: 'email' }, { name: 'input1' }, { name: 'phone' }];
    const TAKEN: Msg = ['mobile.flow.params.taken', 'Another field here already binds that name.'];
    it.each([
        ['email', 'email', undefined, false],
        ['email', ' email_address ', undefined, true],
        ['email', '2nd', undefined, false],
        ['email', 'phone', undefined, false],
        ['email', 'contact', 3, false],
        ['email', 'contact', 1, false],
        ['email', 'contact', 0, false],
        ['input1', 'first', undefined, true],
    ] as const)('%s → %j (carry answers %j, orphan note %j)', (from, to, moved, orphanNote) => {
        const carry = moved === undefined ? null : () => moved;
        const ours = applyBindingRename({ from, to, siblings, carry, takenError: TAKEN, orphanNote });
        const theirs = web.applyBindingRename({ from, to, siblings, onRenameField: carry, takenError: TAKEN[1], orphanNote });
        expect({ ok: ours.ok, unchanged: ours.unchanged, name: ours.name, error: english(ours.error), note: english(ours.note) }).toEqual(theirs);
    });

    it('counts up past every name in use, never off the length', () => {
        const rows = [{ name: 'input1' }, { name: 'input3' }];
        expect(addParam(rows, 'input').at(-1)).toEqual({ name: 'input4', type: 'string', required: false });
        expect(addParam([], 'arg', { description: '' })).toEqual([{ name: 'arg1', type: 'string', required: false, description: '' }]);
    });

    const typeList = (name: string) => {
        const body = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(editors)?.[1] ?? '';
        return [...body.matchAll(/\{ value: '([^']+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
    };

    it('offers the web’s parameter types, in its order and words', () => {
        const label = (l: unknown) => (typeof l === 'string' ? l : (l as Msg)[1]);
        expect(CONTRACT_TYPES.map((o) => [o.value, label(o.label)])).toEqual(typeList('CONTRACT_TYPES'));
        expect(APP_TRIGGER_TYPES.map((o) => [o.value, label(o.label)])).toEqual(typeList('APP_TRIGGER_TYPES'));
    });
});
