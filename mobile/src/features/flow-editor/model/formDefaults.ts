/**
 * The forms a freshly dropped form trigger or form page starts with, and the
 * theme presets — split out of the web builder's settings/FormBuilderFields.jsx
 * (a component file the phone cannot import) so applyAddNode and the forms
 * builder share one copy. formDefaults.lockstep.test.ts evaluates the web
 * functions from their source and compares.
 *
 * Every default is already publishable: an empty form would be a dead end
 * that also blocks activation.
 */

import type { FormDeclaration, FormField, FormTheme, Translate } from './types';

export interface ThemePreset {
    id: string;
    label: string;
    theme: FormTheme;
}

type Look = [primary: string, radius: string, density: string, fontScale: string, appearance: string];
const theme = ([primary, radius, density, fontScale, appearance]: Look): FormTheme => ({ primary, radius, density, fontScale, appearance });

const PRESETS: readonly [id: string, english: string, look: FormTheme][] = [
    ['clean', 'Clean', theme(['#0F766E', 'md', 'comfortable', 'md', 'light'])],
    ['corporate', 'Corporate', theme(['#1D4ED8', 'sm', 'compact', 'sm', 'light'])],
    ['friendly', 'Friendly', theme(['#C2410C', 'xl', 'spacious', 'lg', 'light'])],
    ['night', 'Night', theme(['#0891B2', 'lg', 'comfortable', 'md', 'dark'])],
    ['system', 'Match visitor', theme(['#047857', 'md', 'comfortable', 'md', 'auto'])],
];

/** One click sets all five theme keys: "styling without code". */
export const THEME_PRESETS: readonly ThemePreset[] = PRESETS.map(([id, label, look]) => ({ id, label, theme: look }));

/** A preset's name in the viewer's language (`mobile.flow.form_theme.<id>`). */
export function themePresetLabel(preset: ThemePreset, t: Translate | null = null): string {
    return t ? t(`mobile.flow.form_theme.${preset.id}`, preset.label) : preset.label;
}

/**
 * The web's seed wording. It is not interface copy: it becomes the author's
 * own form, which they edit and which their visitors read — the same English
 * the web seeds, whatever language the author's app is in.
 */
const SEED = Object.freeze({
    getInTouch: 'Get in touch',
    submit: 'Submit',
    gotYourAnswer: 'Thanks — we got your answer.',
    yourName: 'Your name',
    yourEmail: 'Your email',
    howCanWeHelp: 'How can we help?',
    oneMoreThing: 'One more thing',
    continue: 'Continue',
    thanks: 'Thanks!',
    yourAnswer: 'Your answer',
    allDone: 'All done',
    whatWeDid: 'Thanks — here is what we did:\n',
});

const ask = (name: string, type: string, question: string, required: boolean): FormField => ({
    name, type, label: question, required, placeholder: '',
});

/** The form a freshly dropped form trigger starts with. */
export function defaultFormDeclaration(): FormDeclaration {
    return {
        title: SEED.getInTouch,
        description: '',
        submitLabel: SEED.submit,
        successMessage: SEED.gotYourAnswer,
        fields: [
            ask('name', 'text', SEED.yourName, true),
            ask('email', 'email', SEED.yourEmail, true),
            ask('message', 'textarea', SEED.howCanWeHelp, false),
        ],
        theme: { ...(THEME_PRESETS[0] as ThemePreset).theme },
    };
}

/**
 * A mid-flow page asking for one more thing. `theme: null` inherits the
 * trigger's, so pages match without being restyled one by one.
 */
export function defaultFormPageDeclaration(): FormDeclaration {
    return {
        title: SEED.oneMoreThing,
        description: '',
        submitLabel: SEED.continue,
        successMessage: SEED.thanks,
        fields: [ask('answer', 'text', SEED.yourAnswer, true)],
        theme: null,
    };
}

/** The closing page: no questions, it tells the visitor what happened. */
export function defaultFormEndingDeclaration(): FormDeclaration {
    return {
        title: SEED.allDone,
        description: SEED.whatWeDid,
        fields: [],
        theme: null,
    };
}
