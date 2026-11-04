/**
 * The form defaults are the web's, evaluated from their own source.
 *
 * They live in agent-hub's settings/formDeclarations.ts (pure, TypeScript),
 * which takes THEME_PRESETS from settings/formStyle/stylePresets.ts. Both are
 * run here as the web wrote them (types stripped, the preset list bound from
 * its own file) and their results compared with the port's.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadWebModule } from '@/shared/testing/webModule';

import { defaultFormDeclaration, defaultFormEndingDeclaration, defaultFormPageDeclaration, THEME_PRESETS, themePresetLabel } from './formDefaults';

const SETTINGS = path.resolve(__dirname, '../../../../../agent-hub/src/components/automation/Builder/flow/settings');

type Declaration = () => unknown;
const declarations = loadWebModule<Record<string, Declaration>>(path.join(SETTINGS, 'formDeclarations.ts'));
const { THEME_PRESETS: WEB_PRESETS } = loadWebModule<{ THEME_PRESETS: unknown[] }>(path.join(SETTINGS, 'formStyle/stylePresets.ts'));
const web = (name: string) => {
    const fn = declarations[name];
    if (typeof fn !== 'function') throw new Error(`${name} is gone from formDeclarations.ts`);
    return fn();
};

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

    it('the web trigger form still takes its default from formDeclarations', () => {
        const trigger = fs.readFileSync(path.join(SETTINGS, 'FormTriggerFields.tsx'), 'utf8');
        expect(trigger).toMatch(/import \{ defaultFormDeclaration \} from '\.\/formDeclarations'/);
    });
});
