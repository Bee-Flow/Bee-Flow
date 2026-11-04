/**
 * The form page editor's pure half, held to the web's: the answer types are
 * the list in agent-hub `Builder/flow/settings/FormBuilderFields.jsx` (a
 * component file neither Metro nor this Jest can load); the theme knobs are
 * the rows of the style editor's Look and Layout groups (`formStyle/`) and the
 * colours its `stylePresets.ts` list; `slugifyFieldName` is run from
 * `formDeclarations.ts` and `normaliseOptions` from
 * `components/forms/formOptions.ts`, both beside the port; and the page edits
 * behave as the web's `addField` / `addFileField` / `moveField` do.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import type { FormField } from '@/features/flow-editor/model';
import { loadWebModule } from '@/shared/testing/webModule';

import { activePreset, addDisplayField, addQuestion, COLOR_PRESETS, DISPLAY_FIELD_TYPES, FIELD_TYPES, moveField, normaliseOptions, optionLines, slugifyFieldName, THEME_KNOBS } from './formModel';

const SETTINGS = path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow/settings');
const src = fs.readFileSync(path.join(SETTINGS, 'FormBuilderFields.jsx'), 'utf8');
const styleSrc = (file: string) => fs.readFileSync(path.join(SETTINGS, 'formStyle', file), 'utf8');

const block = (start: string, end: string, text = src) => {
    const at = text.indexOf(start);
    if (at < 0) throw new Error(`${start} is gone`);
    return text.slice(at, text.indexOf(end, at) + end.length);
};

/**
 * The theme knobs of one style group: every `<OptionRow … value={theme.<key>} …/>`,
 * as [key, [label key, English], values]. The values are its `optionsOf(t, …, [list])`
 * list, or the `{ value: '…' }` entries of an inline `options` list.
 */
function themeKnobs(file: string): [string, [string, string], string[]][] {
    const rows = [...styleSrc(file).matchAll(/<OptionRow\b[\s\S]*?\/>/g)].map((m) => m[0]);
    return rows.flatMap((row): [string, [string, string], string[]][] => {
        const key = /value=\{theme\.(\w+)\}/.exec(row)?.[1];
        if (!key) return [];
        const label = /label=\{t\('([\w.]+)', '([^']+)'\)\}/.exec(row);
        if (!label) throw new Error(`the ${key} row of ${file} has no t() label`);
        const listed = /optionsOf\(t, '\w+', \[([^\]]*)\]\)/.exec(row)?.[1];
        const values = listed !== undefined ? [...listed.matchAll(/'([^']+)'/g)] : [...row.matchAll(/\{ value: '([^']+)'/g)];
        return [[key, [label[1] as string, label[2] as string], values.map((v) => v[1] as string)]];
    });
}
// normaliseOptions moved to the form renderer's own module (agent-hub
// `components/forms/formOptions.ts`, shared by the editor preview and every
// form page, BFSF-483): run that file itself, its types stripped.
const optionsSrc = fs.readFileSync(path.resolve(__dirname, '../../../../../../../agent-hub/src/components/forms/formOptions.ts'), 'utf8');
const optionsJs = ts.transpileModule(optionsSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
const optionsModule: { exports: { normaliseOptions?: (o: unknown) => unknown } } = { exports: {} };
new Function('module', 'exports', optionsJs)(optionsModule, optionsModule.exports);
const web = {
    slugifyFieldName: loadWebModule<{ slugifyFieldName: (label: unknown, taken?: ReadonlySet<unknown>) => string }>(path.join(SETTINGS, 'formDeclarations.ts')).slugifyFieldName,
    normaliseOptions: optionsModule.exports.normaliseOptions as (o: unknown) => unknown,
};

describe('the form page against the web’s form editor', () => {
    it('offers the web’s answer types, in its order and words', () => {
        const list = block('const FIELD_TYPES = [', '];');
        const webTypes = [...list.matchAll(/\{ value: '([^']+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
        expect(FIELD_TYPES.map((f) => [f.value, f.label[1]])).toEqual(webTypes);
    });

    it('has the web’s theme knobs and accent colours', () => {
        // The style editor shows its Look group (light / dark) above its Layout group.
        const webKnobs = [...themeKnobs('LookGroup.tsx'), ...themeKnobs('LayoutGroup.tsx')];
        expect(webKnobs.map(([key]) => key)).toEqual(['appearance', 'radius', 'density', 'fontScale']);
        expect(THEME_KNOBS.map((k) => [k.key, [...k.label], [...k.values]])).toEqual(webKnobs);
        const colours = block('export const COLOR_PRESETS = [', '];', styleSrc('stylePresets.ts'));
        const webColours = [...colours.matchAll(/'(#[0-9A-F]{6})'/g)].map((m) => m[1]);
        expect(webColours.length).toBeGreaterThan(0);
        expect([...COLOR_PRESETS]).toEqual(webColours);
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

    it('has the web’s display types (the fields that give instead of ask)', () => {
        const preview = fs.readFileSync(
            path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow/settings/formPreview.ts'),
            'utf8',
        );
        const list = /export const DISPLAY_FIELD_TYPES = \[([^\]]*)\]/.exec(preview)?.[1] ?? '';
        expect([...DISPLAY_FIELD_TYPES]).toEqual([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    });

    it.each([
        [['a', 'b']],
        [[{ value: 'x' }, { value: 'y', label: 'Y' }, { label: 'no value' }, null]],
        [[{ value: 'p', label: 'P', hint: 'a short note' }, { value: 'q', hint: '' }, { value: 'r', hint: 3 }]],
        ['nope'],
        [undefined],
    ])('normaliseOptions(%j)', (options) => {
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
