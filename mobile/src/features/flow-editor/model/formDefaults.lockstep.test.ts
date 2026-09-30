/**
 * The form defaults are the web's, evaluated from their own source.
 *
 * They live in agent-hub's settings/FormBuilderFields.jsx, a component file
 * (React, Lucide, the form renderer) that neither Metro nor this Jest can
 * load. So this test cuts the three functions and THEME_PRESETS out of the
 * text, evaluates them, and compares their results with the port's.
 */

import fs from 'node:fs';
import path from 'node:path';

import { defaultFormDeclaration, defaultFormEndingDeclaration, defaultFormPageDeclaration, THEME_PRESETS, themePresetLabel } from './formDefaults';

const SETTINGS = path.resolve(__dirname, '../../../../../agent-hub/src/components/automation/Builder/flow/settings');
const src = fs.readFileSync(path.join(SETTINGS, 'FormBuilderFields.jsx'), 'utf8');

/** The text from `start` to the end of its top-level block. */
function cut(start: string, end: string): string {
    const at = src.indexOf(start);
    if (at < 0) throw new Error(`${start} is gone from FormBuilderFields.jsx`);
    return src.slice(at, src.indexOf(end, at) + end.length);
}

const presetsSrc = cut('export const THEME_PRESETS = [', '\n];').replace('export const THEME_PRESETS = ', 'return ');
const fnSrc = (name: string) => cut(`export function ${name}() {`, '\n}\n').replace('export function', 'function');

const WEB_PRESETS = new Function(presetsSrc)();
const web = (name: string) => new Function('THEME_PRESETS', `${fnSrc(name)}\nreturn ${name}();`)(WEB_PRESETS);

describe('form defaults', () => {
    it('THEME_PRESETS is the web list', () => {
        expect(THEME_PRESETS).toEqual(WEB_PRESETS);
    });

    it.each([
        ['defaultFormDeclaration', defaultFormDeclaration],
        ['defaultFormPageDeclaration', defaultFormPageDeclaration],
        ['defaultFormEndingDeclaration', defaultFormEndingDeclaration],
    ] as const)('%s matches the web', (name, port) => {
        expect(port()).toEqual(web(name));
    });

    it('names a preset in the viewer\'s language', () => {
        const night = THEME_PRESETS[3] as (typeof THEME_PRESETS)[number];
        expect(themePresetLabel(night)).toBe('Night');
        expect(themePresetLabel(night, (key, fb) => `${key}=${fb}`)).toBe('mobile.flow.form_theme.night=Night');
    });

    it('hands out a fresh object every time', () => {
        const a = defaultFormDeclaration();
        (a.fields as unknown[]).push('x');
        (a.theme as { primary: string }).primary = 'red';
        expect(defaultFormDeclaration().fields).toHaveLength(3);
        expect(THEME_PRESETS[0]?.theme.primary).toBe('#0F766E');
    });

    it('the web trigger form still takes its default from FormBuilderFields', () => {
        const trigger = fs.readFileSync(path.join(SETTINGS, 'FormTriggerFields.jsx'), 'utf8');
        expect(trigger).toMatch(/import FormBuilderFields, \{ defaultFormDeclaration \} from '\.\/FormBuilderFields'/);
    });
});
