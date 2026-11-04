/**
 * A form's LOOK beyond the shared theme: `form.style`, the sibling of
 * `form.theme` on a form trigger and on a form_page step.
 *
 * The theme (core/cms/themeSpec.js) is the vocabulary App Studio, the CMS and
 * forms share, so form-only knobs never go there; they live here. The client
 * mirror is agent-hub/src/components/forms/formStyleVars.ts (the knobs as CSS
 * variables; the sanitiser's copy is formCssSanitizer.ts next to it, so a
 * stale server never ships unsanitised CSS): keep them in lockstep.
 *
 *   style: {
 *     font?: 'system' | 'inter' | 'serif' | 'mono' | 'rounded'   curated families, nothing loaded
 *     width?: 'narrow' | 'medium' | 'wide'                        card max-width 480 / 640 / 860 px
 *     align?: 'left' | 'center'                                   title + intro alignment
 *     cardColor?, textColor?, labelColor?: '#rrggbb' | null
 *     labelStyle?: 'above' | 'inside'                             inside = floating label
 *     inputStyle?: 'outlined' | 'filled' | 'underlined'
 *     button?: { width?: 'auto' | 'full', shape?: 'square' | 'rounded' | 'pill', textColor?: '#rrggbb' | null }
 *     logoUrl?: string | null        a same-origin path ('/...'), at most 512 characters
 *     footerText?: string | null     plain text, at most 300 characters
 *     customCss?: string | null      at most 20 000 characters, sanitised (sanitizeFormCss)
 *   }
 *
 * Every key is optional and absent means "the renderer's default": unlike the
 * theme, canonicalizeFormStyle never fills a default in, so a form that never
 * set a knob canonicalizes to `{}` and a form_page inheriting the trigger's
 * style gets exactly what the trigger declared. `null` is the documented way
 * to clear an inherited value.
 *
 * CUSTOM CSS is sanitised by core/forms/formCss.mts (sanitizeFormCss, re-exported
 * here): it is served to anonymous visitors.
 */

import { createRequire } from 'node:module';
import type * as FormCss from './formCss.mts';

// Loaded through require, not `import … from './formCss.mts'`: agent-hub's
// typecheck reaches this file (through automation/formTriggerContract.js) and
// refuses a VALUE import path ending in .mts (TS5097, no
// allowImportingTsExtensions there); a type-only import is fine.
const nodeRequire = createRequire(import.meta.url);
const formCss = nodeRequire('./formCss.mts') as typeof FormCss;

export const FORM_CSS_MAX_CHARS: number = formCss.FORM_CSS_MAX_CHARS;
export const sanitizeFormCss: typeof FormCss.sanitizeFormCss = formCss.sanitizeFormCss;
export type { SanitizedCss } from './formCss.mts';

export const FORM_LOGO_URL_MAX_CHARS = 512;
export const FORM_FOOTER_TEXT_MAX_CHARS = 300;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type EnumSpec = { readonly type: 'enum'; readonly values: readonly string[] };
type ColorSpec = { readonly type: 'color' };
type PathSpec = { readonly type: 'path'; readonly max: number };
type TextSpec = { readonly type: 'text'; readonly max: number };
type CssSpec = { readonly type: 'css'; readonly max: number };
type ButtonSpec = { readonly type: 'object'; readonly fields: Readonly<Record<string, EnumSpec | ColorSpec>> };
export type FormStyleFieldSpec = EnumSpec | ColorSpec | PathSpec | TextSpec | CssSpec | ButtonSpec;

