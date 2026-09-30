/**
 * The form page editor's pure half, held to the web's
 * (agent-hub `Builder/flow/settings/FormBuilderFields.jsx`, a component file
 * neither Metro nor this Jest can load): the answer types, the theme knobs and
 * colours are the web's lists; `slugifyFieldName` and `normaliseOptions` are
 * cut out of the web's source and run beside the port; and the page edits
 * behave as the web's `addField` / `addFileField` / `moveField` do.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FormField } from '@/features/flow-editor/model';

import { activePreset, addDisplayField, addQuestion, COLOR_PRESETS, FIELD_TYPES, moveField, normaliseOptions, optionLines, slugifyFieldName, THEME_KNOBS } from './formModel';

const src = fs.readFileSync(
    path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow/settings/FormBuilderFields.jsx'),
    'utf8',
);

const block = (start: string, end: string) => {
    const at = src.indexOf(start);
    if (at < 0) throw new Error(`${start} is gone`);
    return src.slice(at, src.indexOf(end, at) + end.length);
};
const fn = (name: string) => block(`export function ${name}(`, '\n}\n').replace('export function', 'function');
const web = new Function(`${fn('slugifyFieldName')}\n${fn('normaliseOptions')}\nreturn { slugifyFieldName, normaliseOptions };`)();

describe('the form page against FormBuilderFields.jsx', () => {
    it('offers the web’s answer types, in its order and words', () => {
        const list = block('const FIELD_TYPES = [', '];');
        const webTypes = [...list.matchAll(/\{ value: '([^']+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
        expect(FIELD_TYPES.map((f) => [f.value, f.label[1]])).toEqual(webTypes);
    });

    it('has the web’s theme knobs and accent colours', () => {
        const knobs = block('const THEME_KNOBS = [', '];');
        const webKnobs = [...knobs.matchAll(/\{ key: '(\w+)', label: '([^']+)', values: \[([^\]]*)\] \}/g)].map((m) => [
            m[1],
            m[2],
            [...(m[3] as string).matchAll(/'([^']+)'/g)].map((v) => v[1]),
        ]);
        expect(THEME_KNOBS.map((k) => [k.key, k.label[1], [...k.values]])).toEqual(webKnobs);
        const colours = block('const COLOR_PRESETS = [', '];');
        expect([...COLOR_PRESETS]).toEqual([...colours.matchAll(/'(#[0-9A-F]{6})'/g)].map((m) => m[1]));
    });

    it.each([
        ['Your name', []],
        ['Your name', ['your_name']],
        ['2nd signature', []],
        ['  Email — work!  ', []],
        ['', []],
        ['Crème brûlée', []],
        ['a'.repeat(80), []],
        ['Amount', ['amount', 'amount_2']],
    ] as const)('slugifyFieldName(%j) with %j taken', (label, taken) => {
        expect(slugifyFieldName(label, new Set(taken))).toBe(web.slugifyFieldName(label, new Set(taken)));
    });

    it.each([[['a', 'b']], [[{ value: 'x' }, { value: 'y', label: 'Y' }, { label: 'no value' }, null]], ['nope'], [undefined]])('normaliseOptions(%j)', (options) => {
        expect(normaliseOptions(options)).toEqual(web.normaliseOptions(options));
    });
});

describe('page edits', () => {
    const fields: FormField[] = [
        { name: 'new_question', type: 'text', label: 'New question' },
        { name: 'email', type: 'email', label: 'Email' },
    ];

    it('names a new question after its label, past the names in use', () => {
        expect(addQuestion(fields, 'New question').at(-1)).toEqual({ name: 'new_question_2', type: 'text', label: 'New question', required: false, placeholder: '' });
    });

    it('adds a download or an Open in Notebooks with an empty file to point at', () => {
        expect(addDisplayField(fields, 'notebook', 'Open in Notebooks').at(-1)).toEqual({ name: 'open_in_notebooks', type: 'notebook', label: 'Open in Notebooks', fileId: '' });
    });

    it('moves whole questions and never past the ends', () => {
        expect(moveField(fields, 0, 1).map((f) => f.name)).toEqual(['email', 'new_question']);
        expect(moveField(fields, 0, -1)).toBe(fields);
    });

    it('lists a dropdown’s stored choices without blanks', () => {
        expect(optionLines(['Red', { value: 'Green' }, { label: 'B' }, ''])).toEqual(['Red', 'Green']);
    });

    it('recognises a preset only when every knob matches', () => {
        const presets = [{ id: 'clean', theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' } }];
        expect(activePreset(presets, { ...presets[0]?.theme } as never)?.id).toBe('clean');
        expect(activePreset(presets, { ...presets[0]?.theme, radius: 'xl' } as never)).toBeNull();
    });
});
