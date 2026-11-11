/**
 * App Studio runtime: the font roles of an app's design (`design.fonts`, schema 3; the server's
 * table is server/appStudio/appFontRoles.js, pinned to this one by fontRoles.lockstep.test.ts).
 *
 *   design.fonts = { heading?, body?, mono? }, each a family id below or `asset:<id>`
 *
 * Every family here is a file Bee Flow serves itself (agent-hub/public/fonts, declared by
 * marketing/self-hosted-fonts.css); an uploaded font is read from the app's asset store
 * (AppFontFaces.tsx). Nothing is fetched from another host.
 *
 * On the app root a set role becomes a CSS variable and a class (fontRoleProps):
 *   body     the root's font-family, and --app-font-body
 *   heading  --app-font-heading and .app-fonts--heading: every h1-h6 of the app (fontRoles.css)
 *   mono     --app-font-mono and .app-fonts--mono: code, pre, kbd and samp
 * The text knob `font` (styleKnobs/text.ts) reads the same variables. A design without roles
 * adds nothing, so its app renders as before.
 */

import './fontRoles.css';
import type { CSSProperties } from 'react';
import { assetIdOf } from '../assets/assetUrl';

export type FontRole = 'heading' | 'body' | 'mono';
type FontKind = 'sans' | 'serif' | 'mono';

export const FONT_ROLES: readonly FontRole[] = ['heading', 'body', 'mono'];

/** id → the CSS family its @font-face rule declares and its kind (mirror of the server table). */
export const FONT_ROLE_FAMILIES: Readonly<Record<string, { family: string; kind: FontKind }>> = {
    inter: { family: 'Inter', kind: 'sans' },
    satoshi: { family: 'Satoshi', kind: 'sans' },
    'general-sans': { family: 'General Sans', kind: 'sans' },
    cabinet: { family: 'Cabinet Grotesk', kind: 'sans' },
    'clash-display': { family: 'Clash Display', kind: 'sans' },
    'clash-grotesk': { family: 'Clash Grotesk', kind: 'sans' },
    fraunces: { family: 'Fraunces', kind: 'serif' },
    'plex-mono': { family: 'IBM Plex Mono', kind: 'mono' },
    'fira-code': { family: 'Fira Code', kind: 'mono' },
};

const FALLBACK: Record<FontKind, string> = {
    sans: 'system-ui, -apple-system, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

/** The variable each role sets on the root, as [role, variable] pairs. */
const ROLE_VARS: ReadonlyArray<readonly [FontRole, string]> = [['heading', '--app-font-heading'], ['body', '--app-font-body'], ['mono', '--app-font-mono']];

export type FontRoles = Partial<Record<FontRole, string>>;

/** The CSS family name an uploaded font is registered under (AppFontFaces.tsx). */
export function assetFontFamily(assetId: string): string {
    return `app-font-${assetId}`;
}

/** design.fonts as the page may use it: the roles whose value is a known family or an asset reference. */
export function fontRolesOf(design: unknown): FontRoles | null {
    const raw = design && typeof design === 'object' ? (design as { fonts?: unknown }).fonts : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: FontRoles = {};
    for (const role of FONT_ROLES) {
        const value = (raw as Record<string, unknown>)[role];
        if (typeof value !== 'string') continue;
        if (Object.hasOwn(FONT_ROLE_FAMILIES, value) || assetIdOf(value)) out[role] = value;
    }
    return Object.keys(out).length ? out : null;
}

/** The font stack of one role's value, or null for a value the page does not know. */
export function fontStack(value: string, role: FontRole): string | null {
    const known = Object.hasOwn(FONT_ROLE_FAMILIES, value) ? FONT_ROLE_FAMILIES[value] : null;
    if (known) return `'${known.family}', ${FALLBACK[known.kind]}`;
    const id = assetIdOf(value);
    return id ? `'${assetFontFamily(id)}', ${FALLBACK[role === 'mono' ? 'mono' : 'sans']}` : null;
}

/** The ids of the uploaded fonts the roles name, once each. */
export function fontAssetIds(roles: FontRoles | null): string[] {
    const ids = new Set<string>();
    for (const role of FONT_ROLES) {
        const id = roles?.[role] ? assetIdOf(roles[role]) : null;
        if (id) ids.add(id);
    }
    return [...ids];
}

/**
 * The root's share of the roles: classes and style (CSS variables, and the body font as the
 * root's font-family). Empty for a design without roles.
 */
export function fontRoleProps(design: unknown): { classes: string[]; style: CSSProperties } {
    const roles = fontRolesOf(design);
    const classes: string[] = [];
    const style: Record<string, string> = {};
    if (!roles) return { classes, style };
    for (const [role, variable] of ROLE_VARS) {
        const stack = roles[role] ? fontStack(roles[role], role) : null;
        if (!stack) continue;
        style[variable] = stack;
        if (role === 'body') style.fontFamily = stack;
        else classes.push(`app-fonts--${role}`);
    }
    return { classes, style: style as CSSProperties };
}

/**
 * What the text knob `font` writes on a cell of an app WITH font roles (styleKnobs/text.ts): the
 * role's variable, with today's value as its fallback. null when the app has no roles: the knob
 * then keeps the values it has always written.
 */
export function fontKnobFamily(knob: string, design: unknown): string | null {
    const roles = fontRolesOf(design);
    if (!roles) return null;
    if (knob === 'heading') return roles.heading ? 'var(--app-font-heading)' : 'inherit';
    if (knob === 'mono') return roles.mono ? 'var(--app-font-mono)' : FALLBACK.mono;
    if (knob === 'body') return roles.body ? 'var(--app-font-body)' : 'inherit';
    return null;
}
