import { THEME_PRESETS } from './formStyle/stylePresets';

/**
 * The declarations a form starts from, and the label → name rule. Pure data:
 * everything that needs a fresh form (dropping a trigger node, the start
 * dialog, the route hand-off) imports it from here, so the form EDITOR
 * (FormBuilderFields, with the live preview and the style editor) stays a
 * lazy chunk that loads when a form is actually edited.
 */

export interface FormFieldDeclaration {
    name: string;
    type: string;
    label: string;
    required: boolean;
    placeholder: string;
}

export interface FormDeclaration {
    title: string;
    description: string;
    submitLabel?: string;
    successMessage?: string;
    fields: FormFieldDeclaration[];
    theme: Record<string, unknown> | null;
}

/** The form a freshly-dropped trigger node starts with — already publishable. */
export function defaultFormDeclaration(): FormDeclaration {
    return {
        title: 'Get in touch',
        description: '',
        submitLabel: 'Submit',
        successMessage: 'Thanks — we got your answer.',
        fields: [
            { name: 'name', type: 'text', label: 'Your name', required: true, placeholder: '' },
            { name: 'email', type: 'email', label: 'Your email', required: true, placeholder: '' },
            { name: 'message', type: 'textarea', label: 'How can we help?', required: false, placeholder: '' },
        ],
        theme: { ...THEME_PRESETS[0].theme },
    };
}

/**
 * A mid-flow page asking for one more thing. `theme: null` means "inherit the
 * trigger's" — the server merges it, so pages match without the author having
 * to restyle each one.
 */
export function defaultFormPageDeclaration(): FormDeclaration {
    return {
        title: 'One more thing',
        description: '',
        submitLabel: 'Continue',
        successMessage: 'Thanks!',
        fields: [{ name: 'answer', type: 'text', label: 'Your answer', required: true, placeholder: '' }],
        theme: null,
    };
}

/** The closing page. No questions — its job is to tell the visitor what happened. */
export function defaultFormEndingDeclaration(): FormDeclaration {
    return {
        title: 'All done',
        description: 'Thanks — here is what we did:\n',
        fields: [],
        theme: null,
    };
}

/**
 * Label → field name, once. Must produce a valid identifier for the server's
 * PARAM_NAME_RE (letter first, then letters/digits/underscore).
 */
export function slugifyFieldName(label: unknown, taken: ReadonlySet<unknown> = new Set()): string {
    const base = String(label || '')
        .normalize('NFKD')
        .replace(/[^\w\s]/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[^a-z]+/, '')
        .slice(0, 55) || 'field';
    if (!taken.has(base)) return base;
    for (let i = 2; i < 200; i += 1) {
        const candidate = `${base}_${i}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${base}_${Date.now().toString(36)}`;
}