export const FORM_STYLE_SPEC: Readonly<Record<string, FormStyleFieldSpec>> = Object.freeze({
    font: { type: 'enum', values: ['system', 'inter', 'serif', 'mono', 'rounded'] },
    width: { type: 'enum', values: ['narrow', 'medium', 'wide'] },
    align: { type: 'enum', values: ['left', 'center'] },
    cardColor: { type: 'color' },
    textColor: { type: 'color' },
    labelColor: { type: 'color' },
    labelStyle: { type: 'enum', values: ['above', 'inside'] },
    inputStyle: { type: 'enum', values: ['outlined', 'filled', 'underlined'] },
    button: {
        type: 'object',
        fields: {
            width: { type: 'enum', values: ['auto', 'full'] },
            shape: { type: 'enum', values: ['square', 'rounded', 'pill'] },
            textColor: { type: 'color' },
        },
    },
    logoUrl: { type: 'path', max: FORM_LOGO_URL_MAX_CHARS },
    footerText: { type: 'text', max: FORM_FOOTER_TEXT_MAX_CHARS },
    customCss: { type: 'css', max: FORM_CSS_MAX_CHARS },
});

export type FormButtonStyle = { width?: string; shape?: string; textColor?: string };
export type FormStyle = {
    font?: string; width?: string; align?: string;
    cardColor?: string; textColor?: string; labelColor?: string;
    labelStyle?: string; inputStyle?: string;
    button?: FormButtonStyle;
    logoUrl?: string; footerText?: string; customCss?: string;
};
export type FormStyleIssue = { code: string; path: string; message: string; hint: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A same-origin path: starts with one '/', and nothing a browser would read
 * as another host ('//x', '/\x'), a control character, whitespace, a quote or
 * an angle bracket.
 */
export function isSameOriginPath(value: unknown): value is string {
    return typeof value === 'string'
        && value.length <= FORM_LOGO_URL_MAX_CHARS
        && /^\/(?![/\\])[^\s\u0000-\u001f\u007f"'<>\\]*$/.test(value);
}

function validValue(spec: EnumSpec | ColorSpec, v: unknown): v is string {
    return spec.type === 'color'
        ? typeof v === 'string' && HEX_RE.test(v)
        : typeof v === 'string' && spec.values.includes(v);
}

function canonicalButton(spec: ButtonSpec, v: unknown): FormButtonStyle | undefined {
    if (!isPlainObject(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, sub] of Object.entries(spec.fields)) {
        const value = v[key];
        if (validValue(sub, value)) out[key] = value;
    }
    return Object.keys(out).length ? out : undefined;
}

function canonicalField(spec: FormStyleFieldSpec, v: unknown): string | FormButtonStyle | undefined {
    switch (spec.type) {
        case 'enum':
        case 'color':
            return validValue(spec, v) ? v : undefined;
        case 'path':
            return isSameOriginPath(v) ? v : undefined;
        case 'text': {
            if (typeof v !== 'string' || v.length > spec.max) return undefined;
            const text = v.trim();
            return text || undefined;
        }
        case 'css': {
            if (typeof v !== 'string' || v.length > spec.max) return undefined;
            const { css } = sanitizeFormCss(v);
            return css.trim() ? css : undefined;
        }
        case 'object':
            return canonicalButton(spec, v);
    }
}

/**
 * A page's own theme or style over the one it inherits from the form's
 * trigger: per key, the page's wins (`null` included, which clears); without
 * its own, the inherited one as it is.
 */
export function overInherited(own: unknown, inherited: unknown): unknown {
    if (!isPlainObject(own)) return inherited;
    return { ...(isPlainObject(inherited) ? inherited : {}), ...own };
}

/**
 * The style a renderer may use: unknown keys dropped, an invalid or cleared
 * (null) value dropped, the custom CSS sanitised. Never emits a key that was
 * not set to a valid value, so `{}` means "all defaults".
 */
export function canonicalizeFormStyle(style: unknown): FormStyle {
    const out: Record<string, string | FormButtonStyle> = {};
    if (!isPlainObject(style)) return out;
    for (const [key, spec] of Object.entries(FORM_STYLE_SPEC)) {
        const value = canonicalField(spec, style[key]);
        if (value !== undefined) out[key] = value;
    }
    return out as FormStyle;
}

/**
 * `{ style }` for a rendered form, or `{}` when no knob is set: a form without
 * a style renders byte-identically to before style existed.
 */
export function styleEntry(style: unknown): { style?: FormStyle } {
    const canonical = canonicalizeFormStyle(style);
    return Object.keys(canonical).length ? { style: canonical } : {};
}

function enumOrColorIssue(spec: EnumSpec | ColorSpec, key: string, path: string, value: unknown): FormStyleIssue | null {
    if (value === null && spec.type === 'color') return null; // "clear it": legal
    if (validValue(spec, value)) return null;
    return spec.type === 'color'
        ? { code: 'style_color', path, message: `"${key}" must be a #rrggbb colour (or null to clear it).`, hint: 'Use a 6-digit hex literal like #0F766E.' }
        : { code: 'style_enum', path, message: `"${key}" must be one of ${spec.values.join(', ')}.`, hint: `Got ${JSON.stringify(value)}.` };
}

function buttonIssues(spec: ButtonSpec, value: unknown, path: string): FormStyleIssue[] {
    if (value === null) return [];
    if (!isPlainObject(value)) {
        return [{ code: 'style_shape', path, message: 'button must be an object.', hint: `Use the keys: ${Object.keys(spec.fields).join(', ')}.` }];
    }
    const issues: FormStyleIssue[] = [];
    for (const [key, sub] of Object.entries(value)) {
        const subSpec = spec.fields[key];
        if (!subSpec) {
            issues.push({ code: 'style_unknown_key', path: `${path}.${key}`, message: `Unknown button key "${key}".`, hint: `Use one of: ${Object.keys(spec.fields).join(', ')}.` });
            continue;
        }
        const issue = enumOrColorIssue(subSpec, key, `${path}.${key}`, sub);
        if (issue) issues.push(issue);
    }
    return issues;
}

function fieldIssues(spec: FormStyleFieldSpec, key: string, value: unknown, path: string): FormStyleIssue[] {
    if (spec.type === 'object') return buttonIssues(spec, value, path);
    if (spec.type === 'enum' || spec.type === 'color') {
        const issue = enumOrColorIssue(spec, key, path, value);
        return issue ? [issue] : [];
    }
    if (value === null) return [];
    if (spec.type === 'path') {
        return isSameOriginPath(value) ? [] : [{
            code: 'style_logo_url', path,
            message: `${key} must be a path on this server that starts with "/" (at most ${spec.max} characters).`,
            hint: 'Upload the logo to Bee Flow and use its address, e.g. /api/assets/logo.png. Addresses on other sites are not allowed: they would tell that site who opens the form.',
        }];
    }
    if (typeof value !== 'string') {
        return [{ code: 'style_text', path, message: `${key} must be text, or null.`, hint: `Got ${JSON.stringify(value)}.` }];
    }
    if (value.length > spec.max) {
        return [{
            code: spec.type === 'css' ? 'style_css_too_long' : 'style_text_too_long', path,
            message: `${key} is ${value.length} characters; the limit is ${spec.max}.`,
            hint: 'Shorten it.',
        }];
    }
    return [];
}

/**
 * Issue records `[{ code, path, message, hint }]`, the shape validateTheme
 * returns; empty = valid. Removals by the CSS sanitiser are NOT issues: the
 * renderer drops them and the editor shows them as a warning.
 */
export function validateFormStyle(style: unknown, pathPrefix = 'style'): FormStyleIssue[] {
    if (style === undefined || style === null) return [];
    if (!isPlainObject(style)) {
        return [{ code: 'style_shape', path: pathPrefix, message: 'style must be an object.', hint: `Use the keys: ${Object.keys(FORM_STYLE_SPEC).join(', ')}.` }];
    }
    const issues: FormStyleIssue[] = [];
    for (const [key, value] of Object.entries(style)) {
        const spec = FORM_STYLE_SPEC[key];
        if (!spec) {
            issues.push({ code: 'style_unknown_key', path: `${pathPrefix}.${key}`, message: `Unknown style key "${key}".`, hint: `Use one of: ${Object.keys(FORM_STYLE_SPEC).join(', ')}.` });
            continue;
        }
        issues.push(...fieldIssues(spec, key, value, `${pathPrefix}.${key}`));
    }
    return issues;
}
